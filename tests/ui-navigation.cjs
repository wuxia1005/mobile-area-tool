const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

function playwrightRuntime() {
  const directories = [process.env.CODEX_WORKSPACE_NODE_MODULES, path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules')].filter(Boolean);
  for (const candidate of ['playwright', ...directories.map(directory => path.join(directory, 'playwright'))]) {
    try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('找不到 Playwright，請設定 CODEX_WORKSPACE_NODE_MODULES。');
}

(async () => {
  const { chromium } = playwrightRuntime();
  const deployment = process.argv[2] || 'http://127.0.0.1:4173/';
  const origin = new URL(deployment).origin;
  const directory = path.resolve(__dirname, '..');
  const output = path.join(directory, 'test-results', 'ui-1.4');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, colorScheme: 'light', serviceWorkers: 'block' });
    const requests = [];
    const errors = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (/^(blob:|data:)/.test(request.url()) || new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      requests.push({ url: request.url(), method: request.method() });
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(deployment);
    assert.equal((await page.locator('.version').textContent()).trim(), '1.4');
    assert.equal(await page.locator('#step-import').isEnabled(), true);
    await page.screenshot({ path: path.join(output, 'import-phone.png'), fullPage: true });
    await page.locator('#manual').click();
    await page.locator('#step-import').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-screen="import"]').isVisible(), true);
    await page.locator('#manual').click();
    for (const [field, value] of Object.entries({ main: '70', accessory: '10', common: '50', parking: '20' })) await page.locator(`#field-${field}`).fill(value);
    await page.locator('#scope').selectOption('household');
    await page.locator('#inclusion').selectOption('included');
    await page.locator('#confirmed').check();
    await page.locator('#calculate').click();
    assert.equal(await page.locator('[data-result="without"]').textContent(), '33.28 坪');
    assert.equal(await page.locator('[data-result="ratio"]').textContent(), '27.27%');
    assert.equal(await page.locator('.result-unit').count(), 7);
    assert.equal(await page.locator('[data-result="without"] .result-unit').textContent(), ' 坪');
    assert.equal(await page.locator('[data-result="ratio"] .result-unit').textContent(), '%');
    const layout = [];
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [320, 390, 736]) {
        await page.setViewportSize({ width, height: 1000 });
        const sizes = await page.evaluate(() => ({
          width: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          totalFont: parseFloat(getComputedStyle(document.querySelector('.total strong')).fontSize),
          metricLayout: getComputedStyle(document.querySelector('.results')).display,
          totalBackground: getComputedStyle(document.querySelector('.total')).backgroundColor,
          detailFonts: [...document.querySelectorAll('.results dd')].map(value => parseFloat(getComputedStyle(value).fontSize)),
          valueOverflow: [...document.querySelectorAll('.total strong, .results dd')].some(value => value.scrollWidth > value.clientWidth + 1)
        }));
        assert.ok(sizes.documentWidth <= width + 1, JSON.stringify(sizes));
        assert.ok(sizes.totalFont >= 40);
        assert.equal(sizes.metricLayout, 'block');
        assert.equal(sizes.totalBackground, 'rgba(0, 0, 0, 0)');
        assert.ok(sizes.detailFonts.every(size => size >= 21));
        assert.equal(sizes.valueOverflow, false);
        layout.push({ scheme, ...sizes });
      }
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.screenshot({ path: path.join(output, `result-${scheme}-phone.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#step-import').click();
    assert.equal(await page.locator('[data-screen="import"]').isVisible(), true);
    assert.equal(await page.locator('#confirmed').isChecked(), false);
    assert.equal(await page.locator('#calculate').isDisabled(), true);
    await page.locator('#file-input').setInputFiles(path.join(directory, 'test-results', 'synthetic-area.xlsx'));
    await page.locator('#selection').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-step="import"]').getAttribute('aria-current'), 'step');
    await page.locator('#step-import').click();
    assert.equal(await page.locator('[data-screen="import"]').isVisible(), true);
    let releaseWorker;
    const workerReady = new Promise(resolve => { releaseWorker = resolve; });
    let requestedWorker;
    const workerRequested = new Promise(resolve => { requestedWorker = resolve; });
    await page.route('**/vendor/tesseract/worker.min.js', async route => {
      requestedWorker();
      await workerReady;
      await route.continue();
    });
    await page.locator('#file-input').setInputFiles(path.join(directory, 'test-results', 'synthetic-area.png'));
    await page.locator('#processing').waitFor({ state: 'visible' });
    await workerRequested;
    await page.locator('#step-import').click();
    assert.equal(await page.locator('[data-screen="import"]').isVisible(), true);
    releaseWorker();
    await page.waitForFunction(() => document.querySelector('#file-input') && !document.querySelector('[data-screen="import"]').hidden);
    await page.locator('#manual').click();
    assert.equal(await page.locator('[data-screen="review"]').isVisible(), true);
    assert.equal(await page.locator('#confirmed').isChecked(), false);
    assert.equal(await page.locator('#field-main').inputValue(), '');
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    const report = { deployment, checkedAt: new Date().toISOString(), result: 'passed', design: 'A 經典金融', layout, checks: ['version 1.4', 'classic white vertical result layout', 'small units preserve exact result text', 'keyboard import navigation', 'result to import invalidates confirmation', 'range selection to import', 'processing cancellation via header', 'large result fonts', 'light and dark responsive layout', 'no off-origin requests or uploads', 'no page errors'] };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
