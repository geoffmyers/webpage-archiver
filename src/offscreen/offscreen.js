'use strict';

/**
 * Offscreen document: stitches viewport screenshots and generates PDFs.
 *
 * Message types:
 *   'stitch-screenshots' — combine viewport captures into a single tall PNG
 *   'generate-pdf'       — convert a full-page screenshot into a multi-page PDF
 */

// Cache the last stitched screenshot so generate-pdf doesn't need it re-sent
let cachedScreenshotDataUrl = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'stitch-screenshots') {
    stitchScreenshots(msg)
      .then((dataUrl) => {
        cachedScreenshotDataUrl = dataUrl;
        sendResponse({ dataUrl });
      })
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'cache-screenshot') {
    cachedScreenshotDataUrl = msg.dataUrl;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'generate-pdf') {
    // Use cached screenshot (avoids re-sending large data URL via message)
    const resolved = { ...msg };
    if (!resolved.imageDataUrl && cachedScreenshotDataUrl) {
      resolved.imageDataUrl = cachedScreenshotDataUrl;
    }
    generatePdf(resolved)
      .then((pdfDataUrl) => {
        cachedScreenshotDataUrl = null; // Free memory
        sendResponse({ pdfDataUrl });
      })
      .catch((err) => {
        cachedScreenshotDataUrl = null;
        sendResponse({ error: err.message });
      });
    return true;
  }

  return false;
});

// ─── Screenshot Stitching ─────────────────────────────────────────────────────

/**
 * Stitch multiple viewport-sized captures into one tall image.
 *
 * @param {Object} params
 * @param {string[]} params.captures - Array of data URLs (one per viewport)
 * @param {number} params.viewportWidth - CSS viewport width
 * @param {number} params.viewportHeight - CSS viewport height
 * @param {number} params.totalHeight - Total scrollable page height
 * @param {number} params.devicePixelRatio - Device pixel ratio
 * @param {number[]} params.scrollPositions - Actual scrollY for each capture
 */
async function stitchScreenshots({
  captures,
  viewportWidth,
  viewportHeight,
  totalHeight,
  devicePixelRatio,
  scrollPositions,
}) {
  const dpr = devicePixelRatio || 1;
  const canvasWidth = Math.round(viewportWidth * dpr);
  const canvasHeight = Math.round(totalHeight * dpr);

  // Cap at 32000px (canvas limit in most browsers)
  const cappedHeight = Math.min(canvasHeight, 32000);

  const canvas = new OffscreenCanvas(canvasWidth, cappedHeight);
  const ctx = canvas.getContext('2d');

  for (let i = 0; i < captures.length; i++) {
    const img = await loadImage(captures[i]);
    const destY = Math.round(scrollPositions[i] * dpr);

    // For the last capture, we may need to only draw the remaining portion
    const remainingHeight = cappedHeight - destY;
    if (remainingHeight <= 0) break;

    const drawHeight = Math.min(img.height, remainingHeight);
    ctx.drawImage(img, 0, 0, img.width, drawHeight, 0, destY, img.width, drawHeight);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

// ─── PDF Generation ───────────────────────────────────────────────────────────

async function generatePdf({ imageDataUrl, pageTitle, pageUrl, pageWidth, pageHeight }) {
  const { jsPDF } = window.jspdf;

  if (!imageDataUrl) {
    return generateTextPdf(jsPDF, pageTitle, pageUrl);
  }

  const img = await loadImage(imageDataUrl);
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
    doc.addImage(imageDataUrl, 'PNG', 0, 0, pdfWidthMm, pdfHeightMm);
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

  return doc.output('datauristring');
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

  return doc.output('datauristring');
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}
