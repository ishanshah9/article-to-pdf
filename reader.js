// reader.js — renders article from chrome.storage.session, then triggers print.
//
// Flow: reader.html?id=KEY  →  read KEY from session storage  →  render  →  print
//
// This file runs in a chrome-extension:// page, which has full access to
// chrome.* APIs (unlike content scripts, which have a limited subset).

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strips filesystem-unsafe characters from a string and trims it to
 * a safe length. Chrome uses document.title as the default filename
 * in the "Save as PDF" dialog, so this directly controls what users see.
 */
function sanitizeFilename(title) {
  return (title || 'Article')
    .replace(/[/\\:*?"<>|]/g, '')   // chars banned in Windows/Mac filenames
    .replace(/\s+/g, ' ')            // collapse multiple spaces / newlines
    .trim()
    .slice(0, 120);                  // keep filenames manageable
}

/**
 * Waits for every <img> inside `container` to finish loading (or times out).
 *
 * img.decode() returns a Promise that resolves once the browser has decoded
 * the image and it's ready to paint. We race it against a 5-second timeout
 * so a single broken image can't stall the whole print job.
 *
 * Without this wait, window.print() fires before images are fetched and
 * the PDF comes out with blank rectangles instead of photos.
 *
 * onProgress(loaded, total) is called after each image settles so the
 * loading banner can show a count rather than a static spinner.
 */
async function waitForImages(container, onProgress) {
  const TIMEOUT_MS = 5000;
  const imgs = Array.from(container.querySelectorAll('img'));
  const total = imgs.length;
  let loaded = 0;

  if (total === 0) return; // nothing to wait for

  await Promise.all(
    imgs.map(img => {
      // Already loaded and decoded — count it immediately.
      if (img.complete && img.naturalWidth > 0) {
        loaded++;
        onProgress?.(loaded, total);
        return Promise.resolve();
      }

      return Promise.race([
        img.decode().catch(() => {}),    // .catch so a 404 doesn't reject Promise.all
        new Promise(r => setTimeout(r, TIMEOUT_MS)),
      ]).then(() => {
        loaded++;
        onProgress?.(loaded, total);
      });
    })
  );
}

/**
 * Safely appends a text node to an element, preceded by a separator if the
 * element already has children. Used to build the metadata line.
 */
function appendMeta(container, node) {
  if (container.childNodes.length > 0) {
    container.appendChild(document.createTextNode(' · '));
  }
  container.appendChild(node);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function init() {
  const loadingEl     = document.getElementById('loading');
  const loadingTextEl = document.getElementById('loading-text');
  const printBarEl    = document.getElementById('print-bar');

  // --- 1. Parse the article key from the URL -------------------------------
  //
  // background.js opened this tab as:  reader.html?id=article_<timestamp>_<rand>
  // URLSearchParams gives us the key without any manual string splitting.
  const params = new URLSearchParams(location.search);
  const key    = params.get('id');

  if (!key) {
    loadingEl.style.display = 'none';
    document.title = 'Error';
    document.body.innerHTML = '<p style="font-family:sans-serif;color:red;">Error: missing article ID in URL.</p>';
    return;
  }

  // --- 2. Fetch article + settings from session storage --------------------
  //
  // chrome.storage.session is scoped to the browser session (cleared on quit)
  // and shared between all extension contexts — popup, background, reader pages.
  // background.js wrote the article + autoSave/saveFolder settings here.
  const stored  = await chrome.storage.session.get(key);
  const article = stored[key];

  if (!article) {
    loadingEl.style.display = 'none';
    document.title = 'Error';
    document.body.innerHTML = '<p style="font-family:sans-serif;color:red;">Error: article data not found. Close this tab and try again.</p>';
    return;
  }

  // --- 3. Set document.title (= default PDF filename) ----------------------
  document.title = sanitizeFilename(article.title);

  // --- 3b. Inject dynamic @page margin -------------------------------------
  //
  // The margin stored in session comes from the user's Settings. We inject a
  // <style> here so it overrides the static value in reader.css for BOTH the
  // manual print dialog and the auto-save CDP path (which reads it from the
  // READER_READY message below).
  const marginLR = typeof article.marginLR === 'number' ? article.marginLR : 0.5;
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@page { margin: 1.25in ${marginLR}in; }`;
  document.head.appendChild(pageStyle);

  // --- 4. Render title ------------------------------------------------------
  document.getElementById('article-title').textContent = article.title || 'Untitled';

  // --- 5. Render metadata block --------------------------------------------
  //
  // We build each piece as a DOM node (not innerHTML) so user-provided strings
  // — byline, siteName, sourceUrl — are never interpreted as HTML.
  const metaEl = document.getElementById('article-meta');

  if (article.byline?.trim()) {
    const span = document.createElement('span');
    span.textContent = article.byline.trim();
    appendMeta(metaEl, span);
  }

  if (article.siteName?.trim()) {
    const span = document.createElement('span');
    span.textContent = article.siteName.trim();
    appendMeta(metaEl, span);
  }

  if (article.sourceUrl) {
    const a  = document.createElement('a');
    a.href        = article.sourceUrl;
    a.textContent = article.sourceUrl;
    a.target      = '_blank';
    a.rel         = 'noreferrer';
    appendMeta(metaEl, a);
  }

  // Extraction date — "April 25, 2026" style
  const dateSpan = document.createElement('span');
  dateSpan.textContent = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
  appendMeta(metaEl, dateSpan);

  // --- 6. Show fallback notice if Readability couldn't parse ---------------
  if (article.usedFallback) {
    const notice = document.getElementById('fallback-notice');
    notice.style.display = 'block';
    notice.textContent   = `Note: article extraction used fallback (${article.usedFallback}) — content may include non-article elements.`;
  }

  // --- 7. Render article HTML ----------------------------------------------
  //
  // article.content is HTML produced by Readability — scripts, iframes, and
  // other active content have already been stripped by Readability itself.
  // Images have been absolutized in popup.js so they load from the original
  // domain, not chrome-extension://.
  const contentEl = document.getElementById('article-content');
  contentEl.innerHTML = article.content;

  // Force every image to load eagerly.
  // Readability can preserve loading="lazy" attributes from the original page.
  // In reader.html there is no scroll event to push off-screen images into the
  // viewport, so Chrome never fetches them — the last (or any below-fold) image
  // just times out and prints blank. Setting loading="eager" tells Chrome to
  // fetch all images immediately regardless of their position on the page.
  contentEl.querySelectorAll('img').forEach(img => {
    img.loading = 'eager';
  });

  // --- 8. Wait for images, updating the loading banner as each one settles --
  //
  // The loading banner starts with "Loading images…" and counts up as each
  // image finishes. If an article has no images, this step completes instantly.
  const imgCount = contentEl.querySelectorAll('img').length;

  if (imgCount === 0) {
    loadingTextEl.textContent = 'Preparing…';
  }

  await waitForImages(contentEl, (loaded, total) => {
    loadingTextEl.textContent = `Loading images… ${loaded} / ${total}`;
  });

  // --- 9. Branch: auto-save (via background/CDP) or manual print dialog ----
  loadingEl.style.display = 'none';

  const autoSave   = article.autoSave   || false;
  const saveFolder = article.saveFolder || 'Articles';

  if (autoSave) {
    // ── Auto-save path ────────────────────────────────────────────────────
    // Tell the background service worker we're ready. It will:
    //   1. Attach the Chrome debugger to THIS tab
    //   2. Call Page.printToPDF (applies @media print CSS exactly)
    //   3. Save the resulting PDF to Downloads/<saveFolder>/
    //   4. Detach the debugger
    //
    // chrome.tabs.getCurrent() gives us our own tab ID to include in the
    // message. The background also reads sender.tab.id, but being explicit
    // avoids any edge-case where sender isn't populated.
    loadingTextEl.textContent   = 'Generating PDF…';
    loadingEl.style.display      = 'block';

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type:     'READER_READY',
        title:    document.title,   // sanitized filename set in step 3
        folder:   saveFolder,
        marginLR,                   // pass to background so CDP uses the same value
      });
    } catch (e) {
      response = { ok: false, error: e.message };
    }

    loadingEl.style.display = 'none';

    if (response?.ok) {
      const savedPath = response.filename || `${saveFolder}/${document.title}.pdf`;
      // Show a permanent success notice in the tab.
      const notice = document.createElement('div');
      notice.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0',
        'background:#1e8e3e', 'color:#fff',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:13px', 'padding:10px 16px', 'text-align:center', 'z-index:9999',
      ].join(';');
      notice.textContent = `Saved to Downloads/${savedPath}`;
      document.body.appendChild(notice);
    } else {
      const errMsg = response?.error || 'Unknown error during PDF generation.';
      const notice = document.createElement('div');
      notice.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0',
        'background:#c5221f', 'color:#fff',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'font-size:13px', 'padding:10px 16px', 'text-align:center', 'z-index:9999',
      ].join(';');
      notice.textContent = `Auto-save failed: ${errMsg} — use Print dialog instead.`;
      document.body.appendChild(notice);

      // Fall back to the print dialog so the user doesn't lose their PDF.
      window.print();
    }

    // Show the print-again bar in case the user wants a manual copy too.
    printBarEl.style.display = 'block';
    document.getElementById('print-again-btn').addEventListener('click', () => {
      window.print();
    });

  } else {
    // ── Manual print-dialog path (original behaviour) ─────────────────────
    // window.print() opens Chrome's native print dialog. User selects
    // "Save as PDF" as the destination.
    window.print();

    printBarEl.style.display = 'block';
    document.getElementById('print-again-btn').addEventListener('click', () => {
      window.print();
    });
  }

  // --- 10. Clean up session storage ----------------------------------------
  //
  // The article payload can be hundreds of KB. Session storage is bounded, so
  // remove the entry now that we've rendered. Re-printing uses the already-
  // rendered DOM and doesn't need storage.
  await chrome.storage.session.remove(key);
}

// Kick off and surface any unhandled errors visibly.
init().catch(err => {
  console.error('[Article to PDF] Reader error:', err);
  document.title = 'Error';
  document.body.innerHTML = `<p style="font-family:sans-serif;color:red;">Error: ${err.message}</p>`;
});
