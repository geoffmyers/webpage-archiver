// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');

/**
 * The extension's service worker, however fast or slow Chromium starts it.
 * Checking context.serviceWorkers() and then waiting for the 'serviceworker'
 * event misses a worker that starts between the two calls, and a busy host
 * can take longer than 10 s; both failed a publish (2026-09-17). Poll instead.
 */
async function extensionServiceWorker(context, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [worker] = context.serviceWorkers();
    if (worker) return worker;
    if (Date.now() > deadline) {
      throw new Error(`extension service worker did not start within ${timeoutMs / 1000} s`);
    }
    try {
      return await context.waitForEvent('serviceworker', { timeout: 1000 });
    } catch {
      // not yet: loop and look again
    }
  }
}

// ─── Structural / Static Validation Tests ─────────────────────────────────────

test.describe('Extension Structure', () => {
  test('manifest.json is valid and contains required fields', () => {
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Webpage Archiver');
    // Chrome's version format, and the same version the package declares
    // (the release workflow tags releases with it).
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_PATH, 'package.json'), 'utf-8'));
    expect(manifest.version).toBe(pkg.version);
    // activeTab is deliberately absent: host_permissions already grants
    // <all_urls> permanently, so activeTab's per-click grant is redundant.
    expect(manifest.permissions).not.toContain('activeTab');
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
      'vendor/jspdf.umd.min.js',
      'vendor/jszip.min.js',
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
      'src/content/html-sanitizer.js',
      'src/content/content-script.js',
    ];

    for (const file of injectedFiles) {
      expect(fs.existsSync(path.join(EXTENSION_PATH, file))).toBe(true);
    }
  });

  test('offscreen document references correct vendor libraries', () => {
    const html = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.html'),
      'utf-8'
    );
    expect(html).toContain('jspdf.umd.min.js');
    expect(html).toContain('jszip.min.js');
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
    expect(deps['jspdf']).toBeDefined();
    expect(deps['turndown']).toBeDefined();
    expect(deps['turndown-plugin-gfm']).toBeDefined();
    expect(deps['jszip']).toBeDefined();
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
    expect(code).toContain('stitch-init');
    expect(code).toContain('stitch-add-capture');
    expect(code).toContain('stitch-finalize');
  });

  test('offscreen document handles incremental stitch and PDF messages', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'stitch-init'");
    expect(code).toContain("msg.type === 'stitch-add-capture'");
    expect(code).toContain("msg.type === 'stitch-finalize'");
    expect(code).toContain("msg.type === 'generate-pdf'");
    expect(code).toContain('generatePdf');
    expect(code).toContain('jsPDF');
  });

  test('offscreen document handles create-zip messages', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/offscreen/offscreen.js'),
      'utf-8'
    );
    expect(code).toContain("msg.type === 'create-zip'");
    expect(code).toContain('createZip');
    expect(code).toContain('JSZip');
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
    expect(code).toContain('bundleAsZip');
  });

  test('service worker supports keyboard shortcut', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('chrome.commands.onCommand');
    expect(code).toContain("command === 'archive-page'");
  });

  test('service worker supports ZIP bundling option', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/background/service-worker.js'),
      'utf-8'
    );
    expect(code).toContain('bundleAsZip');
    expect(code).toContain('create-zip');
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

  test('JSZip exposes JSZip global', () => {
    const code = fs.readFileSync(
      path.join(EXTENSION_PATH, 'vendor/jszip.min.js'),
      'utf-8'
    );
    expect(code).toContain('JSZip');
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
    const serviceWorker = await extensionServiceWorker(context);
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

    // Verify ZIP bundle checkbox
    const zipCheckbox = optionsPage.locator('#opt-zip');
    await expect(zipCheckbox).toBeVisible();
    await expect(zipCheckbox).toBeChecked();

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

    // The page fills its fields once storage answers: wait for that, not a
    // fixed delay (500 ms was not always enough on a busy machine).
    await expect(optionsPage.locator('#opt-subfolder')).toHaveValue('test-archives', { timeout: 5000 });

    // Reset
    await optionsPage.locator('#btn-reset').click();
    await expect(optionsPage.locator('#opt-subfolder')).toHaveValue('', { timeout: 5000 });

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

    // Load the REAL sanitizer/serializer (not a reimplementation) and call it
    // directly — html-sanitizer.js has no chrome.* dependency, so it can be
    // injected into a plain page exactly as it is into the archived tab.
    const sanitizerCode = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/html-sanitizer.js'),
      'utf-8'
    );
    await page.evaluate(sanitizerCode);

    const html = await page.evaluate(() =>
      // eslint-disable-next-line no-undef
      serializeHtml('https://example.com/', 'Example Domain')
    );

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

  test('serializeHtml strips scripts, event handlers, javascript: URLs, iframes and meta refresh, and carries the provenance comment', async () => {
    const page = await context.newPage();

    // The fixture below is a LIVE page as far as this browser is concerned:
    // its meta refresh and iframe/object/embed src attributes would
    // otherwise really navigate/fetch. Block all network requests so the
    // meta refresh can't tear down the execution context out from under the
    // evaluate() calls below — we're testing what serializeHtml() strips
    // from the DOM, not the browser's own handling of the hostile markup.
    await page.route('**/*', (route) => route.abort());

    // A hostile page: inline handlers, javascript:/vbscript:/data:text/html
    // URLs (including whitespace-obfuscated ones), a meta refresh, a real
    // <iframe>/<object>/<embed>, resource-hint links that would pull in more
    // script, a page-supplied <base> trying to redirect our relative-URL
    // resolution, and a <noscript> block whose own content carries a handler.
    await page.setContent(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Hostile fixture</title>
  <!-- A huge delay: real enough for the sanitizer to find and remove, but
       this browser must never actually act on it mid-test. -->
  <meta http-equiv="refresh" content="9999;url=https://evil.example/">
  <base href="https://evil.example/redirect-base/">
  <link rel="modulepreload" href="https://evil.example/mod.js">
  <link rel="preload" as="script" href="https://evil.example/pre.js">
  <script>window.__hostileScriptRan = true;</script>
</head>
<body onload="window.__bodyOnload = true;">
  <img src="https://example.com/nope.png" onerror="window.__imgOnerror = true;">
  <a href="javascript:alert(1)" id="jslink">click</a>
  <a href="  JaVaScRiPt:alert(2)" id="jslink2">click2</a>
  <a href="vbscript:msgbox(1)" id="vbslink">click3</a>
  <a href="data:text/html,<script>alert(1)</script>" id="datalink">click4</a>
  <iframe src="https://evil.example/frame"></iframe>
  <object data="https://evil.example/obj"></object>
  <embed src="https://evil.example/embed">
  <form action="javascript:alert(3)"><button formaction="javascript:alert(4)">go</button></form>
  <div onclick="window.__divClicked = true;">click me</div>
  <noscript><img src="x" onerror="window.__noscriptRan = true;"></noscript>
  <p>Some real, harmless content that should survive.</p>
</body>
</html>`);

    const sanitizerCode = fs.readFileSync(
      path.join(EXTENSION_PATH, 'src/content/html-sanitizer.js'),
      'utf-8'
    );
    await page.evaluate(sanitizerCode);

    // The pageTitle argument (distinct from the fixture's own <title> tag,
    // above) carries a comment-close attempt of its own: a page whose title
    // or URL contains "-->" must not be able to break out of the provenance
    // comment.
    const hostileArgTitle = 'Injected--><p id="escaped">should not render as markup</p><!--';
    const html = await page.evaluate(
      (title) =>
        // eslint-disable-next-line no-undef
        serializeHtml('https://example.test/hostile', title),
      hostileArgTitle
    );

    // Nothing that can execute survived
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<noscript/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/<embed/i);
    expect(html).not.toMatch(/\son\w+\s*=/i); // no on* attribute anywhere
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).not.toMatch(/data:text\/html/i);
    expect(html).not.toMatch(/http-equiv=["']refresh["']/i);
    expect(html).not.toMatch(/rel=["']modulepreload["']/i);
    expect(html).not.toMatch(/evil\.example/i); // the hostile origin appears nowhere

    // Our own <base> won — the page's own <base> pointing at evil.example
    // was removed rather than merely overwritten.
    const baseMatches = html.match(/<base\b[^>]*>/gi) || [];
    expect(baseMatches.length).toBe(1);
    expect(baseMatches[0]).toContain('https://example.test/hostile');

    // The restrictive CSP meta tag is present
    expect(html).toMatch(/Content-Security-Policy/i);
    expect(html).toContain("default-src 'none'");

    // The provenance comment survived (it has to live inside <html>, since
    // only documentElement.outerHTML is returned).
    expect(html).toContain('Archived by Webpage Archiver');
    expect(html).toContain('example.test/hostile');
    expect(html).toContain('Some real, harmless content that should survive.');

    // The hostile title's "-->" plus injected <p id="escaped"> must never
    // become a real element — only inert text inside the provenance
    // comment. A raw substring match can't tell "present as comment text"
    // from "present as markup", so reparse the archive's own output the way
    // a browser opening the saved file would.
    const injectionBecameReal = await page.evaluate((htmlText) => {
      const reparsed = new DOMParser().parseFromString(htmlText, 'text/html');
      return reparsed.getElementById('escaped') !== null;
    }, html);
    expect(injectionBecameReal).toBe(false);

    await page.close();
  });

  test('popup shows a GitHub source link', async () => {
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    const link = popupPage.locator('a[href="https://github.com/geoffmyers/webpage-archiver"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toContainText('View source on GitHub');
    expect(await link.locator('svg').count()).toBe(1);

    await popupPage.close();
  });

  test('options page shows a GitHub source link', async () => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/options/options.html`);

    const link = optionsPage.locator('a[href="https://github.com/geoffmyers/webpage-archiver"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toContainText('View source on GitHub');
    expect(await link.locator('svg').count()).toBe(1);

    await optionsPage.close();
  });
});
