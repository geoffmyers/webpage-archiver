# Webpage Archiver

A Chrome extension that archives webpages in four formats — all in one click:

| Format | Library | What it captures |
|--------|---------|-----------------|
| **HTML** | Custom serializer | Full page as a single self-contained HTML file (inlined CSS & images) |
| **Markdown** | [Readability](https://github.com/mozilla/readability) + [Turndown](https://github.com/mixmark-io/turndown) | Clean article content with YAML frontmatter |
| **PNG** | [html2canvas](https://html2canvas.hertzen.com/) | Full-page screenshot |
| **PDF** | [jsPDF](https://github.com/parallax/jsPDF) | Multi-page PDF from the screenshot |

## Installation

```bash
# Install dependencies and build vendor libraries
npm install
npm run build
```

Then load as an unpacked extension:

1. Open `chrome://extensions/`
2. Enable **Developer Mode**
3. Click **Load unpacked** and select this directory

## Usage

1. Navigate to any webpage you want to archive
2. Click the Webpage Archiver icon in the toolbar
3. Select your desired formats (HTML, Markdown, PNG, PDF)
4. Click **Archive**
5. Files are saved to your Downloads folder

### Keyboard Shortcut

**Ctrl+Shift+S** (Cmd+Shift+S on macOS) — archives the current page using your saved default formats.

### File Naming

Output files follow a configurable pattern (default: `{date}_{hostname}_{title}`):

```
2026-02-17_example.com_Article-Title.html
2026-02-17_example.com_Article-Title.md
2026-02-17_example.com_Article-Title.png
2026-02-17_example.com_Article-Title.pdf
```

### Markdown Output

The Markdown format extracts just the primary article content (stripping navigation, ads, sidebars, and footers) and includes YAML frontmatter:

```markdown
---
title: "Article Title"
url: "https://example.com/article"
archived: "2026-02-17T00:00:00.000Z"
author: "Author Name"
excerpt: "A brief summary..."
siteName: "Example.com"
---

# Article Title

Clean article content here...
```

## Options

Access via the **Options** link in the popup or `chrome://extensions` → Webpage Archiver → Details → Extension options.

- **Default formats** — which formats are pre-selected
- **Filename pattern** — customizable with `{date}`, `{hostname}`, `{title}`, `{timestamp}`
- **Subfolder** — save archives in a subfolder within Downloads

## Permissions

| Permission | Purpose |
|-----------|---------|
| `activeTab` | Access the current tab's content for capture |
| `scripting` | Inject capture scripts into the page |
| `downloads` | Save archived files |
| `storage` | Persist user preferences |
| `offscreen` | Create offscreen document for PDF generation |
| `<all_urls>` | Capture any webpage |

## Limitations

- **Non-article pages** (dashboards, SPAs, social feeds): Readability may not extract clean content. Falls back to full-body Markdown conversion.
- **Cross-origin images**: Cannot be embedded in the HTML archive as data URIs due to browser security restrictions.
- **Complex CSS**: html2canvas may not perfectly render CSS transforms, animations, shadow DOM, or cross-origin iframes.
- **Very long pages**: PNG screenshot is capped at 32,000px height. PDF splits long pages across multiple A4-sized pages.

## Dependencies

| Library | Version | License | Purpose |
|---------|---------|---------|---------|
| [@mozilla/readability](https://github.com/mozilla/readability) | ^0.5.0 | Apache-2.0 | Article content extraction |
| [html2canvas](https://html2canvas.hertzen.com/) | ^1.4.1 | MIT | Full-page screenshot |
| [jsPDF](https://github.com/parallax/jsPDF) | ^2.5.2 | MIT | PDF generation |
| [turndown](https://github.com/mixmark-io/turndown) | ^7.2.0 | MIT | HTML → Markdown conversion |
| [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) | ^1.0.2 | MIT | GFM table support |
