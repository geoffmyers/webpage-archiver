# CLAUDE.md - Webpage Archiver Chrome Extension

## Project Overview

A Chrome extension (Manifest V3) that archives webpages in several formats — single-file HTML, clean Markdown, full-page PNG screenshot, and PDF — all in one click. Uses Readability for content extraction, Turndown for Markdown conversion, `chrome.tabs.captureVisibleTab` (stitched across scroll positions) for screenshots, and jsPDF for PDF generation.

## Architecture / Key Files

```
manifest.json                    - Extension manifest (MV3); permissions, service worker, popup, options
package.json                     - Dependencies (vendored libraries)
build.js                         - Copies vendor libs from node_modules to vendor/
vendor/                          - Bundled vendor libraries (built from node_modules)
  Readability.js                 - Mozilla Readability (@mozilla/readability)
  jspdf.umd.min.js               - PDF generation (jsPDF)
  turndown.umd.js                - HTML-to-Markdown (turndown)
  turndown-plugin-gfm.js         - GitHub Flavored Markdown tables (turndown-plugin-gfm)
src/
  popup/
    popup.html                   - Extension popup UI (format selection, archive button)
    popup.js                     - Popup logic (triggers capture, shows progress/results)
    popup.css                    - Popup styling
  background/
    service-worker.js            - Orchestrates capture: injects scripts, manages downloads, offscreen doc
  content/
    content-script.js            - Injected into page; orchestrates capture, Markdown from DOM
    html-sanitizer.js            - Injected alongside content-script.js; builds the sanitized single-file HTML archive (no chrome.* calls, so tests can load it directly)
  offscreen/
    offscreen.html               - Offscreen document for PDF generation (MV3 requirement)
    offscreen.js                 - jsPDF rendering (receives screenshot, outputs PDF data URL)
  options/
    options.html                 - Settings page (default formats, filename pattern, subfolder)
    options.js                   - Settings persistence via chrome.storage.sync
assets/icons/                    - Extension icons (16, 32, 48, 128px), rendered from docs/icon.svg; don't edit by hand
```

### Capture Flow

1. User clicks popup → selects formats → clicks "Archive"
2. `popup.js` sends `{ type: 'archive', formats }` to service worker
3. `service-worker.js` injects vendor libs + `content-script.js` into active tab
4. `content-script.js` and `html-sanitizer.js` capture:
   - **HTML**: `html-sanitizer.js` clones the DOM, inlines stylesheets/images, strips scripts/event handlers/dangerous URLs/iframes/embeds/meta-refresh, adds its own base href and a restrictive CSP
   - **Markdown**: Readability extracts article → Turndown converts to Markdown with YAML frontmatter
   - **PNG**: `service-worker.js` scrolls the tab and calls `chrome.tabs.captureVisibleTab` per viewport, stitched in the offscreen document
5. For **PDF**: service worker opens offscreen document → jsPDF converts screenshot to multi-page PDF
6. All files downloaded via `chrome.downloads` API with configurable naming pattern

### Data Flow

```
popup.js → (message) → service-worker.js → (scripting.executeScript) → content-script.js
                ↕                                                            ↓
         offscreen.js ←──────── (message) ──────────── captured data ────────┘
                ↓
         chrome.downloads API → files saved
```

## Development Commands

```bash
# Install dependencies and build vendor libs
npm install && npm run build

# Load in Chrome:
# 1. Navigate to chrome://extensions/
# 2. Enable Developer Mode
# 3. Click "Load unpacked" and select this directory

# Rebuild vendor libs after dependency updates
npm run build
```

## Common Tasks

- **Add a new output format**: Add capture logic in `content-script.js`, processing in `service-worker.js`, checkbox in `popup.html`/`options.html`
- **Change filename pattern**: Edit the `buildFilename()` function in `service-worker.js` or change defaults in `options.js`
- **Improve screenshot fidelity**: Adjust `captureFullPageScreenshot()` in `service-worker.js` (scroll delay, retry backoff) or the stitch logic in `offscreen.js`
- **Improve Markdown quality**: Customize `TurndownService` rules in `content-script.js` `createTurndownService()`
- **Change PDF layout**: Edit `generatePdf()` in `offscreen.js` (page size, margins, multi-page logic)

## Gotchas

- **Readability returns null** on non-article pages (dashboards, SPAs, social feeds). The extension falls back to converting the full body HTML to Markdown.
- **The stitched screenshot canvas is capped at 32000px height** (`offscreen.js` `stitch-init`). A page taller than that (after scaling by `devicePixelRatio`) gets a truncated PNG/PDF; `service-worker.js` detects this and appends a note to the result label so it isn't silent.
- **`html-sanitizer.js` has no `chrome.*` dependency on purpose** — it's injected into the page alongside `content-script.js` (same isolated world, so `serializeHtml()` is a shared global), and the Playwright suite also loads it directly into a plain page to exercise the real function instead of a reimplementation.
- **Cross-origin images** cannot be inlined as data URIs in the HTML archive. They keep their original `src` URLs.
- **Offscreen document** is required by MV3 for jsPDF since service workers can't access DOM APIs. The offscreen doc is created on-demand and reused.
- **AGPL-3.0 note**: The original plan called for `single-file-core` (AGPL-3.0) but this implementation uses a custom HTML serializer instead, avoiding the AGPL dependency.
- **vendor/ directory** contains built files from `npm run build`. Run this after `npm install` or dependency updates.
- Requires Chrome 109+ (Manifest V3 with offscreen document support)
- This project is developed in a private repository and published to
  GitHub (`geoffmyers/webpage-archiver`) as a snapshot: each publish adds one commit.
  Pull requests are applied upstream first; see CONTRIBUTING.md.
