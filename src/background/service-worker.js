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

    // Delay to let rendering settle and respect Chrome's
    // MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND rate limit (~2/sec).
    await new Promise((r) => setTimeout(r, 350));

    // Capture with retry on rate-limit errors
    let dataUrl;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        break;
      } catch (err) {
        if (attempt < 2 && err.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }

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
  const files = []; // { filename, data, type: 'text'|'base64'|'blob-url' }
  const pageTitle = tab.title || 'untitled';
  const pageUrl = tab.url;
  const totalSteps = formats.length;
  let completedSteps = 0;

  // Check ZIP bundling preference
  const prefs = await chrome.storage.sync.get({ bundleAsZip: true });
  const bundleAsZip = prefs.bundleAsZip;

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

  // Process each format — collect files for ZIP or download individually
  const stepSize = 50 / totalSteps;

  // HTML
  if (needsHtml && captureResponse.html) {
    await reportProgress(40 + stepSize * completedSteps, 'Saving HTML archive...');
    try {
      const filename = await buildFilename(pageTitle, pageUrl, 'html');
      files.push({ filename, data: captureResponse.html, type: 'text' });
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
      files.push({ filename, data: captureResponse.markdown, type: 'text' });
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
      if (screenshotData.png.startsWith('blob:')) {
        files.push({ filename, data: screenshotData.png, type: 'blob-url' });
      } else {
        // Single-viewport data URL — strip prefix for base64
        const base64 = screenshotData.png.replace(/^data:[^;]+;base64,/, '');
        files.push({ filename, data: base64, type: 'base64' });
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
      const pdfResponse = await sendOffscreenMessage({
        type: 'generate-pdf',
        pageTitle,
        pageUrl,
      });

      if (pdfResponse.blobUrl) {
        const ext = needsPrintPdf ? 'screenshot.pdf' : 'pdf';
        const filename = await buildFilename(pageTitle, pageUrl, ext);
        files.push({ filename, data: pdfResponse.blobUrl, type: 'blob-url' });
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
      const ext = needsPdf ? 'print.pdf' : 'pdf';
      const filename = await buildFilename(pageTitle, pageUrl, ext);
      files.push({ filename, data: base64Data, type: 'base64' });
      results.push({ label: `Print PDF — ${filename}`, success: true });
    } catch (err) {
      results.push({ label: `Print PDF — ${err.message}`, success: false });
    }
    completedSteps++;
  }

  // Download files — either as a single ZIP or individually
  if (files.length > 0) {
    if (bundleAsZip) {
      await reportProgress(90, 'Creating ZIP archive...');
      try {
        await ensureOffscreenDocument();
        // Strip subfolder prefix from filenames inside the ZIP
        const zipFiles = files.map((f) => ({
          ...f,
          filename: f.filename.includes('/') ? f.filename.split('/').pop() : f.filename,
        }));
        const zipResponse = await sendOffscreenMessage({ type: 'create-zip', files: zipFiles });
        const zipFilename = await buildFilename(pageTitle, pageUrl, 'zip');
        await downloadDataUrl(zipResponse.blobUrl, zipFilename);
        await sendOffscreenMessage({ type: 'revoke-blob-url', blobUrl: zipResponse.blobUrl });
      } catch (err) {
        results.push({ label: `ZIP — ${err.message}`, success: false });
      }
    } else {
      // Download each file individually
      for (const file of files) {
        try {
          if (file.type === 'text') {
            await downloadText(file.data, file.filename,
              file.filename.endsWith('.html') ? 'text/html' : 'text/markdown');
          } else if (file.type === 'base64') {
            const mime = file.filename.endsWith('.png') ? 'image/png' : 'application/pdf';
            await downloadDataUrl(`data:${mime};base64,${file.data}`, file.filename);
          } else if (file.type === 'blob-url') {
            await downloadDataUrl(file.data, file.filename);
          }
        } catch (err) {
          // Find the matching result and mark it as failed
          const basename = file.filename.includes('/') ? file.filename.split('/').pop() : file.filename;
          const match = results.find((r) => r.label.includes(basename) && r.success);
          if (match) {
            match.success = false;
            match.label += ` (download failed: ${err.message})`;
          }
        }
      }
    }

    // Revoke any remaining blob URLs (not needed after ZIP or individual downloads)
    for (const file of files) {
      if (file.type === 'blob-url') {
        try {
          await sendOffscreenMessage({ type: 'revoke-blob-url', blobUrl: file.data });
        } catch { /* already revoked or offscreen doc closed */ }
      }
    }
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
