# Architecture

A Manifest V3 Chrome extension. All capture happens in the page and the
extension's own context; nothing is sent to a server.

## Layout

| Path | What lives there |
|---|---|
| `manifest.json` | MV3 manifest — permissions, service worker, action. |
| `src/` | `background/` (service worker), `content/` (page capture), `offscreen/` (DOM work the worker cannot do), `options/` and `popup/`. |
| `vendor/` | Bundled third-party libraries, committed so the extension loads unpacked with no build step. |
| `assets/` | Icons. |
| `tests/` | Unit tests for the conversion helpers. |

## How a capture works

1. A content script reads the live DOM (after scripts have run, so dynamic pages
   capture as seen). A separate, chrome-API-free module sanitizes and
   serializes the single-file HTML archive so it stays inert if ever opened
   from disk.
2. **Readability** extracts the article body for the text formats.
3. **Turndown** converts HTML to Markdown; the browser's own
   `captureVisibleTab` (stitched across scroll positions in the offscreen
   document) plus **jsPDF** render the visual formats; **JSZip** packs
   multi-file output.
4. The result is handed to the downloads API.

## Notes

- An **offscreen document** is used because a Manifest V3 service worker has no DOM, and rendering to canvas for the visual formats needs one.

- Vendored dependencies are deliberate: an unpacked MV3 extension cannot run a
  bundler at load time.
- Capture fidelity is bounded by what the page exposes — cross-origin iframes and
  canvas-tainting resources are documented limitations, not bugs.
