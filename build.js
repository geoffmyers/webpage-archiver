/**
 * Build script: copies vendor libraries from node_modules into vendor/
 * so the extension can load them directly as plain JS files.
 */

const fs = require('fs');
const path = require('path');

const VENDOR_DIR = path.join(__dirname, 'vendor');

// Ensure vendor directory exists
if (!fs.existsSync(VENDOR_DIR)) {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
}

const copies = [
  {
    src: 'node_modules/html2canvas/dist/html2canvas.min.js',
    dest: 'vendor/html2canvas.min.js',
  },
  {
    src: 'node_modules/jspdf/dist/jspdf.umd.min.js',
    dest: 'vendor/jspdf.umd.min.js',
  },
  {
    src: 'node_modules/@mozilla/readability/Readability.js',
    dest: 'vendor/Readability.js',
  },
  {
    src: 'node_modules/turndown/lib/turndown.browser.umd.js',
    dest: 'vendor/turndown.umd.js',
  },
  {
    src: 'node_modules/turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
    dest: 'vendor/turndown-plugin-gfm.js',
  },
];

let copied = 0;
let failed = 0;

for (const { src, dest } of copies) {
  const srcPath = path.join(__dirname, src);
  const destPath = path.join(__dirname, dest);
  try {
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${dest}`);
    copied++;
  } catch (err) {
    console.error(`  ✗ ${dest} — ${err.message}`);
    failed++;
  }
}

console.log(`\nCopied ${copied} files${failed ? `, ${failed} failed` : ''}.`);
if (failed) process.exit(1);
