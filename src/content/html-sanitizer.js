'use strict';

/**
 * Pure DOM sanitisation/serialisation for the "single-file HTML" archive
 * format. No chrome.* APIs here — this file is injected as a content script
 * alongside content-script.js (which calls serializeHtml()), and it is also
 * loaded directly into a plain page by tests/extension.spec.js so the tests
 * exercise the real function instead of a reimplementation.
 *
 * An archive opened straight from disk gets no chrome:// sandbox and no
 * extension permissions model — it is just a file a browser will happily
 * execute. serializeHtml() removes everything that could run code, strips
 * event-handler attributes and dangerous URL schemes, and adds a
 * belt-and-suspenders CSP meta tag so the saved file is inert even if
 * something slipped through.
 */

const ARCHIVE_CSP =
  "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:; media-src data: https: http:";

// Elements removed outright. `base` is included because we add our own
// (see serializeHtml) — a page's own <base> could otherwise redirect our
// relative-URL resolution to an attacker-controlled origin.
const REMOVE_SELECTOR = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'object',
  'embed',
  'applet',
  'base',
  'meta[http-equiv="refresh" i]',
  'link[rel~="modulepreload" i]',
  'link[rel~="preload" i][as="script" i]',
  'link[rel~="prefetch" i][as="script" i]',
  'link[rel~="import" i]',
].join(', ');

// Attributes that can carry a javascript:/vbscript:/data:text/html URL.
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href'];

function isDangerousUrl(value) {
  if (!value) return false;
  // DOM attribute values are already entity-decoded, so this only has to
  // cope with whitespace/control-character obfuscation of the scheme
  // (e.g. "java\tscript:").
  const normalized = String(value).replace(/[\x00-\x20]+/g, '').toLowerCase();
  return /^(javascript|vbscript):/.test(normalized) || /^data:text\/html/.test(normalized);
}

function sanitizeClonedDocument(docClone) {
  docClone.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());

  const elements = docClone.querySelectorAll('*');
  for (const el of elements) {
    // Snapshot the attribute list first: removeAttribute() during iteration
    // over the live NamedNodeMap skips entries as indices shift.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcdoc') {
        // Only meaningful on <iframe>, which is already removed above, but
        // strip it unconditionally as defense in depth.
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.includes(name) && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function escapeForHtmlComment(str) {
  // An HTML comment cannot contain "--" anywhere in its body — a page title
  // or URL containing "-->" would otherwise close the comment early and let
  // the rest of the string be interpreted as markup. Collapse any run of 2+
  // hyphens to a non-ASCII look-alike so that can't happen.
  return String(str).replace(/-{2,}/g, (m) => '‐'.repeat(m.length));
}

function buildProvenanceComment(pageUrl, pageTitle) {
  const safeUrl = escapeForHtmlComment(pageUrl || '');
  const safeTitle = escapeForHtmlComment(pageTitle || '');
  return (
    `\n  Archived by Webpage Archiver\n  URL: ${safeUrl}\n  Title: ${safeTitle}` +
    `\n  Date: ${new Date().toISOString()}\n`
  );
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

  // Ensure a <head> exists so every step below has somewhere to put things.
  let head = docClone.querySelector('head');
  if (!head) {
    head = docClone.createElement('head');
    docClone.documentElement.insertBefore(head, docClone.documentElement.firstChild);
  }

  // Remove existing <link rel="stylesheet"> and add inlined styles
  const links = docClone.querySelectorAll('link[rel="stylesheet"]');
  links.forEach((link) => link.remove());

  if (inlinedStyles.length > 0) {
    const styleEl = docClone.createElement('style');
    styleEl.textContent = inlinedStyles.join('\n\n');
    head.appendChild(styleEl);
  }

  // Strip everything that could run code, plus resource hints that would
  // pull in more script, so the archive is inert when opened from disk.
  sanitizeClonedDocument(docClone);

  // Inline images as data URIs where possible
  inlineImages(docClone);

  // Base href so relative URLs resolve. sanitizeClonedDocument already
  // removed any <base> the page itself had, so this is the only one.
  const base = docClone.createElement('base');
  base.setAttribute('href', pageUrl);
  head.prepend(base);

  // Belt-and-suspenders CSP: even if some future change missed a vector
  // above, the archive can load nothing but data/http(s) images, fonts and
  // media, plus its own inlined styles — no script, no navigation, no fetch.
  const csp = docClone.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', ARCHIVE_CSP);
  head.prepend(csp);

  // Provenance comment. It has to live *inside* the element we actually
  // serialize below — anything inserted as a sibling of <html> is lost,
  // since only documentElement.outerHTML is returned — so it goes at the
  // very top of <head>.
  const metaComment = docClone.createComment(buildProvenanceComment(pageUrl, pageTitle));
  head.insertBefore(metaComment, head.firstChild);

  return '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
}

// Explicit global assignment (rather than relying on top-level function
// declarations attaching themselves to `window`): chrome.scripting's file
// injection runs this as a normal classic script, where that happens
// automatically, but Playwright's page.evaluate() wraps evaluated strings in
// a way that does not — and the tests inject this file exactly that way so
// they exercise the real function instead of a reimplementation.
if (typeof window !== 'undefined') {
  window.serializeHtml = serializeHtml;
}
