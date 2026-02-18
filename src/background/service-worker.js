'use strict';

/**
 * Service worker: orchestrates page capture across formats.
 *
 * Flow:
 *   popup sends { type: 'archive', formats: [...] }
 *     → inject content script into active tab
 *     → content script returns captured data per format
 *     → for PDF: open offscreen document, render, get blob
 *     → download all files via chrome.downloads
 */

// ─── File naming ──────────────────────────────────────────────────────────────

function sanitizeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .substring(0, 120);
}

async function buildFilename(pageTitle, pageUrl, ext) {
  const data = await chrome.storage.sync.get({
    filenamePattern: '{date}_{hostname}_{title}',
    subfolder: '',
  });

  const date = new Date().toISOString().slice(0, 10);
  const timestamp = Date.now();
  let hostname;
  try {
    hostname = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    hostname = 'unknown';
  }
  const title = sanitizeFilename(pageTitle || 'untitled');

  let name = data.filenamePattern
    .replace('{date}', date)
    .replace('{hostname}', hostname)
    .replace('{title}', title)
    .replace('{timestamp}', String(timestamp));

  name = sanitizeFilename(name) + '.' + ext;

  if (data.subfolder) {
    return `${data.subfolder}/${name}`;
  }
  return name;
}

// ─── Offscreen document management ───────────────────────────────────────────

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextType: 'OFFSCREEN_DOCUMENT',
    documentUrl: chrome.runtime.getURL('src/offscreen/offscreen.html'),
  });
  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Generate PDF from captured page content',
  });
  await offscreenCreating;
  offscreenCreating = null;
}

// ─── Progress reporting ─────────────────────────────────────────────────────

async function reportProgress(percent, label) {
  // Send to popup (may not be open — that's fine, it won't error)
  try {
    await chrome.runtime.sendMessage({ type: 'archive-progress', percent, label });
  } catch {
    // Popup closed — ignore
  }
}

// ─── Content script injection ────────────────────────────────────────────────

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'vendor/Readability.js',
      'vendor/html2canvas.min.js',
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
      'src/content/content-script.js',
    ],
  });
}

// ─── Download helper ─────────────────────────────────────────────────────────

function downloadDataUrl(dataUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        // Revoke after a short delay to ensure download starts
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function downloadText(text, filename, mimeType = 'text/plain') {
  const blob = new Blob([text], { type: mimeType });
  return downloadBlob(blob, filename);
}

// ─── Main archive handler ────────────────────────────────────────────────────

async function archivePage(formats) {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');

  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
    throw new Error('Cannot archive browser internal pages.');
  }

  const results = [];
  const pageTitle = tab.title || 'untitled';
  const pageUrl = tab.url;
  const totalSteps = formats.length;
  let completedSteps = 0;

  // Inject content script
  await reportProgress(5, 'Injecting content script...');
  await injectContentScript(tab.id);

  // Request captures from the content script
  const needsHtml = formats.includes('html');
  const needsPng = formats.includes('png');
  const needsMarkdown = formats.includes('markdown');
  const needsPdf = formats.includes('pdf');

  await reportProgress(15, 'Capturing page content...');

  const captureResponse = await chrome.tabs.sendMessage(tab.id, {
    type: 'capture',
    formats: { html: needsHtml, png: needsPng, markdown: needsMarkdown, pdf: needsPdf },
    pageUrl,
    pageTitle,
  });

  if (captureResponse.error) {
    throw new Error(captureResponse.error);
  }

  // Process each format
  const stepSize = 75 / totalSteps; // 15% already used, leave 10% for final

  // HTML
  if (needsHtml && captureResponse.html) {
    await reportProgress(15 + stepSize * completedSteps, 'Saving HTML archive...');
    try {
      const filename = await buildFilename(pageTitle, pageUrl, 'html');
      await downloadText(captureResponse.html, filename, 'text/html');
      results.push({ label: `HTML — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `HTML — ${err.message}`, success: false });
    }
    completedSteps++;
  } else if (needsHtml) {
    results.push({ label: 'HTML — capture failed', success: false });
    completedSteps++;
  }

  // Markdown
  if (needsMarkdown && captureResponse.markdown) {
    await reportProgress(15 + stepSize * completedSteps, 'Saving Markdown...');
    try {
      const filename = await buildFilename(pageTitle, pageUrl, 'md');
      await downloadText(captureResponse.markdown, filename, 'text/markdown');
      results.push({ label: `Markdown — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `Markdown — ${err.message}`, success: false });
    }
    completedSteps++;
  } else if (needsMarkdown) {
    results.push({ label: 'Markdown — capture failed (page may not have article content)', success: false });
    completedSteps++;
  }

  // PNG
  if (needsPng && captureResponse.png) {
    await reportProgress(15 + stepSize * completedSteps, 'Saving screenshot...');
    try {
      const filename = await buildFilename(pageTitle, pageUrl, 'png');
      await downloadDataUrl(captureResponse.png, filename);
      results.push({ label: `PNG — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `PNG — ${err.message}`, success: false });
    }
    completedSteps++;
  } else if (needsPng) {
    results.push({ label: 'PNG — capture failed', success: false });
    completedSteps++;
  }

  // PDF
  if (needsPdf) {
    await reportProgress(15 + stepSize * completedSteps, 'Generating PDF...');
    try {
      await ensureOffscreenDocument();
      const pdfResponse = await chrome.runtime.sendMessage({
        type: 'generate-pdf',
        imageDataUrl: captureResponse.png,
        pageTitle,
        pageUrl,
        pageWidth: captureResponse.pageWidth,
        pageHeight: captureResponse.pageHeight,
      });

      if (pdfResponse && pdfResponse.pdfDataUrl) {
        const filename = await buildFilename(pageTitle, pageUrl, 'pdf');
        await downloadDataUrl(pdfResponse.pdfDataUrl, filename);
        results.push({ label: `PDF — ${filename}`, success: true });
      } else {
        results.push({ label: `PDF — ${pdfResponse?.error || 'generation failed'}`, success: false });
      }
    } catch (err) {
      results.push({ label: `PDF — ${err.message}`, success: false });
    }
    completedSteps++;
  }

  await reportProgress(95, 'Done.');
  return results;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only handle messages from the popup (not from content scripts or offscreen doc)
  if (msg.type === 'archive') {
    archivePage(msg.formats)
      .then((results) => sendResponse({ results }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }

  // Ignore messages not intended for the service worker
  return false;
});

// ─── Keyboard shortcut handler ────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'archive-page') {
    const data = await chrome.storage.sync.get({
      formats: { html: true, markdown: true, png: true, pdf: true },
    });
    const formats = Object.entries(data.formats)
      .filter(([, enabled]) => enabled)
      .map(([fmt]) => fmt);

    if (formats.length === 0) return;

    try {
      await archivePage(formats);
    } catch (err) {
      console.error('Webpage Archiver: shortcut archive failed', err);
    }
  }
});
