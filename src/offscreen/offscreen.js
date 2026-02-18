'use strict';

/**
 * Offscreen document: stitches viewport screenshots and generates PDFs.
 *
 * Uses a dedicated port connection (not runtime.sendMessage) to avoid
 * message routing conflicts with the popup's onMessage listener in MV3.
 *
 * Message types:
 *   'stitch-init'        — initialize canvas for incremental screenshot stitching
 *   'stitch-add-capture' — draw one viewport capture onto the stitch canvas
 *   'stitch-finalize'    — finalize stitch into a PNG blob and return a blob URL
 *   'cache-screenshot'   — cache a single-viewport screenshot for PDF use
 *   'generate-pdf'       — convert a full-page screenshot into a multi-page PDF
 *   'revoke-blob-url'    — free a blob URL's memory
 *   'create-zip'         — bundle files into a ZIP archive and return a blob URL
 */

// Cache the last stitched screenshot blob so generate-pdf can use it directly
let cachedScreenshotBlob = null;

// Incremental stitch state — captures are sent one at a time to avoid
// exceeding Chrome's 64 MiB port.postMessage limit.
let stitchCanvas = null;
let stitchCtx = null;
let stitchDpr = 1;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;

  port.onMessage.addListener(async (msg) => {
    try {
      // --- Incremental stitch protocol ---
      if (msg.type === 'stitch-init') {
        stitchDpr = msg.devicePixelRatio || 1;
        const canvasWidth = Math.round(msg.viewportWidth * stitchDpr);
        const canvasHeight = Math.min(Math.round(msg.totalHeight * stitchDpr), 32000);
        stitchCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
        stitchCtx = stitchCanvas.getContext('2d');
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'stitch-add-capture') {
        const img = await loadImage(msg.dataUrl);
        const destY = Math.round(msg.scrollY * stitchDpr);
        const remainingHeight = stitchCanvas.height - destY;
        if (remainingHeight > 0) {
          const drawHeight = Math.min(img.height, remainingHeight);
          stitchCtx.drawImage(img, 0, 0, img.width, drawHeight, 0, destY, img.width, drawHeight);
        }
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'stitch-finalize') {
        const blob = await stitchCanvas.convertToBlob({ type: 'image/png' });
        cachedScreenshotBlob = blob;
        stitchCanvas = null;
        stitchCtx = null;
        const blobUrl = URL.createObjectURL(blob);
        port.postMessage({ id: msg.id, blobUrl });
        return;
      }

      if (msg.type === 'cache-screenshot') {
        // Convert data URL to blob for consistent caching
        cachedScreenshotBlob = await dataUrlToBlob(msg.dataUrl);
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'generate-pdf') {
        const pdfBlob = await generatePdf({
          ...msg,
          screenshotBlob: cachedScreenshotBlob,
        });
        cachedScreenshotBlob = null;
        const blobUrl = URL.createObjectURL(pdfBlob);
        port.postMessage({ id: msg.id, blobUrl });
        return;
      }

      if (msg.type === 'revoke-blob-url') {
        URL.revokeObjectURL(msg.blobUrl);
        port.postMessage({ id: msg.id, ok: true });
        return;
      }

      if (msg.type === 'create-zip') {
        const blobUrl = await createZip(msg.files);
        port.postMessage({ id: msg.id, blobUrl });
        return;
      }
    } catch (err) {
      cachedScreenshotBlob = null;
      port.postMessage({ id: msg.id, error: err.message });
    }
  });
});

// ─── Image Loading ───────────────────────────────────────────────────────────

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

// ─── PDF Generation ───────────────────────────────────────────────────────────

async function generatePdf({ screenshotBlob, pageTitle, pageUrl }) {
  const { jsPDF } = window.jspdf;

  if (!screenshotBlob) {
    return generateTextPdf(jsPDF, pageTitle, pageUrl);
  }

  const imgUrl = URL.createObjectURL(screenshotBlob);
  try {
    const img = await loadImage(imgUrl);
    const imgWidth = img.naturalWidth;
    const imgHeight = img.naturalHeight;

    // Use A4-width as reference, scale height proportionally
    const pdfWidthMm = 210;
    const pdfHeightMm = (imgHeight / imgWidth) * pdfWidthMm;

    // Split into pages if the image is very tall
    const maxPageHeightMm = 297;
    const totalPages = Math.ceil(pdfHeightMm / maxPageHeightMm);

    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: totalPages === 1 ? [pdfWidthMm, pdfHeightMm] : 'a4',
    });

    doc.setProperties({
      title: pageTitle,
      subject: `Archived from ${pageUrl}`,
      creator: 'Webpage Archiver',
    });

    if (totalPages === 1) {
      // For single-page, convert to data URL for jsPDF (single page is small)
      const dataUrl = await blobToDataUrl(screenshotBlob);
      doc.addImage(dataUrl, 'PNG', 0, 0, pdfWidthMm, pdfHeightMm);
    } else {
      const pageHeightPx = (maxPageHeightMm / pdfWidthMm) * imgWidth;

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) doc.addPage();

        const srcY = page * pageHeightPx;
        const srcH = Math.min(pageHeightPx, imgHeight - srcY);
        const destH = (srcH / imgWidth) * pdfWidthMm;

        const sliceCanvas = new OffscreenCanvas(imgWidth, Math.round(srcH));
        const ctx = sliceCanvas.getContext('2d');
        ctx.drawImage(img, 0, srcY, imgWidth, srcH, 0, 0, imgWidth, Math.round(srcH));

        const sliceBlob = await sliceCanvas.convertToBlob({ type: 'image/png' });
        const sliceDataUrl = await blobToDataUrl(sliceBlob);

        doc.addImage(sliceDataUrl, 'PNG', 0, 0, pdfWidthMm, destH);
      }
    }

    return doc.output('blob');
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
}

function generateTextPdf(jsPDF, pageTitle, pageUrl) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  doc.setProperties({
    title: pageTitle,
    subject: `Archived from ${pageUrl}`,
    creator: 'Webpage Archiver',
  });

  doc.setFontSize(18);
  doc.text(pageTitle || 'Untitled Page', 20, 30);

  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`URL: ${pageUrl}`, 20, 45);
  doc.text(`Archived: ${new Date().toISOString()}`, 20, 52);
  doc.text('(Screenshot was not available for this page)', 20, 66);

  return doc.output('blob');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  return fetch(dataUrl).then((r) => r.blob());
}

// ─── ZIP Creation ────────────────────────────────────────────────────────────

async function createZip(files) {
  const zip = new JSZip();

  for (const file of files) {
    if (file.type === 'text') {
      zip.file(file.filename, file.data);
    } else if (file.type === 'base64') {
      zip.file(file.filename, file.data, { base64: true });
    } else if (file.type === 'blob-url') {
      const blob = await fetch(file.data).then((r) => r.blob());
      zip.file(file.filename, blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return URL.createObjectURL(zipBlob);
}
