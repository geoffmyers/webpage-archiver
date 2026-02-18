'use strict';

/**
 * Offscreen document: generates PDFs using jsPDF.
 *
 * Receives { type: 'generate-pdf', imageDataUrl, pageTitle, pageUrl, pageWidth, pageHeight }
 * Returns  { type: 'pdf-result', pdfDataUrl } or { type: 'pdf-result', error }
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'generate-pdf') return false;

  generatePdf(msg)
    .then((pdfDataUrl) => sendResponse({ pdfDataUrl }))
    .catch((err) => sendResponse({ error: err.message }));

  return true; // Async response
});

async function generatePdf({ imageDataUrl, pageTitle, pageUrl, pageWidth, pageHeight }) {
  const { jsPDF } = window.jspdf;

  if (!imageDataUrl) {
    // No screenshot available — generate a simple text-based PDF
    return generateTextPdf(jsPDF, pageTitle, pageUrl);
  }

  // Load the screenshot image
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Failed to load screenshot for PDF'));
    img.src = imageDataUrl;
  });

  const imgWidth = img.naturalWidth;
  const imgHeight = img.naturalHeight;

  // Use A4-width as reference, scale height proportionally
  const pdfWidthMm = 210; // A4 width
  const pdfHeightMm = (imgHeight / imgWidth) * pdfWidthMm;

  // Split into pages if the image is very tall
  const maxPageHeightMm = 297; // A4 height
  const totalPages = Math.ceil(pdfHeightMm / maxPageHeightMm);

  const doc = new jsPDF({
    orientation: pdfHeightMm > pdfWidthMm && totalPages === 1 ? 'portrait' : 'portrait',
    unit: 'mm',
    format: totalPages === 1 ? [pdfWidthMm, pdfHeightMm] : 'a4',
  });

  // Add metadata
  doc.setProperties({
    title: pageTitle,
    subject: `Archived from ${pageUrl}`,
    creator: 'Webpage Archiver',
  });

  if (totalPages === 1) {
    // Single page — full image
    doc.addImage(imageDataUrl, 'PNG', 0, 0, pdfWidthMm, pdfHeightMm);
  } else {
    // Multi-page: tile the image across pages
    const pageHeightPx = (maxPageHeightMm / pdfWidthMm) * imgWidth;

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) doc.addPage();

      // Calculate the portion of the image for this page
      const srcY = page * pageHeightPx;
      const srcH = Math.min(pageHeightPx, imgHeight - srcY);
      const destH = (srcH / imgWidth) * pdfWidthMm;

      // Create a canvas for this page slice
      const sliceCanvas = new OffscreenCanvas(imgWidth, srcH);
      const ctx = sliceCanvas.getContext('2d');
      ctx.drawImage(img, 0, srcY, imgWidth, srcH, 0, 0, imgWidth, srcH);

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
