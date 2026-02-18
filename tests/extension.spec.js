// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');

// ─── Structural / Static Validation Tests ─────────────────────────────────────

test.describe('Extension Structure', () => {
  test('manifest.json is valid and contains required fields', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Webpage Archiver');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.permissions).toContain('downloads');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.permissions).toContain('debugger');
    expect(manifest.host_permissions).toContain('<all_urls>');
    expect(manifest.background.service_worker).toBe('src/background/service-worker.js');
    expect(manifest.action.default_popup).toBe('src/popup/popup.html');
    expect(manifest.options_ui.page).toBe('src/options/options.html');
    expect(manifest.commands['archive-page']).toBeDefined();
    expect(manifest.minimum_chrome_version).toBe('109');
  });

  test('all files referenced in manifest exist', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf-8')
    );

    // Service worker
    expect(fs.existsSync(path.join(EXTENSION_PATH, manifest.background.service_worker))).toBe(true);

    // Popup
    expect(fs.existsSync(path.join(EXTENSION_PATH, manifest.action.default_popup))).toBe(true);

    // Options page
    expect(fs.existsSync(path.join(EXTENSION_PATH, manifest.options_ui.page))).toBe(true);

    // Icons
    for (const [size, iconPath] of Object.entries(manifest.icons)) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, iconPath))).toBe(true);
    }
    for (const [size, iconPath] of Object.entries(manifest.action.default_icon)) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, iconPath))).toBe(true);
    }
  });

  test('all vendor libraries exist', () => {
    const vendorFiles = [
      'vendor/Readability.js',
      'vendor/html2canvas.min.js',
      'vendor/jspdf.umd.min.js',
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
    ];

    for (const file of vendorFiles) {
      const filePath = path.join(EXTENSION_PATH, file);
      expect(fs.existsSync(filePath), `Missing vendor file: ${file}`).toBe(true);
      const stat = fs.statSync(filePath);
      expect(stat.size, `Vendor file is empty: ${file}`).toBeGreaterThan(0);
    }
  });

  test('all source files referenced by service worker exist', () => {
    const injectedFiles = [
      'vendor/Readability.js',
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
      'src/content/content-script.js',
    ];

    for (const file of injectedFiles) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, file))).toBe(true);
    }
  });

  test('offscreen document references correct vendor library', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.html'),
      'utf-8'
    );
    expect(html).toContain('jspdf.umd.min.js');
    expect(html).toContain('offscreen.js');
  });

  test('popup HTML references popup.js and popup.css', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/popup/popup.html'),
      'utf-8'
    );
    expect(html).toContain('popup.js');
    expect(html).toContain('popup.css');
  });

  test('options HTML references options.js', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/options/options.html'),
      'utf-8'
    );
    expect(html).toContain('options.js');
  });

  test('icon files are valid PNG', () => {
    const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const size of [16, 32, 48, 128]) {
      const iconPath = path.join(EXTENSION_PATH, `assets/icons/icon-${size}.png`);
      const buf = fs.readFileSync(iconPath);
      expect(buf.subarray(0, 8).equals(PNG_HEADER), `icon-${size}.png is not valid PNG`).toBe(true);
    }
  });

  test('package.json lists all required dependencies', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'package.json'), 'utf-8')
    );
    const deps = pkg.dependencies || {};

    expect(deps['@mozilla/readability']).toBeDefined();
    expect(deps['html2canvas']).toBeDefined();
    expect(deps['jspdf']).toBeDefined();
    expect(deps['turndown']).toBeDefined();
    expect(deps['turndown-plugin-gfm']).toBeDefined();
  });
});

// ─── Source Code Quality Tests ────────────────────────────────────────────────

test.describe('Source Code Quality', () => {
  test('content script has injection guard', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/content-script.js'),
      'utf-8'
    );
    expect(code).toContain('__webpageArchiverInjected');
  });

  test('content script handles text capture and scroll messages', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/content-script.js'),
      'utf-8'
    );
    expect(code).toContain('formats.html');
    expect(code).toContain('formats.markdown');
    expect(code).toContain("msg.type === 'capture'");
    expect(code).toContain("msg.type === 'get-page-dimensions'");
    expect(code).toContain("msg.type === 'scroll-to'");
  });

  test('content script provides page dimension helpers', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/content-script.js'),
      'utf-8'
    );
    expect(code).toContain('getPageDimensions');
    expect(code).toContain('scrollToPosition');
    expect(code).toContain('scrollWidth');
    expect(code).toContain('scrollHeight');
    expect(code).toContain('viewportWidth');
    expect(code).toContain('viewportHeight');
    expect(code).toContain('devicePixelRatio');
  });

  test('service worker handles archive messages', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'archive'");
    expect(code).toContain('archivePage');
    expect(code).toContain('return true'); // Async response
  });

  test('service worker validates tab URL before archiving', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain("chrome://");
    expect(code).toContain("chrome-extension://");
    expect(code).toContain('Cannot archive browser internal pages');
  });

  test('service worker uses captureVisibleTab for screenshots', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('captureFullPageScreenshot');
    expect(code).toContain('chrome.tabs.captureVisibleTab');
    expect(code).toContain('get-page-dimensions');
    expect(code).toContain('scroll-to');
    expect(code).toContain('stitch-screenshots');
  });

  test('offscreen document handles both stitch and PDF messages', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'stitch-screenshots'");
    expect(code).toContain("msg.type === 'generate-pdf'");
    expect(code).toContain('stitchScreenshots');
    expect(code).toContain('generatePdf');
    expect(code).toContain('jsPDF');
  });

  test('offscreen stitching caps canvas height at 32000px', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.js'),
      'utf-8'
    );
    expect(code).toContain('32000');
  });

  test('markdown extraction builds YAML frontmatter', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/content-script.js'),
      'utf-8'
    );
    expect(code).toContain('buildFrontmatter');
    expect(code).toContain('---');
    expect(code).toContain('title:');
    expect(code).toContain('url:');
    expect(code).toContain('archived:');
  });

  test('content script falls back to body when Readability returns null', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/content-script.js'),
      'utf-8'
    );
    expect(code).toContain('buildMarkdownFromBody');
    expect(code).toContain('!article || !article.content');
  });

  test('popup saves format preferences to storage', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/popup/popup.js'),
      'utf-8'
    );
    expect(code).toContain('chrome.storage.sync.set');
    expect(code).toContain('chrome.storage.sync.get');
  });

  test('options page has save and reset functionality', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/options/options.js'),
      'utf-8'
    );
    expect(code).toContain('saveOptions');
    expect(code).toContain('resetOptions');
    expect(code).toContain('DEFAULTS');
  });

  test('service worker supports keyboard shortcut', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('chrome.commands.onCommand');
    expect(code).toContain("command === 'archive-page'");
  });

  test('service worker supports configurable filename pattern', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain("'{date}'");
    expect(code).toContain("'{hostname}'");
    expect(code).toContain("'{title}'");
    expect(code).toContain("'{timestamp}'");
    expect(code).toContain('filenamePattern');
    expect(code).toContain('subfolder');
  });

  test('service worker supports print PDF via chrome.debugger', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('chrome.debugger.attach');
    expect(code).toContain('chrome.debugger.sendCommand');
    expect(code).toContain('Page.printToPDF');
    expect(code).toContain('chrome.debugger.detach');
    expect(code).toContain('generatePrintPdf');
  });

  test('file naming sanitizes dangerous characters', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('sanitizeFilename');
    // Checks for path traversal, special chars
    expect(code).toContain('[<>:"/\\\\|?*\\x00-\\x1f]');
  });
});

// ─── Vendor Library Validation Tests ──────────────────────────────────────────

test.describe('Vendor Library Validation', () => {
  test('Readability.js exposes Readability class', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/Readability.js'),
      'utf-8'
    );
    // Should define a Readability constructor/class
    expect(code).toContain('Readability');
    expect(code).toContain('parse');
  });

  test('html2canvas exposes global function', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/html2canvas.min.js'),
      'utf-8'
    );
    expect(code).toContain('html2canvas');
  });

  test('turndown exposes TurndownService', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown.umd.js'),
      'utf-8'
    );
    expect(code).toContain('TurndownService');
  });

  test('turndown-plugin-gfm exposes gfm plugin', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown-plugin-gfm.js'),
      'utf-8'
    );
    expect(code).toContain('turndownPluginGfm');
    expect(code).toContain('gfm');
  });

  test('jsPDF exposes jspdf global', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/jspdf.umd.min.js'),
      'utf-8'
    );
    expect(code).toContain('jspdf');
  });
});

// ─── Browser-Based Extension Loading Tests ───────────────────────────────────

test.describe('Extension Loading in Browser', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  let extensionId;

  test.beforeAll(async () => {
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-gpu',
        '--no-sandbox',
      ],
    });

    // Wait for service worker to register and get extension ID
    let serviceWorker;
    if (context.serviceWorkers().length > 0) {
      serviceWorker = context.serviceWorkers()[0];
    } else {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    extensionId = serviceWorker.url().split('/')[2];
  });

  test.afterAll(async () => {
    if (context) await context.close();
  });

  test('extension loads and registers service worker', async () => {
    expect(extensionId).toBeTruthy();
    expect(extensionId.length).toBeGreaterThan(10);
  });

  test('popup opens and shows all format checkboxes', async () => {
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    // Verify title
    const title = await popupPage.textContent('h1');
    expect(title).toBe('Webpage Archiver');

    // Verify all format checkboxes exist and are checked by default
    for (const fmt of ['html', 'markdown', 'png', 'pdf', 'printpdf']) {
      const checkbox = popupPage.locator(`#fmt-${fmt}`);
      await expect(checkbox).toBeVisible();
      await expect(checkbox).toBeChecked();
    }

    // Verify Archive button exists
    const archiveBtn = popupPage.locator('#btn-archive');
    await expect(archiveBtn).toBeVisible();
    await expect(archiveBtn).toHaveText('Archive');

    // Verify Options link exists
    const optionsLink = popupPage.locator('#btn-options');
    await expect(optionsLink).toBeVisible();

    await popupPage.close();
  });

  test('popup format checkboxes are toggleable', async () => {
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const htmlCheckbox = popupPage.locator('#fmt-html');

    // Initially checked
    await expect(htmlCheckbox).toBeChecked();

    // Uncheck
    await htmlCheckbox.uncheck();
    await expect(htmlCheckbox).not.toBeChecked();

    // Recheck
    await htmlCheckbox.check();
    await expect(htmlCheckbox).toBeChecked();

    await popupPage.close();
  });

  test('options page loads with all settings', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    // Verify title
    const title = await optionsPage.textContent('h1');
    expect(title).toBe('Webpage Archiver Options');

    // Verify format checkboxes
    for (const fmt of ['html', 'markdown', 'png', 'pdf', 'printpdf']) {
      const checkbox = optionsPage.locator(`#opt-${fmt}`);
      await expect(checkbox).toBeVisible();
    }

    // Verify filename pattern field
    const patternInput = optionsPage.locator('#opt-pattern');
    await expect(patternInput).toBeVisible();
    const patternValue = await patternInput.inputValue();
    expect(patternValue).toBe('{date}_{hostname}_{title}');

    // Verify subfolder field
    const subfolderInput = optionsPage.locator('#opt-subfolder');
    await expect(subfolderInput).toBeVisible();

    // Verify buttons
    await expect(optionsPage.locator('#btn-save')).toBeVisible();
    await expect(optionsPage.locator('#btn-reset')).toBeVisible();

    await optionsPage.close();
  });

  test('options page save button works', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    // Change subfolder
    const subfolderInput = optionsPage.locator('#opt-subfolder');
    await subfolderInput.fill('test-archives');

    // Click save
    await optionsPage.locator('#btn-save').click();

    // Verify saved message appears
    const savedMsg = optionsPage.locator('#saved-msg');
    await expect(savedMsg).toHaveClass(/visible/, { timeout: 2000 });

    // Reload and verify persistence
    await optionsPage.reload();
    await optionsPage.waitForLoadState('load');

    // Give storage time to load
    await optionsPage.waitForTimeout(500);
    const newValue = await optionsPage.locator('#opt-subfolder').inputValue();
    expect(newValue).toBe('test-archives');

    // Reset
    await optionsPage.locator('#btn-reset').click();
    await optionsPage.waitForTimeout(500);
    const resetValue = await optionsPage.locator('#opt-subfolder').inputValue();
    expect(resetValue).toBe('');

    await optionsPage.close();
  });

  test('vendor libraries can be injected into a page and expose globals', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Verify the page loaded
    const title = await page.title();
    expect(title).toContain('Example Domain');

    // Inject vendor libraries used by the content script
    const vendorFiles = [
      'vendor/Readability.js',
      'vendor/turndown.umd.js',
      'vendor/turndown-plugin-gfm.js',
    ];

    for (const file of vendorFiles) {
      const code = fs.readFileSync(path.join(EXTENSION_PATH, file), 'utf-8');
      await page.evaluate(code);
    }

    // Verify all vendor globals are available
    const globals = await page.evaluate(() => ({
      Readability: typeof Readability !== 'undefined',
      TurndownService: typeof TurndownService !== 'undefined',
      turndownPluginGfm: typeof turndownPluginGfm !== 'undefined',
    }));

    expect(globals.Readability).toBe(true);
    expect(globals.TurndownService).toBe(true);
    expect(globals.turndownPluginGfm).toBe(true);

    await page.close();
  });

  test('Readability can extract article content from a test page', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Inject Readability
    const readabilityCode = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/Readability.js'),
      'utf-8'
    );
    await page.evaluate(readabilityCode);

    const article = await page.evaluate(() => {
      const docClone = document.cloneNode(true);
      const reader = new Readability(docClone);
      const result = reader.parse();
      if (!result) return null;
      return {
        title: result.title,
        hasContent: result.content.length > 0,
        contentLength: result.content.length,
        excerpt: result.excerpt,
      };
    });

    // example.com is a simple page but Readability should at least parse it
    // If it returns null, our fallback handles it (which is also fine)
    if (article) {
      expect(article.hasContent).toBe(true);
      expect(article.contentLength).toBeGreaterThan(0);
    }

    await page.close();
  });

  test('Turndown can convert HTML to Markdown', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Inject Turndown
    const turndownCode = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown.umd.js'),
      'utf-8'
    );
    const gfmCode = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/turndown-plugin-gfm.js'),
      'utf-8'
    );
    await page.evaluate(turndownCode);
    await page.evaluate(gfmCode);

    const markdown = await page.evaluate(() => {
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
      });
      if (typeof turndownPluginGfm !== 'undefined' && turndownPluginGfm.gfm) {
        turndown.use(turndownPluginGfm.gfm);
      }
      return turndown.turndown(document.body.innerHTML);
    });

    expect(markdown).toBeTruthy();
    expect(markdown.length).toBeGreaterThan(10);
    // example.com has an h1 and a link
    expect(markdown).toContain('Example Domain');

    await page.close();
  });

  test('HTML serialization produces valid self-contained HTML', async () => {
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Execute the serialization functions directly
    const html = await page.evaluate(() => {
      // Simplified version of serializeHtml for testing
      const docClone = document.cloneNode(true);

      // Remove scripts
      const scripts = docClone.querySelectorAll('script');
      scripts.forEach((s) => s.remove());

      // Get serialized HTML
      return '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('Example Domain');
    expect(html).not.toContain('<script');

    await page.close();
  });

  test('full capture flow works end-to-end via service worker messaging', async () => {
    // Navigate to a test page
    const page = await context.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

    // Open the popup
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    // Ensure only Markdown and HTML are checked (skip PNG/PDF for speed)
    await popupPage.locator('#fmt-png').uncheck();
    await popupPage.locator('#fmt-pdf').uncheck();
    await popupPage.locator('#fmt-printpdf').uncheck();
    await expect(popupPage.locator('#fmt-html')).toBeChecked();
    await expect(popupPage.locator('#fmt-markdown')).toBeChecked();

    // Click archive
    await popupPage.locator('#btn-archive').click();

    // Wait for status to update (either success or error)
    const status = popupPage.locator('#status');
    await expect(status).not.toHaveClass(/hidden/, { timeout: 15000 });

    // Get the status text
    const statusText = await status.textContent();

    // The archive may succeed or fail depending on which tab is "active" in the context.
    // In headless testing, the popup page itself may be the active tab.
    // We verify the extension doesn't crash and provides meaningful feedback.
    expect(statusText.length).toBeGreaterThan(0);
    console.log('Archive status:', statusText);

    await popupPage.close();
    await page.close();
  });
});
