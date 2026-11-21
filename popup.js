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
// extractArticle()
//
// This function is SERIALIZED and run inside the page, not in popup.js.
// That means: no closures, no imports, no references to outer-scope variables.
// Everything it needs must be defined inside itself.
//
// It is declared async so we can await the scroll loop.
// ---------------------------------------------------------------------------
async function extractArticle() {

  // --- 1. Scroll top-to-bottom to trigger lazy-loaded images ---------------
  //
  // Many sites (Medium, Substack, news sites) use Intersection Observer to
  // load images only when they scroll into view. By programmatically scrolling
  // the page, we fire those observer callbacks before Readability ever sees the
  // DOM. Without this step, img elements would have empty src and blank in PDF.
  async function triggerLazyLoad() {
    // Use the larger of body / documentElement scroll heights — some sites
    // (especially SPAs) set overflow on <html> rather than <body>, so
    // document.body.scrollHeight can be artificially small.
    const totalHeight = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    );
    const step     = 500; // px per increment — small enough to catch most observers
    const MAX_STEPS = 100; // cap at 50,000 px (≈ 50 screen-heights) so long pages
                           // like Wikipedia don't take 15+ seconds to scroll
    let steps = 0;
    for (let y = 0; y < totalHeight && steps < MAX_STEPS; y += step, steps++) {
      window.scrollTo(0, y);
      // A short pause lets the browser fire pending observer callbacks.
      await new Promise(r => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300)); // settle before DOM snapshot
  }

  await triggerLazyLoad();

  // --- 2. Extract images hidden inside <noscript> tags ---------------------
  //
  // Many lazy-loaders (WordPress plugins, custom loaders) use this pattern:
  //   <img class="lazy" data-src="real.jpg" src="1px-placeholder.gif">
  //   <noscript><img src="real.jpg"></noscript>
  //
  // If our scroll didn't trigger their JS swapper, the live <img> still holds
  // a blank placeholder. The <noscript> sibling always has the real URL.
  // We copy it across before cloning, so Readability captures the real image.
  document.querySelectorAll('noscript').forEach(noscript => {
    const tmp = document.createElement('div');
    tmp.innerHTML = noscript.textContent;       // parse noscript's raw HTML text
    const nsImg = tmp.querySelector('img[src]');
    if (!nsImg) return;

    // The noscript is almost always a direct sibling of the placeholder <img>
    const prev = noscript.previousElementSibling;
    if (prev?.tagName === 'IMG') {
      const existingSrc = prev.getAttribute('src') || '';
      // Only override if the current src looks like a placeholder (data URI,
      // 1px GIF, empty, or an image that failed to load)
      if (!existingSrc || existingSrc.startsWith('data:') || prev.naturalWidth <= 1) {
        prev.src = nsImg.getAttribute('src');
        const ns = nsImg.getAttribute('srcset');
        if (ns) prev.srcset = ns;
      }
    }
  });

  // --- 3. Rewrite lazy-load placeholder attributes onto src ----------------
  //
  // Even after scrolling, some sites keep the real URL in a data-* attribute
  // and only swap it via JS. We force-copy those to src so Readability captures
  // the real image URL in the cloned DOM.
  //
  // Coverage: data-src (most common), data-lazy-src (WP Rocket, b-lazy),
  // data-original (Lazy Load XT), data-lazy (Simple LazyLoad),
  // data-echo (Echo.js), data-img-src / data-delayed-url (misc loaders).
  const LAZY_ATTRS   = ['data-src', 'data-lazy-src', 'data-original',
                        'data-lazy', 'data-echo', 'data-img-src', 'data-delayed-url'];
  const LAZY_SRCSET  = ['data-srcset', 'data-lazy-srcset'];

  document.querySelectorAll('img').forEach(img => {
    for (const attr of LAZY_ATTRS) {
      const val = img.getAttribute(attr);
      if (val?.trim()) { img.src = val; break; }
    }
    for (const attr of LAZY_SRCSET) {
      const val = img.getAttribute(attr);
      if (val?.trim()) { img.srcset = val; break; }
    }
  });

  // <picture><source> elements carry their own srcset and can have lazy attrs.
  // Browsers pick the best source from these; Readability preserves the whole
  // <picture> block, so we need the srcsets to be real and absolute.
  document.querySelectorAll('picture source').forEach(source => {
    for (const attr of LAZY_SRCSET) {
      const val = source.getAttribute(attr);
      if (val?.trim()) { source.srcset = val; break; }
    }
  });

  // --- 4. Absolutize URLs in the live DOM ----------------------------------
  //
  // reader.html is served from a chrome-extension:// origin, so any relative
  // URL like "/images/photo.jpg" would resolve against the extension's origin
  // and 404. We convert them to absolute URLs now, before cloning.
  const baseUrl = document.location.href;

  function absolutize(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
    try { return new URL(url, baseUrl).href; } catch (_) { return url; }
  }

  // Reusable srcset parser — handles "url 2x, url2 1200w" descriptors.
  function absolutizeSrcset(srcset) {
    return srcset.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [absolutize(u), ...rest].filter(Boolean).join(' ');
    }).join(', ');
  }

  document.querySelectorAll('img').forEach(img => {
    if (img.src)    img.src    = absolutize(img.src);
    if (img.srcset) img.srcset = absolutizeSrcset(img.srcset);
  });

  // Absolutize <source srcset> inside <picture> blocks.
  document.querySelectorAll('picture source[srcset]').forEach(source => {
    source.srcset = absolutizeSrcset(source.srcset);
  });

  // --- 5. Snapshot computed styles + visibility as data-* attributes --------
  //
  // Readability strips every `style` attribute, and reader.html doesn't load
  // the original site's stylesheets, so anything styled by CSS classes or ids
  // (coloured callout boxes, bordered case-study panels, pink "solution"
  // backgrounds, syntax highlighting) would be lost. data-* attributes survive
  // Readability, so we record the look of every element here and convert it
  // back to inline styles in step 9a.
  //
  //   data-pdf-style   → "color:…;background-color:…;border-top:…;padding:…"
  //                      (colour only when it differs from the parent's, so
  //                      children inherit instead of being pinned to a value)
  //   data-pdf-hidden  → element isn't rendered (display:none, collapsed
  //                      ancestor…); removed from the output in step 9a and
  //                      ignored by the title picker.
  //
  // Reads are batched before writes to avoid interleaved layout reflows.
  const NO_STYLE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
                                 'SOURCE', 'TRACK', 'PARAM', 'BR', 'WBR']);
  const MAX_STYLED    = 20000;           // safety cap for gigantic pages
  const SIDES         = ['Top', 'Right', 'Bottom', 'Left'];
  const fgOf          = new Map([[document.body, getComputedStyle(document.body).color]]);
  const snapshots     = [];

  const allEls = document.body.querySelectorAll('*');
  for (let i = 0; i < allEls.length && i < MAX_STYLED; i++) {
    const el = allEls[i];
    if (NO_STYLE_TAGS.has(el.tagName)) continue;

    const cs = getComputedStyle(el);
    // display:contents elements have no box of their own but their children do.
    const hidden = cs.display !== 'contents' && el.getClientRects().length === 0;
    if (hidden) { snapshots.push({ el, hidden: true }); continue; }

    const decl = [];
    fgOf.set(el, cs.color);
    if (cs.color !== fgOf.get(el.parentElement)) decl.push(`color:${cs.color}`);

    let hasBox = false;
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      decl.push(`background-color:${cs.backgroundColor}`);
      hasBox = true;
    }
    for (const side of SIDES) {
      const w = parseFloat(cs[`border${side}Width`]);
      if (w > 0 && cs[`border${side}Style`] !== 'none') {
        decl.push(`border-${side.toLowerCase()}:${cs[`border${side}Width`]} ${cs[`border${side}Style`]} ${cs[`border${side}Color`]}`);
        hasBox = true;
      }
    }
    // Padding / radius only matter when there's a visible box to pad.
    if (hasBox) {
      decl.push(`padding:${cs.padding}`);
      if (cs.borderRadius && cs.borderRadius !== '0px') decl.push(`border-radius:${cs.borderRadius}`);
    }
    if (decl.length) snapshots.push({ el, style: decl.join(';') });
  }

  snapshots.forEach(({ el, style, hidden }) => {
    if (hidden) el.setAttribute('data-pdf-hidden', '');
    else        el.setAttribute('data-pdf-style', style);
  });

  // The markers above live on the user's real page — remove them before we
  // return so we leave it exactly as we found it.
  function cleanupLive() {
    document.querySelectorAll('[data-pdf-style], [data-pdf-hidden]').forEach(el => {
      el.removeAttribute('data-pdf-style');
      el.removeAttribute('data-pdf-hidden');
    });
  }

  // --- 6. expandToContentArea() ---------------------------------------------
  //
  // Readability picks ONE top-scoring block and only keeps siblings of that
  // block. On app-like pages (quizzes, dashboards, docs viewers) the real
  // content is split across several branches — e.g. a case study, the question
  // and its A–D options, and the solution — so the losing branches vanish.
  //
  // Recovery: find the paragraphs Readability kept, locate them in the live
  // DOM, and take their smallest common ancestor. If that container holds
  // noticeably more visible text than Readability returned (but not wildly
  // more, which would mean we're dragging in a whole site), use it instead.
  // For ordinary articles the ancestor is the article body itself, the text
  // ratio is ~1, and nothing changes.
  const JUNK_SELECTOR = '[data-pdf-hidden], script, style, noscript, template, ' +
                        'select, button, input, textarea, svg';

  function expandToContentArea(article) {
    const norm   = s => s.replace(/\s+/g, ' ').trim();
    const probe  = document.createElement('div');
    probe.innerHTML = article.content;

    const wanted = new Set();
    probe.querySelectorAll('p').forEach(p => {
      const t = norm(p.textContent);
      if (t.length >= 40) wanted.add(t.slice(0, 80));
    });
    if (wanted.size < 2) return null;

    const matched = [];
    for (const p of document.body.querySelectorAll('p')) {
      if (p.closest('[data-pdf-hidden]')) continue;
      const key = norm(p.textContent).slice(0, 80);
      if (wanted.delete(key)) matched.push(p);
    }
    if (matched.length < 2) return null;

    let lca = matched[0].parentElement;
    while (lca && !matched.every(p => lca.contains(p))) lca = lca.parentElement;
    if (!lca || lca === document.body || lca === document.documentElement) return null;

    const clone = lca.cloneNode(true);
    clone.querySelectorAll(JUNK_SELECTOR).forEach(n => n.remove());

    const ratio = norm(clone.textContent).length / Math.max(article.length, 1);
    if (ratio < 1.1 || ratio > 3) return null;   // nothing missing, or too much page

    return clone.outerHTML;
  }

  // --- 7. Clone + Readability ----------------------------------------------
  //
  // Readability mutates the document it receives, so we must clone first.
  // The clone captures the post-scroll, post-absolutize DOM state.
  const docClone = document.cloneNode(true);
  let article    = null;
  let usedFallback = null;

  try {
    // Readability is available as a global because popup.js injected the
    // lib/Readability.js file into this page's context just before this function.
    article = new Readability(docClone).parse();
  } catch (e) {
    console.warn('[Article to PDF] Readability threw:', e);
  }

  // --- 8. Fallback chain if Readability returns null -----------------------
  //
  // Some pages (SPAs, paywalled content, unusual DOM structure) confuse
  // Readability. We fall back progressively to semantic containers, then to
  // the largest block of text on the page.
  if (!article) {
    const candidates = [
      { selector: 'article', label: '<article>' },
      { selector: 'main',    label: '<main>'    },
    ];

    for (const { selector, label } of candidates) {
      const el = document.querySelector(selector);
      if (el && el.innerText.trim().length > 200) {
        article = {
          title:       document.title,
          byline:      null,
          siteName:    null,
          content:     el.innerHTML,
          textContent: el.innerText,
          length:      el.innerText.length,
        };
        usedFallback = label;
        break;
      }
    }

    // Last resort: largest <div> by text length
    if (!article) {
      let best = null, bestLen = 0;
      document.querySelectorAll('div').forEach(div => {
        const len = div.innerText.trim().length;
        if (len > bestLen) { bestLen = len; best = div; }
      });
      if (best) {
        article = {
          title:       document.title,
          byline:      null,
          siteName:    null,
          content:     best.innerHTML,
          textContent: best.innerText,
          length:      bestLen,
        };
        usedFallback = 'largest <div>';
      }
    }
  }

  if (!article) { cleanupLive(); return null; }

  // --- 8b. Recover content Readability dropped (see expandToContentArea)
  if (!usedFallback) {
    const expanded = expandToContentArea(article);
    if (expanded) { article.content = expanded; usedFallback = 'expanded content area'; }
  }

  // --- 9. Post-process the extracted HTML ----------------------------------
  //
  // Readability re-serialises the cloned DOM into HTML — some relative paths
  // can slip through. We also clean up elements that don't belong in a PDF.
  const tmp = document.createElement('div');
  tmp.innerHTML = article.content;

  // 9a. Drop hidden/junk nodes, then restore the styles snapshotted in step 5.
  //
  // data-pdf-style survived Readability (it only strips "style"); turn it back
  // into a real inline style. Merge with any existing inline style so we never
  // clobber something Readability kept.
  tmp.querySelectorAll(JUNK_SELECTOR).forEach(n => n.remove());
  tmp.querySelectorAll('[data-pdf-style]').forEach(el => {
    el.setAttribute('style', el.getAttribute('data-pdf-style') + ';' + (el.getAttribute('style') || ''));
    el.removeAttribute('data-pdf-style');
  });

  // 9b. Re-absolutize <img> src and srcset (belt-and-suspenders pass).
  tmp.querySelectorAll('img').forEach(img => {
    if (img.getAttribute('src'))    img.src    = absolutize(img.getAttribute('src'));
    if (img.getAttribute('srcset')) img.srcset = absolutizeSrcset(img.getAttribute('srcset'));
  });

  // 9c. Absolutize <source srcset> inside <picture> blocks in the output.
  tmp.querySelectorAll('picture source[srcset]').forEach(source => {
    source.srcset = absolutizeSrcset(source.getAttribute('srcset'));
  });

  // 9d. Absolutize <a href> so links work when clicked inside reader.html.
  // Without this, relative links like "/2024/article" resolve against
  // chrome-extension:// and 404. We skip anchor-only (#section) links.
  tmp.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && !href.startsWith('#')) {
      try { a.href = new URL(href, baseUrl).href; } catch (_) {}
    }
  });

  // 9e. Replace <iframe> embeds with a text placeholder.
  // Readability preserves iframes it considers content (YouTube, Twitter, etc.)
  // but chrome-extension:// pages can't load most third-party iframes — they
  // render as blank white rectangles and print as empty space in the PDF.
  // We swap each one for a labelled link so the reader knows what was there.
  tmp.querySelectorAll('iframe').forEach(iframe => {
    const src   = iframe.getAttribute('src') || iframe.getAttribute('data-src') || '';
    const title = iframe.getAttribute('title') || iframe.getAttribute('aria-label') || '';
    const label = title || src || 'Embedded content';

    const placeholder = document.createElement('div');
    placeholder.className = 'embed-placeholder';

    if (src) {
      const link = document.createElement('a');
      link.href        = absolutize(src);
      link.textContent = `[ ${label} ]`;
      link.target      = '_blank';
      link.rel         = 'noreferrer';
      placeholder.appendChild(link);
    } else {
      placeholder.textContent = `[ ${label} ]`;
    }

    iframe.replaceWith(placeholder);
  });

  article.content = tmp.innerHTML;

  // --- 10. Extract the best available title --------------------------------
  //
  // Readability derives its title from the <title> tag using separator
  // heuristics (" | ", " - ", " :: ") to strip site names — but it often
  // gets it wrong (strips too much, or keeps the brand name).
  //
  // Instead we read directly from the DOM in priority order:
  //   1. <h1> inside a semantic article container — the visual headline
  //   2. og:title meta — publisher-set sharing title, usually clean
  //   3. JSON-LD "headline" — structured data that CMS tools set explicitly
  //   4. Any <h1> on the page — still better than the <title> tag
  //   5. Readability's cleaned title — last resort
  function getBestTitle() {
    // 1. Headline <h1> inside the article/main container
    // Only consider h1s that are actually rendered — SPAs keep hidden "cards"
    // (dashboards, other tabs) in the DOM with their own h1s.
    const isShown = el => !el.closest('[data-pdf-hidden]');
    const articleH1 = [...document.querySelectorAll(
      'article h1, [role="article"] h1, main h1, .post h1, .entry h1'
    )].find(h => isShown(h) && h.innerText?.trim());
    if (articleH1) return articleH1.innerText.trim();

    // 2. OpenGraph title (set by publishers for social sharing)
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content?.trim()) return og.content.trim();

    // 3. JSON-LD "headline" — try every ld+json block on the page
    try {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        const data  = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.headline?.trim()) return item.headline.trim();
        }
      }
    } catch (_) {}

    // 4. First <h1> anywhere
    const h1 = [...document.querySelectorAll('h1')]
      .find(h => isShown(h) && h.innerText?.trim());
    if (h1) return h1.innerText.trim();

    // 5. Readability's result (already cleaned from the <title> tag)
    return article.title;
  }

  const bestTitle = getBestTitle();
  cleanupLive();

  return {
    title:       bestTitle,
    byline:      article.byline    || null,
    siteName:    article.siteName  || null,
    content:     article.content,
    textContent: article.textContent,
    length:      article.length,
    usedFallback,          // null → Readability worked; string → which fallback
    sourceUrl:   baseUrl,
  };
}

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
