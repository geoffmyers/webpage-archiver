# CLAUDE.md - Webpage Archiver Chrome Extension

## Project Overview

A Chrome extension (Manifest V3) that archives webpages in four formats — single-file HTML, clean Markdown, full-page PNG screenshot, and PDF — all in one click. Uses Readability for content extraction, Turndown for Markdown conversion, html2canvas for screenshots, and jsPDF for PDF generation.

## Architecture / Key Files

```
manifest.json                    - Extension manifest (MV3); permissions, service worker, popup, options
package.json                     - Dependencies (vendored libraries)
build.js                         - Copies vendor libs from node_modules to vendor/
vendor/                          - Bundled vendor libraries (built from node_modules)
  Readability.js                 - Mozilla Readability (@mozilla/readability)
  html2canvas.min.js             - DOM-to-canvas screenshot (html2canvas)
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
    content-script.js            - Injected into page; captures HTML, PNG, Markdown from DOM
  offscreen/
    offscreen.html               - Offscreen document for PDF generation (MV3 requirement)
    offscreen.js                 - jsPDF rendering (receives screenshot, outputs PDF data URL)
  options/
    options.html                 - Settings page (default formats, filename pattern, subfolder)
    options.js                   - Settings persistence via chrome.storage.sync
assets/icons/                    - Extension icons (16, 32, 48, 128px)
```

### Capture Flow

1. User clicks popup → selects formats → clicks "Archive"
2. `popup.js` sends `{ type: 'archive', formats }` to service worker
3. `service-worker.js` injects vendor libs + `content-script.js` into active tab
4. `content-script.js` captures:
   - **HTML**: Clones DOM, inlines stylesheets/images, removes scripts, adds base href
   - **Markdown**: Readability extracts article → Turndown converts to Markdown with YAML frontmatter
   - **PNG**: html2canvas renders full page to canvas → data URL
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
- **Improve screenshot fidelity**: Adjust `html2canvas` options in `content-script.js` `captureScreenshot()`
- **Improve Markdown quality**: Customize `TurndownService` rules in `content-script.js` `createTurndownService()`
- **Change PDF layout**: Edit `generatePdf()` in `offscreen.js` (page size, margins, multi-page logic)

## Gotchas

- **Readability returns null** on non-article pages (dashboards, SPAs, social feeds). The extension falls back to converting the full body HTML to Markdown.
- **html2canvas has fidelity limits** — CSS transforms, shadow DOM, and cross-origin iframes may not render correctly. Canvas size is capped at 32000px height.
- **Cross-origin images** cannot be inlined as data URIs in the HTML archive. They keep their original `src` URLs.
- **Offscreen document** is required by MV3 for jsPDF since service workers can't access DOM APIs. The offscreen doc is created on-demand and reused.
- **AGPL-3.0 note**: The original plan called for `single-file-core` (AGPL-3.0) but this implementation uses a custom HTML serializer instead, avoiding the AGPL dependency.
- **vendor/ directory** contains built files from `npm run build`. Run this after `npm install` or dependency updates.
- Requires Chrome 109+ (Manifest V3 with offscreen document support)
