// popup.js — Phase 6: extraction + print/auto-save pipeline
//
// The popup runs in its own isolated JS context. To reach the webpage's DOM,
// we use chrome.scripting.executeScript, which injects code into the tab's
// content-script context — a sandboxed environment that CAN read/modify the page.

const btn          = document.getElementById('save-btn');
const status       = document.getElementById('status');
const autosaveBadge = document.getElementById('autosave-badge');

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------
const mainView       = document.getElementById('main-view');
const settingsView   = document.getElementById('settings-view');
const settingsBtn    = document.getElementById('settings-btn');
const backBtn        = document.getElementById('back-btn');
const autoSaveToggle = document.getElementById('auto-save-toggle');
const saveFolderInput = document.getElementById('save-folder');
const folderPreview  = document.getElementById('folder-preview');
const settingsSaveBtn = document.getElementById('settings-save-btn');
const settingsStatus = document.getElementById('settings-status');
const marginLrSelect  = document.getElementById('margin-lr');

// Populate margin options: 0.00 → 1.50 in steps of 0.05
for (let v = 0; v <= 1.50 + 0.001; v += 0.05) {
  const rounded = Math.round(v * 100) / 100;   // avoid floating-point drift
  const opt = document.createElement('option');
  opt.value       = rounded.toFixed(2);
  opt.textContent = `${rounded.toFixed(2)} in`;
  marginLrSelect.appendChild(opt);
}

// Load settings when popup opens and reflect them in the UI.
// chrome.storage.sync keeps settings across devices; .local would be device-only.
async function loadSettings() {
  const { autoSave = false, saveFolder = 'Articles', marginLR = '0.50' } =
    await chrome.storage.sync.get(['autoSave', 'saveFolder', 'marginLR']);

  autoSaveToggle.checked    = autoSave;
  saveFolderInput.value     = saveFolder;
  saveFolderInput.disabled  = !autoSave;
  folderPreview.textContent = saveFolder || 'Articles';
  // Normalise to two decimal places so it matches the generated option values.
  marginLrSelect.value = parseFloat(marginLR).toFixed(2);

  // Show badge on main view so user knows auto-save is active
  autosaveBadge.style.display = autoSave ? 'block' : 'none';
}

loadSettings();

settingsBtn.addEventListener('click', () => {
  mainView.style.display     = 'none';
  settingsView.style.display = 'block';
});

backBtn.addEventListener('click', () => {
  settingsView.style.display = 'none';
  mainView.style.display     = 'block';
  settingsStatus.textContent  = '';
});

// Live-preview the folder name as the user types.
saveFolderInput.addEventListener('input', () => {
  folderPreview.textContent = saveFolderInput.value.trim() || 'Articles';
});

// Enable/disable the folder input based on the toggle.
autoSaveToggle.addEventListener('change', () => {
  saveFolderInput.disabled = !autoSaveToggle.checked;
});

settingsSaveBtn.addEventListener('click', async () => {
  const autoSave   = autoSaveToggle.checked;
  const saveFolder = saveFolderInput.value.trim() || 'Articles';
  const marginLR   = marginLrSelect.value;

  await chrome.storage.sync.set({ autoSave, saveFolder, marginLR });

  // Refresh the badge on the main view.
  autosaveBadge.style.display = autoSave ? 'block' : 'none';

  settingsStatus.textContent = 'Saved!';
  setTimeout(() => { settingsStatus.textContent = ''; }, 1500);
});

// ---------------------------------------------------------------------------
// Button click handler
// ---------------------------------------------------------------------------
btn.addEventListener('click', async () => {
  btn.disabled      = true;
  status.textContent = 'Extracting…';
  status.className   = '';

  try {
    // chrome.tabs.query — asks the browser which tab the user is currently on.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Pre-flight: executeScript only works on http/https pages.
    // On chrome://, file://, or extension pages it throws an opaque permission
    // error, so we catch it here with a readable message instead.
    if (!tab.url?.startsWith('http')) {
      status.textContent = 'Only works on regular web pages (http/https).';
      status.className   = 'error';
      return;
    }

    // Step A: inject Readability.js as a content script so it becomes a global
    // inside the page. executeScript with `files` loads the script file from the
    // extension's own directory into the tab's JS context.
    await chrome.scripting.executeScript({
      target : { tabId: tab.id },
      files  : ['lib/Readability.js'],
    });

    // Step B: inject and run our extraction function.
    // `func` serialises the function and sends it to the page; the return value
    // is transferred back via structured clone (must be JSON-serialisable).
    //
    // Race against a 30-second timeout — without this, a very slow page (or one
    // that takes forever to scroll) leaves the popup stuck on "Extracting…".
    const extractionTimeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Extraction timed out — the page may be too slow or complex.')),
        30_000
      )
    );

    const [{ result: article }] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractArticle }),
      extractionTimeout,
    ]);

    if (!article) {
      status.textContent = 'Could not extract an article from this page.';
      status.className   = 'error';
      return;
    }

    // Keep the console log so you can inspect the raw object in DevTools.
    console.log('[Article to PDF] Extracted article:', article);

    // Warn if extraction returned suspiciously little text — likely a paywall,
    // login gate, or JS-rendered SPA that executeScript couldn't fully see.
    if (article.length < 300 && !article.usedFallback) {
      status.textContent = 'Warning: very little content extracted — page may be paywalled or require login.';
      status.className   = 'error';
      // Don't return — still open the reader so the user can see what we got.
    }

    status.textContent = 'Opening reader…';

    // Read the current settings so background.js knows which mode to use.
    const { autoSave = false, saveFolder = 'Articles', marginLR = '0.5' } =
      await chrome.storage.sync.get(['autoSave', 'saveFolder', 'marginLR']);

    // Send the article to the background service worker.
    // chrome.runtime.sendMessage passes a message to background.js.
    // The background stores the article in session storage and opens reader.html.
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_AS_PDF',
      article,
      autoSave,
      saveFolder,
      marginLR: parseFloat(marginLR),
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Background worker failed.');
    }

    const fallbackNote = article.usedFallback
      ? ` (fallback: ${article.usedFallback})`
      : '';

    status.textContent = autoSave
      ? `Done${fallbackNote} — saving to Downloads/${saveFolder}/`
      : `Done${fallbackNote} — PDF dialog will open in the reader tab.`;

  } catch (err) {
    console.error('[Article to PDF] Error:', err);
    status.textContent = err.message || 'Unexpected error.';
    status.className   = 'error';
  } finally {
    btn.disabled = false;
  }
});
