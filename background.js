// background.js — MV3 service worker
//
// A service worker is NOT a persistent background page. Chrome can terminate it
// at any time when idle and restart it for the next event. This means:
//   • No module-level state — it won't survive between events.
//   • Use chrome.storage.session for data that must outlive a single event.
//   • Keep message handlers synchronous-looking: register them at the top level
//     so Chrome can reattach them after a restart.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Article to PDF] Extension installed / updated.');
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_AS_PDF') {
    // CRITICAL: return `true` before doing any async work.
    // Chrome closes the message channel as soon as the listener returns.
    // Returning `true` signals "I'll call sendResponse later".
    handleSaveAsPdf(message)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'READER_READY') {
    // reader.js signals that the article is rendered and images are loaded.
    // sender.tab.id is the reader tab — we attach the debugger to it.
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'Could not determine reader tab ID.' });
      return;
    }
    handleReaderReady(tabId, message)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err   => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// SAVE_AS_PDF handler — store article, open reader tab
// ---------------------------------------------------------------------------
async function handleSaveAsPdf({ article, autoSave, saveFolder, marginLR }) {
  // Generate a unique key for session storage.
  // URL params can't carry large HTML payloads safely.
  const key = `article_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Stash the article payload + mode settings so reader.js can read them.
  await chrome.storage.session.set({
    [key]: {
      ...article,
      autoSave:   autoSave  || false,
      saveFolder: saveFolder || 'Articles',
      marginLR:   typeof marginLR === 'number' ? marginLR : 0.5,
    },
  });

  // Open the reader tab. When auto-saving we open it in the background
  // (active: false) so the user's current tab stays focused — they just
  // wait for the "Done" confirmation in the popup.
  await chrome.tabs.create({
    url:    chrome.runtime.getURL(`reader.html?id=${key}`),
    active: !autoSave,
  });

  return { key };
}

// ---------------------------------------------------------------------------
// READER_READY handler — generate PDF via Chrome DevTools Protocol
// ---------------------------------------------------------------------------
async function handleReaderReady(tabId, { title, folder, marginLR }) {
  // chrome.debugger lets an extension attach to a tab and issue CDP commands.
  // Page.printToPDF generates the same output as "Save as PDF" in the print
  // dialog — it applies all @media print CSS exactly as authored.
  //
  // Side-effect: Chrome shows a yellow infobar ("Article to PDF started
  // debugging this browser") in the reader tab while the debugger is attached.
  // It disappears automatically when we detach, usually within 2–3 seconds.
  await chrome.debugger.attach({ tabId }, '1.3');

  try {
    const { data } = await chrome.debugger.sendCommand(
      { tabId },
      'Page.printToPDF',
      {
        printBackground:   true,   // honour background-color / background-image
        paperWidth:        8.5,    // inches — US Letter
        paperHeight:       11,
        marginTop:         1.25,   // matches @page margin in reader.css
        marginBottom:      1.25,
        marginLeft:        typeof marginLR === 'number' ? marginLR : 0.5,
        marginRight:       typeof marginLR === 'number' ? marginLR : 0.5,
        preferCSSPageSize: false,  // use the values above, not @page{size}
        generateTaggedPDF: false,
      }
    );

    // `data` is a base64-encoded PDF string.
    // URL.createObjectURL is unavailable in MV3 service workers (no DOM APIs),
    // so we pass a data: URL directly — chrome.downloads accepts it natively.
    const dataUrl = `data:application/pdf;base64,${data}`;

    // Build the download path.
    // chrome.downloads always roots filenames inside the user's Downloads
    // directory — "Articles/foo.pdf" → ~/Downloads/Articles/foo.pdf.
    const safeTitle = (title || 'Article')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    const safeFolder = (folder || 'Articles').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
    const filename   = `${safeFolder}/${safeTitle}.pdf`;

    // saveAs: false → no dialog, file goes straight to Downloads/folder/.
    // Chrome creates the subfolder automatically if it doesn't exist.
    const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

    return { filename, downloadId };

  } finally {
    // Always detach the debugger — even on error — or the infobar stays forever.
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

