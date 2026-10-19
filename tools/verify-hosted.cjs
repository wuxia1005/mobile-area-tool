const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

function playwrightRuntime() {
  const modules = [
    process.env.CODEX_WORKSPACE_NODE_MODULES,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules')
  ].filter(Boolean);
  const candidates = ['playwright', ...modules.map(directory => path.join(directory, 'playwright'))];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('找不到 Playwright。請設定 CODEX_WORKSPACE_NODE_MODULES 指向已安裝 Playwright 的 node_modules。');
}

function deploymentUrl(argument) {
  if (!argument) throw new Error('用法：node tools/verify-hosted.cjs https://example.github.io/repository/');
  const url = new URL(argument);
  assert.ok(['https:', 'http:'].includes(url.protocol), '網址須使用 HTTPS 或 HTTP。');
  assert.equal(url.username + url.password, '', '測試網址不可包含帳號或密碼。');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/index\.html$/, '/');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function assertSourceScreenshots(page, expectedCount) {
  assert.equal(await page.locator('#read-warnings, #source-records').count(), 0);
  const details = page.locator('#source-details');
  assert.equal(await details.getAttribute('open'), null);
  assert.equal((await details.locator(':scope > summary').textContent()).trim(), '查看來源截圖');
  await details.locator(':scope > summary').click();
  const imageCount = await page.locator('#source-images img').count();
  assert.ok(imageCount > 0);
  if (expectedCount !== undefined) assert.equal(imageCount, expectedCount);
  await page.waitForFunction(() => [...document.querySelectorAll('#source-images img')].every(image => image.complete && image.naturalWidth > 0));
  assert.equal((await page.locator('#source-images').textContent()).trim(), '');
  assert.equal(await details.locator('pre, .source-row, p').count(), 0);
  await details.locator(':scope > summary').click();
}

async function readExportedSource(page, output, name) {
  await page.locator('#scope').selectOption('household');
  await page.locator('#parking-scope').selectOption('household');
  await page.locator('#inclusion').selectOption('included');
  for (const [field, value] of Object.entries({ main: '70', accessory: '10', common: '50', parking: '20' })) {
    await page.locator(`#field-${field}`).fill(value);
    await page.locator(`[data-area-field="${field}"] .field-values select`).selectOption('sqm');
  }
  await page.locator('#confirmed').check();
  await page.locator('#calculate').click();
  await page.locator('#include-source').check();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export').click();
  const download = await downloadEvent;
  const downloadPath = path.join(output, name);
  await download.saveAs(downloadPath);
  const bytes = [...await fs.readFile(downloadPath)];
  const text = await page.evaluate(buffer => {
    const workbook = globalThis.XLSX.read(new Uint8Array(buffer));
    return JSON.stringify(globalThis.XLSX.utils.sheet_to_json(workbook.Sheets['原始讀取'], { header: 1 }));
  }, bytes);
  await page.locator('#edit').click();
  return text;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('用法：node tools/verify-hosted.cjs https://example.github.io/repository/');
    console.log('使用隱藏 Edge；只讀部署網站，不修改遠端。需先執行 browser-smoke 產生 test-results 內的合成圖片、PDF 與 Excel。');
    console.log('可設定 CODEX_WORKSPACE_NODE_MODULES、PLAYWRIGHT_BROWSER_EXECUTABLE、HOSTED_OCR_TIMEOUT_MS。');
    return;
  }
  const deployment = deploymentUrl(process.argv[2]);
  const project = path.resolve(__dirname, '..');
  const output = path.join(project, 'test-results', 'hosted');
  const fixtureDirectory = path.join(project, 'test-results');
  const fixtures = {};
  for (const [kind, name] of Object.entries({ image: 'synthetic-area.png', pdf: 'synthetic-visible.pdf', excel: 'synthetic-area.xlsx', transcript: 'synthetic-transcript.xlsx', ambiguous: 'synthetic-transcript-ambiguous.xlsx', transcriptPdf: 'synthetic-transcript.pdf', multiplePdf: 'synthetic-transcript-multiple.pdf' })) {
    try {
      fixtures[kind] = await fs.readFile(path.join(fixtureDirectory, name));
    } catch {
      throw new Error(`缺少本機合成測試檔 test-results/${name}。請先執行本機 browser-smoke 測試產生，不要替換成私人文件。`);
    }
  }
  await fs.mkdir(output, { recursive: true });
  const { chromium } = playwrightRuntime();
  const executable = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : { channel: 'msedge' }) });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
  const pageErrors = [];
  const consoleErrors = [];
  const requests = [];
  const offOrigin = [];
  const outsideBasePath = [];
  const uploads = [];
  const failedRequests = [];
  const failedResponses = [];
  const checks = [];
  const localUrl = url => /^(?:blob:|data:|about:)/.test(url);
  context.on('request', request => {
    const url = request.url();
    if (localUrl(url)) return;
    const parsed = new URL(url);
    const entry = { url, method: request.method(), resourceType: request.resourceType() };
    requests.push(entry);
    if (parsed.origin !== deployment.origin) offOrigin.push(entry);
    else if (!parsed.pathname.startsWith(deployment.pathname)) outsideBasePath.push(entry);
    if (!['GET', 'HEAD'].includes(request.method())) uploads.push(entry);
  });
  context.on('requestfailed', request => {
    if (!localUrl(request.url())) failedRequests.push({ url: request.url(), failure: request.failure()?.errorText });
  });
  context.on('response', response => {
    if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() });
  });
  await context.route('**/*', route => {
    const request = route.request();
    if (localUrl(request.url())) return route.continue();
    const parsed = new URL(request.url());
    if (parsed.origin !== deployment.origin || !['GET', 'HEAD'].includes(request.method())) return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const ocrTimeout = Math.max(30000, Number(process.env.HOSTED_OCR_TIMEOUT_MS) || 240000);
  const waitForReview = async () => {
    await page.waitForFunction(() => {
      const review = document.querySelector('[data-screen="review"]');
      const error = document.getElementById('global-error');
      return Boolean(review && !review.hidden) || Boolean(error && !error.hidden);
    }, undefined, { timeout: ocrTimeout });
    assert.equal(await page.locator('#global-error').isVisible(), false, await page.locator('#global-error').textContent());
    assert.equal(await page.locator('[data-screen="review"]').isVisible(), true);
  };
  const backToImport = async () => {
    if (await page.locator('[data-screen="review"]').isVisible()) await page.locator('#back-import').click();
    await page.locator('[data-screen="import"]').waitFor({ state: 'visible' });
  };
  try {
    const response = await page.goto(deployment.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    assert.ok(response?.ok(), `首頁回應異常：${response?.status()}`);
    await page.locator('#manual').waitFor({ state: 'visible' });
    await page.waitForFunction(() => typeof globalThis.XLSX?.read === 'function' && typeof globalThis.Tesseract?.createWorker === 'function');
    assert.equal(await page.locator('h1').textContent(), '房屋面積小工具');
    assert.equal(await page.locator('#transcript-mode').isChecked(), true);
    for (const kind of ['pdf', 'image', 'excel']) assert.equal(await page.locator(`[data-pick="${kind}"]`).isVisible(), true);
    assert.equal(new URL(page.url()).origin, deployment.origin);
    assert.ok(new URL(page.url()).pathname.startsWith(deployment.pathname));
    checks.push('部署子路徑首頁與 PDF／圖片／Excel 元件可用');

    await page.locator('#manual').click();
    for (const [field, value] of Object.entries({ main: '70', accessory: '10', common: '50', parking: '20' })) await page.locator(`#field-${field}`).fill(value);
    await page.locator('#scope').selectOption('household');
    await page.locator('#inclusion').selectOption('included');
    await page.locator('#confirmed').check();
    await page.locator('#calculate').click();
    assert.equal(await page.locator('[data-result="without"]').textContent(), '33.28 坪');
    assert.equal(await page.locator('[data-result="ratio"]').textContent(), '27.27%');
    assert.equal(await page.locator('.steps li').count(), 2);
    assert.equal(await page.locator('[data-screen="review"]').isVisible(), true);
    assert.equal(await page.locator('[data-screen="review"] #result-panel').isVisible(), true);
    assert.equal(await page.locator('#field-main').isVisible(), true);
    await page.screenshot({ path: path.join(output, 'manual-phone.png'), fullPage: true });
    checks.push('手動 70／10／50／20 ㎡、共有含車位＝33.28 坪／27.27%');
    checks.push('核對與結果合併為同一頁，兩步驟導覽且輸入欄位保持可見');

    await page.locator('#edit').click();
    for (const [field, value] of Object.entries({ main: '60', accessory: '5', common: '10000' })) await page.locator(`#field-${field}`).fill(value);
    await page.locator('#scope').selectOption('whole');
    await page.locator('#share-numerator').fill('600'); await page.locator('#share-denominator').fill('100000');
    await page.locator('#parking-scope').selectOption('common');
    await page.locator('#parking-share-numerator').fill('300'); await page.locator('#parking-share-denominator').fill('100000');
    assert.equal(await page.locator('#share-confirmed').isChecked(), false);
    assert.equal(await page.locator('#parking-share-confirmed').isChecked(), false);
    await page.locator('#share-confirmed').check(); await page.locator('#parking-share-confirmed').check();
    await page.locator('#confirmed').check(); await page.locator('#calculate').click();
    assert.equal(await page.locator('[data-result="with"]').textContent(), '37.81 坪');
    assert.equal(await page.locator('[data-result="without"]').textContent(), '28.74 坪');
    assert.match(await page.locator('#summary').inputValue(), /車位持分：300／100000/);
    await page.screenshot({ path: path.join(output, 'ownership-phone.png'), fullPage: true });
    checks.push('共有及車位持分分別乘共有總面積、獨立確認與摘要追溯');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-area.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fixtures.excel });
    await page.locator('#selection').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#excel-sheet option').count(), 1);
    await page.locator('#start-read').click();
    await waitForReview();
    assert.equal(await page.locator('#field-main').inputValue(), '70');
    assert.equal(await page.locator('#field-parking').inputValue(), '20');
    await assertSourceScreenshots(page);
    assert.ok(!(await readExportedSource(page, output, 'excel-source-check.xlsx')).includes('SECRET'));
    checks.push('合成 Excel 顯示可見儲存格截圖；匯出來源排除隱藏內容');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-transcript.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fixtures.transcript });
    await page.locator('#selection').waitFor({ state: 'visible' }); await page.locator('#start-read').click(); await waitForReview();
    for (const [field, value] of Object.entries({ main: '60.00', accessory: '5.00', common: '10000.00' })) assert.equal(await page.locator(`#field-${field}`).inputValue(), value);
    assert.equal(await page.locator('#share-numerator').inputValue(), '600');
    assert.equal(await page.locator('#parking-share-numerator').inputValue(), '300');
    assert.equal(await page.locator('#scope').inputValue(), 'whole');
    assert.equal(await page.locator('#parking-scope').inputValue(), 'common');
    for (const id of ['confirmed', 'share-confirmed', 'parking-share-confirmed']) assert.equal(await page.locator(`#${id}`).isChecked(), false);
    assert.equal(await page.locator('#inclusion').inputValue(), 'unknown');
    assert.equal(await page.locator('#calculate').isDisabled(), true);
    await assertSourceScreenshots(page);
    const candidateSources = page.locator('.field-evidence:not([hidden])');
    assert.equal(await candidateSources.count(), 5);
    assert.equal(await page.locator('#transcript-candidates .candidate-source').count(), 0);
    for (const field of ['main', 'accessory', 'common']) assert.equal(await page.locator(`[data-source-field="${field}"].field-source`).isVisible(), false);
    for (const candidate of await candidateSources.all()) {
      await candidate.locator('img').first().waitFor({ state: 'attached' });
      assert.ok(await candidate.locator('img').count() > 0);
      await candidate.locator('img').first().evaluate(image => image.decode());
      assert.equal(await candidate.locator('p, pre, summary, select').count(), 0);
      assert.equal((await candidate.textContent()).trim(), '');
    }
    checks.push('五項來源截圖直接放在各自輸入處，沒有重複候選卡或長檔名來源文字；完整來源仍可展開');
    checks.push('單一謄本候選自動帶入，持分／車位關係與人工確認不自動勾選');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-transcript-ambiguous.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fixtures.ambiguous });
    await page.locator('#selection').waitFor({ state: 'visible' }); await page.locator('#start-read').click(); await waitForReview();
    for (const field of ['main', 'accessory', 'common', 'parking']) assert.equal(await page.locator(`#field-${field}`).inputValue(), '');
    assert.equal(await page.locator('#share-numerator').inputValue(), '');
    assert.equal(await page.locator('#parking-share-numerator').inputValue(), '');
    assert.equal(await page.locator('#apply-transcript').isDisabled(), true);
    assert.equal(await page.locator('#confirmed').isChecked(), false);
    assert.equal(await page.locator('#calculate').isDisabled(), true);
    assert.match(await page.locator('#transcript-candidates').textContent(), /多個建物|不能混用/);
    checks.push('多個建物標示部不自動帶入，不混用面積與持分');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-area.png', mimeType: 'image/png', buffer: fixtures.image });
    await waitForReview();
    await assertSourceScreenshots(page, 1);
    const imageText = await readExportedSource(page, output, 'image-source-check.xlsx');
    assert.match(imageText, /70/);
    assert.match(imageText, /20/);
    assert.equal(await page.locator('#source-images img').count(), 1);
    await page.screenshot({ path: path.join(output, 'image-phone.png'), fullPage: true });
    checks.push('真實本機圖片 OCR 可辨識 70／20 並產生原圖預覽');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-visible.pdf', mimeType: 'application/pdf', buffer: fixtures.pdf });
    await page.locator('#selection').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('#pdf-auto').isChecked(), true);
    assert.equal(await page.locator('#pdf-pages').isDisabled(), true);
    await page.locator('#pdf-auto').uncheck();
    await page.locator('#pdf-pages').fill('1');
    await page.locator('#start-read').click();
    await waitForReview();
    await assertSourceScreenshots(page, 1);
    const pdfText = await readExportedSource(page, output, 'pdf-source-check.xlsx');
    assert.match(pdfText, /70/);
    assert.match(pdfText, /20/);
    assert.ok(!pdfText.includes('SECRET-HIDDEN'));
    assert.ok(!pdfText.includes('9999'));
    assert.equal(await page.locator('#source-images img').count(), 1);
    await page.screenshot({ path: path.join(output, 'pdf-phone.png'), fullPage: true });
    checks.push('真實 PDF 第一頁渲染後 OCR，遮蓋文字不進入結果');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-transcript.pdf', mimeType: 'application/pdf', buffer: fixtures.transcriptPdf });
    await page.locator('#selection').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal(await page.locator('#pdf-auto').isChecked(), true);
    await page.locator('#start-read').click(); await waitForReview();
    await assertSourceScreenshots(page, 1);
    assert.equal(await page.locator('#field-main').inputValue(), '60.00');
    for (const id of ['confirmed', 'share-confirmed', 'parking-share-confirmed']) assert.equal(await page.locator(`#${id}`).isChecked(), false);
    assert.equal(await page.locator('#calculate').isDisabled(), true);
    const transcriptPdfText = await readExportedSource(page, output, 'transcript-pdf-source-check.xlsx');
    assert.match(transcriptPdfText, /第 2 頁/);
    assert.ok(!transcriptPdfText.includes('700.00'));
    assert.ok(!transcriptPdfText.includes('20000000'));
    checks.push('自動找出唯一建物標示頁，不帶入土地與抵押權頁資料');

    await backToImport();
    await page.locator('#file-input').setInputFiles({ name: 'synthetic-transcript-multiple.pdf', mimeType: 'application/pdf', buffer: fixtures.multiplePdf });
    await page.locator('#selection').waitFor({ state: 'visible', timeout: 60000 }); await page.locator('#start-read').click();
    await page.locator('#global-error').waitFor({ state: 'visible', timeout: ocrTimeout });
    assert.match(await page.locator('#global-error').textContent(), /不同建物|一戶/);
    assert.equal(await page.locator('#selection').isVisible(), true);
    assert.equal(await page.locator('#pdf-auto').isChecked(), false);
    assert.equal(await page.locator('#pdf-pages').isDisabled(), false);
    assert.equal(await page.locator('#source-images img').count(), 0);
    checks.push('多個建物頁中止自動模式，返回手動頁碼選擇');

    const requestedPaths = requests.filter(request => new URL(request.url).origin === deployment.origin).map(request => new URL(request.url).pathname);
    for (const asset of ['vendor/tesseract/worker.min.js', 'vendor/lang/chi_tra.traineddata.gz', 'vendor/lang/eng.traineddata.gz', 'vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs']) {
      const expectedPath = new URL(asset, deployment).pathname;
      assert.ok(requestedPaths.includes(expectedPath), `沒有從部署子路徑載入 ${asset}`);
    }
    assert.ok(requestedPaths.some(asset => asset.startsWith(new URL('vendor/tesseract-core/', deployment).pathname) && /\.wasm(?:\.js)?$/.test(asset)), '沒有從部署子路徑載入 OCR WebAssembly。');
    checks.push('模型、OCR worker／WASM、PDF worker 皆從部署子路徑載入');

    for (const width of [320, 390, 736]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px 畫面橫向溢出`);
    }
    assert.deepEqual(offOrigin, [], '偵測到部署 origin 外的請求');
    assert.deepEqual(outsideBasePath, [], '資源請求跳出部署子路徑');
    assert.deepEqual(uploads, [], '禁止任何 POST／PUT 等文件上傳請求');
    assert.deepEqual(failedRequests, [], '存在失敗的網路請求');
    assert.deepEqual(failedResponses, [], '存在 HTTP 4xx／5xx');
    assert.deepEqual(pageErrors, [], '存在 JavaScript 例外');
    assert.deepEqual(consoleErrors, [], '瀏覽器主控台存在錯誤');
    checks.push('320／390／736px 無橫向溢出；無 script error；無外站請求及文件上傳');
    const report = { result: 'passed', deployment: deployment.href, checkedAt: new Date().toISOString(), checks, requestCount: requests.length, offOriginRequestCount: offOrigin.length, uploads: uploads.length, requests, pageErrors, consoleErrors, failedRequests, failedResponses };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, deployment: report.deployment, checks, requestCount: report.requestCount, offOriginRequestCount: 0, output }));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failed-phone.png'), fullPage: true }).catch(() => {});
    const diagnostics = await page.locator('#progress-label').textContent().catch(() => '');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ result: 'failed', deployment: deployment.href, checkedAt: new Date().toISOString(), error: error.message, progress: diagnostics, checks, offOrigin, outsideBasePath, uploads, requests, pageErrors, consoleErrors, failedRequests, failedResponses }, null, 2));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
