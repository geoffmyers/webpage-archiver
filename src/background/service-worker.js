'use strict';

/**
 * Service worker: orchestrates page capture across formats.
 *
 * Flow:
 *   popup sends { type: 'archive', formats: [...] }
 *     → inject content script into active tab
 *     → content script returns captured data per format (HTML, Markdown)
 *     → for PNG: scroll page + captureVisibleTab → stitch incrementally in offscreen doc
 *     → for PDF: open offscreen document, render from stitched PNG
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
// Uses a dedicated port (not runtime.sendMessage) to avoid message routing
// conflicts with the popup's onMessage listener in MV3.

let offscreenCreating = null;
let offscreenPort = null;
let msgIdCounter = 0;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('src/offscreen/offscreen.html')],
  });

  if (existingContexts.length === 0) {
    if (offscreenCreating) {
      await offscreenCreating;
    } else {
      offscreenCreating = chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Stitch screenshots and generate PDF from captured page content',
      });
      await offscreenCreating;
      offscreenCreating = null;
    }
  }

  if (!offscreenPort) {
    offscreenPort = chrome.runtime.connect({ name: 'offscreen' });
    offscreenPort.onDisconnect.addListener(() => { offscreenPort = null; });
  }
}

function sendOffscreenMessage(msg) {
  return new Promise((resolve, reject) => {
    const id = ++msgIdCounter;
    const handler = (response) => {
      if (response.id !== id) return;
      offscreenPort.onMessage.removeListener(handler);
      if (response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    };
    offscreenPort.onMessage.addListener(handler);
    offscreenPort.postMessage({ ...msg, id });
  });
}

// ─── Progress reporting ─────────────────────────────────────────────────────

async function reportProgress(percent, label) {
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
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
      'src/content/content-script.js',
    ],
  });
}

// ─── Full-page screenshot via scroll + captureVisibleTab ─────────────────────

async function captureFullPageScreenshot(tabId) {
  // Get page dimensions from content script
  const dims = await chrome.tabs.sendMessage(tabId, { type: 'get-page-dimensions' });
  const { scrollHeight, viewportWidth, viewportHeight, devicePixelRatio } = dims;

  await ensureOffscreenDocument();

  // Short-circuit: if page fits in one viewport, just capture once
  if (scrollHeight <= viewportHeight) {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    // Cache in offscreen doc so generate-pdf can use it without re-sending
    await sendOffscreenMessage({ type: 'cache-screenshot', dataUrl });
    return {
      png: dataUrl,
      pageWidth: viewportWidth,
      pageHeight: scrollHeight,
    };
  }

  // Scroll through the page, capturing each viewport.
  // Captures are sent individually to the offscreen document to avoid
  // exceeding Chrome's 64 MiB message limit on port.postMessage.
  await sendOffscreenMessage({
    type: 'stitch-init',
    viewportWidth,
    viewportHeight,
    totalHeight: scrollHeight,
    devicePixelRatio,
  });

  let currentY = 0;
  while (currentY < scrollHeight) {
    // Scroll to position
    const pos = await chrome.tabs.sendMessage(tabId, { type: 'scroll-to', y: currentY });

    // Small delay to let rendering settle after scroll
    await new Promise((r) => setTimeout(r, 150));

    // Capture the visible viewport and send immediately to offscreen doc
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    await sendOffscreenMessage({
      type: 'stitch-add-capture',
      dataUrl,
      scrollY: pos.scrollY,
    });

    currentY += viewportHeight;
  }

  // Scroll back to top
  await chrome.tabs.sendMessage(tabId, { type: 'scroll-to', y: 0 });

  // Finalize the stitch and get a blob URL back.
  const stitchResponse = await sendOffscreenMessage({ type: 'stitch-finalize' });

  return {
    png: stitchResponse.blobUrl,
    pageWidth: viewportWidth,
    pageHeight: scrollHeight,
  };
}

// ─── Download helpers ────────────────────────────────────────────────────────

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

function downloadText(text, filename, mimeType = 'text/plain') {
  // MV3 service workers don't have URL.createObjectURL — use a data URL instead
  const base64 = btoa(unescape(encodeURIComponent(text)));
  const dataUrl = `data:${mimeType};base64,${base64}`;
  return downloadDataUrl(dataUrl, filename);
}

// ─── Print PDF via Chrome DevTools Protocol ──────────────────────────────────

async function generatePrintPdf(tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    return result.data; // base64-encoded PDF
  } finally {
    await chrome.debugger.detach({ tabId });
  }
}

// ─── Main archive handler ────────────────────────────────────────────────────

async function archivePage(formats) {
  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error('No active tab found.');

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

  // Request text captures from the content script (HTML, Markdown)
  const needsHtml = formats.includes('html');
  const needsPng = formats.includes('png');
  const needsMarkdown = formats.includes('markdown');
  const needsPdf = formats.includes('pdf');
  const needsPrintPdf = formats.includes('printpdf');

  await reportProgress(15, 'Capturing page content...');

  const captureResponse = await chrome.tabs.sendMessage(tab.id, {
    type: 'capture',
    formats: { html: needsHtml, png: false, markdown: needsMarkdown, pdf: false },
    pageUrl,
    pageTitle,
  });

  if (captureResponse.error) {
    throw new Error(captureResponse.error);
  }

  // Capture full-page screenshot if needed (for PNG and/or PDF)
  let screenshotData = null;
  if (needsPng || needsPdf) {
    await reportProgress(30, 'Capturing full-page screenshot...');
    try {
      screenshotData = await captureFullPageScreenshot(tab.id);
    } catch (err) {
      console.warn('Webpage Archiver: screenshot capture failed', err);
    }
  }

  // Process each format
  const stepSize = 50 / totalSteps;

  // HTML
  if (needsHtml && captureResponse.html) {
    await reportProgress(40 + stepSize * completedSteps, 'Saving HTML archive...');
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
    await reportProgress(40 + stepSize * completedSteps, 'Saving Markdown...');
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
  if (needsPng && screenshotData?.png) {
    await reportProgress(40 + stepSize * completedSteps, 'Saving screenshot...');
    try {
      const filename = await buildFilename(pageTitle, pageUrl, 'png');
      await downloadDataUrl(screenshotData.png, filename);
      // Revoke blob URL after download starts (blob URLs from offscreen doc)
      if (screenshotData.png.startsWith('blob:')) {
        await sendOffscreenMessage({ type: 'revoke-blob-url', blobUrl: screenshotData.png });
      }
      results.push({ label: `PNG — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `PNG — ${err.message}`, success: false });
    }
    completedSteps++;
  } else if (needsPng) {
    results.push({ label: 'PNG — capture failed', success: false });
    completedSteps++;
  }

  // Screenshot PDF
  if (needsPdf) {
    await reportProgress(40 + stepSize * completedSteps, 'Generating screenshot PDF...');
    try {
      await ensureOffscreenDocument();
      // Screenshot is already cached in the offscreen doc from stitch or cache step
      const pdfResponse = await sendOffscreenMessage({
        type: 'generate-pdf',
        pageTitle,
        pageUrl,
      });

      if (pdfResponse.blobUrl) {
        const ext = needsPrintPdf ? 'screenshot.pdf' : 'pdf';
        const filename = await buildFilename(pageTitle, pageUrl, ext);
        await downloadDataUrl(pdfResponse.blobUrl, filename);
        await sendOffscreenMessage({ type: 'revoke-blob-url', blobUrl: pdfResponse.blobUrl });
        results.push({ label: `Screenshot PDF — ${filename}`, success: true });
      } else {
        results.push({ label: 'Screenshot PDF — generation failed', success: false });
      }
    } catch (err) {
      results.push({ label: `Screenshot PDF — ${err.message}`, success: false });
    }
    completedSteps++;
  }

  // Print PDF
  if (needsPrintPdf) {
    await reportProgress(40 + stepSize * completedSteps, 'Generating print PDF...');
    try {
      const base64Data = await generatePrintPdf(tab.id);
      const dataUrl = 'data:application/pdf;base64,' + base64Data;
      const ext = needsPdf ? 'print.pdf' : 'pdf';
      const filename = await buildFilename(pageTitle, pageUrl, ext);
      await downloadDataUrl(dataUrl, filename);
      results.push({ label: `Print PDF — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `Print PDF — ${err.message}`, success: false });
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
      formats: { html: true, markdown: true, png: true, pdf: true, printpdf: true },
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
