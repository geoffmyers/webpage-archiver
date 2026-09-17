'use strict';

/**
 * Content script: captures page content in multiple formats.
 *
 * Injected alongside this file, in the same isolated world:
 *   - Readability       (from @mozilla/readability)
 *   - TurndownService   (from turndown)
 *   - turndownPluginGfm (from turndown-plugin-gfm)
 *   - serializeHtml()   (from html-sanitizer.js — the HTML archive format)
 *
 * Responds to messages from the service worker:
 *   { type: 'capture', formats: { html, png, markdown, pdf } }
 *     → returns { html?, png?, markdown?, pageWidth, pageHeight, error? }
 */

// Guard against multiple injections
if (!window.__webpageArchiverInjected) {
  window.__webpageArchiverInjected = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'capture') {
      capturePage(msg.formats, msg.pageUrl, msg.pageTitle)
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }

    if (msg.type === 'get-page-dimensions') {
      sendResponse(getPageDimensions());
      return false;
    }

    if (msg.type === 'scroll-to') {
      sendResponse(scrollToPosition(msg.y));
      return false;
    }

    return false;
  });
}

async function capturePage(formats, pageUrl, pageTitle) {
  const result = {
    pageWidth: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
  };

  // HTML archive (full page as single-file HTML)
  if (formats.html) {
    try {
      result.html = serializeHtml(pageUrl, pageTitle);
    } catch (err) {
      console.warn('Webpage Archiver: HTML capture failed', err);
      result.html = null;
    }
  }

  // Markdown (article content via Readability + Turndown)
  if (formats.markdown) {
    try {
      result.markdown = extractMarkdown(pageUrl, pageTitle);
    } catch (err) {
      console.warn('Webpage Archiver: Markdown extraction failed', err);
      result.markdown = null;
    }
  }

  return result;
}

// ─── HTML Serialization ──────────────────────────────────────────────────────
//
// serializeHtml() (plus its sanitization helpers) lives in html-sanitizer.js,
// injected alongside this file so it can also be loaded standalone by tests.

// ─── Markdown Extraction ─────────────────────────────────────────────────────

function extractMarkdown(pageUrl, pageTitle) {
  if (typeof Readability === 'undefined') {
    return null;
  }

  // Readability mutates the DOM, so clone it
  const docClone = document.cloneNode(true);
  const reader = new Readability(docClone);
  const article = reader.parse();

  if (!article || !article.content) {
    // Fall back to body content
    return buildMarkdownFromBody(pageUrl, pageTitle);
  }

  const turndown = createTurndownService();
  const body = turndown.turndown(article.content);

  const frontmatter = buildFrontmatter({
    title: article.title || pageTitle,
    url: pageUrl,
    archived: new Date().toISOString(),
    author: article.byline || '',
    excerpt: article.excerpt || '',
    siteName: article.siteName || '',
  });

  return frontmatter + body + '\n';
}

function buildMarkdownFromBody(pageUrl, pageTitle) {
  // Fallback: convert entire body (less clean but better than nothing)
  const turndown = createTurndownService();
  const body = turndown.turndown(document.body.innerHTML);

  const frontmatter = buildFrontmatter({
    title: pageTitle,
    url: pageUrl,
    archived: new Date().toISOString(),
    author: '',
    excerpt: '',
    siteName: '',
  });

  return frontmatter + body + '\n';
}

function createTurndownService() {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });

  // Add GFM plugin for tables and strikethrough
  if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) {
    turndown.use(turndownPluginGfm.gfm);
  }

  // Remove unwanted elements
  turndown.remove(['script', 'style', 'nav', 'footer', 'iframe', 'noscript']);

  return turndown;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      // Escape quotes in values
      const escaped = String(value).replace(/"/g, '\\"');
      lines.push(`${key}: "${escaped}"`);
    }
  }
  lines.push('---', '', '');
  return lines.join('\n');
}

// ─── Scroll-based Screenshot Helpers ─────────────────────────────────────────

function getPageDimensions() {
  return {
    scrollWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth
    ),
    scrollHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function scrollToPosition(y) {
  window.scrollTo({ left: 0, top: y, behavior: 'instant' });
  // Return the actual scroll position (may be clamped)
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}
