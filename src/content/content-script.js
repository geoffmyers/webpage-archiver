'use strict';

/**
 * Content script: captures page content in multiple formats.
 *
 * Injected vendor globals:
 *   - Readability       (from @mozilla/readability)
 *   - html2canvas       (from html2canvas)
 *   - TurndownService   (from turndown)
 *   - turndownPluginGfm (from turndown-plugin-gfm)
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

function serializeHtml(pageUrl, pageTitle) {
  const docClone = document.cloneNode(true);

  // Inline all stylesheets as <style> blocks
  const styleSheets = Array.from(document.styleSheets);
  const inlinedStyles = [];

  for (const sheet of styleSheets) {
    try {
      const rules = Array.from(sheet.cssRules || []);
      const css = rules.map((r) => r.cssText).join('\n');
      if (css) inlinedStyles.push(css);
    } catch {
      // Cross-origin stylesheet — try to keep the <link> reference
      if (sheet.href) {
        inlinedStyles.push(`/* External stylesheet: ${sheet.href} */`);
      }
    }
  }

  // Remove existing <link rel="stylesheet"> and add inlined styles
  const links = docClone.querySelectorAll('link[rel="stylesheet"]');
  links.forEach((link) => link.remove());

  if (inlinedStyles.length > 0) {
    const styleEl = docClone.createElement('style');
    styleEl.textContent = inlinedStyles.join('\n\n');
    const head = docClone.querySelector('head') || docClone.documentElement;
    head.appendChild(styleEl);
  }

  // Remove scripts (not useful in an archive)
  const scripts = docClone.querySelectorAll('script');
  scripts.forEach((s) => s.remove());

  // Inline images as data URIs where possible
  inlineImages(docClone);

  // Add archive metadata
  const metaComment = docClone.createComment(
    `\n  Archived by Webpage Archiver\n  URL: ${pageUrl}\n  Title: ${pageTitle}\n  Date: ${new Date().toISOString()}\n`
  );
  docClone.insertBefore(metaComment, docClone.firstChild);

  // Add base href so relative URLs resolve
  let base = docClone.querySelector('base');
  if (!base) {
    base = docClone.createElement('base');
    const head = docClone.querySelector('head');
    if (head) head.prepend(base);
  }
  base.setAttribute('href', pageUrl);

  return '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
}

function inlineImages(docClone) {
  const images = docClone.querySelectorAll('img');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  for (const img of images) {
    // Find the corresponding image in the live DOM
    const liveImg = findLiveImage(img);
    if (!liveImg || !liveImg.complete || liveImg.naturalWidth === 0) continue;

    try {
      canvas.width = liveImg.naturalWidth;
      canvas.height = liveImg.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(liveImg, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      img.setAttribute('src', dataUrl);
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      img.removeAttribute('loading');
    } catch {
      // Cross-origin image — keep original src
    }
  }
}

function findLiveImage(clonedImg) {
  // Match by src, data attributes, or position
  const src = clonedImg.getAttribute('src');
  if (src) {
    const match = document.querySelector(`img[src="${CSS.escape(src)}"]`);
    if (match) return match;
  }
  return null;
}

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
