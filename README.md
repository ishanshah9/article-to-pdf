# Article to PDF

A Chrome extension (Manifest V3, vanilla JS, no build step) that extracts the readable article from any web page and saves it as a clean PDF.

## How it works

1. **popup.js** injects Mozilla's Readability (`lib/Readability.js`) into the page and extracts the article. It also snapshots computed styles (colours, borders, backgrounds) and, when Readability drops part of the content, recovers it from the page's content container.
2. **background.js** stores the result in `chrome.storage.session` and opens `reader.html`.
3. **reader.js / reader.css** render a print-ready layout. The PDF comes from the print dialog, or, with auto-save on, silently from `Page.printToPDF` via `chrome.debugger`.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open an article, click the extension icon, then **Save as PDF**.

## Settings

Click the gear in the popup: auto-save toggle, download sub-folder, and left/right page margin.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Credits

Uses [Readability.js](https://github.com/mozilla/readability) (Apache-2.0).
