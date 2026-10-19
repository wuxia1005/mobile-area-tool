import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceCropBounds, createSourceScreenshot, createExcelScreenshots } from '../src/source-screenshots.js';

test('source crops include full-width original rows with padding without mutating records', () => {
  const records = [{ bbox: { x0: 200, x1: 400, y0: 100, y1: 150 } }, { bbox: { x0: 20, x1: 900, y0: 180, y1: 220 } }];
  const original = structuredClone(records);
  assert.deepEqual(sourceCropBounds(records, 1000, 1000), { x: 0, y: 85, width: 1000, height: 150 });
  assert.deepEqual(records, original);
});

test('missing or unsafe bounds show the entire source instead of a misleading partial crop', () => {
  const whole = { x: 0, y: 0, width: 1000, height: 1000 };
  assert.deepEqual(sourceCropBounds([], 1000, 1000), whole);
  for (const bbox of [undefined, {}, { x0: 0, x1: 100, y0: NaN, y1: 10 }, { x0: 0, x1: 100, y0: 2000, y1: 2100 }, { x0: 100, x1: 10, y0: 1, y1: 10 }]) assert.deepEqual(sourceCropBounds([{ bbox }], 1000, 1000), whole);
  assert.throws(() => sourceCropBounds([], 0, 100), /尺寸/);
});

test('source crops clamp partially off-page rows to page edges', () => {
  assert.deepEqual(sourceCropBounds([{ bbox: { x0: -10, x1: 900, y0: -5, y1: 995 } }], 1000, 1000), { x: 0, y: 0, width: 1000, height: 1000 });
});

function browserMock({ failBlob = false } = {}) {
  const canvases = [];
  const drawings = [];
  const texts = [];
  const oldDocument = globalThis.document;
  const oldImage = globalThis.Image;
  globalThis.document = { createElement: () => {
    const context = { drawImage: (...args) => drawings.push(args), measureText: value => ({ width: [...value].length * 20 }), fillText: value => texts.push(value), fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} };
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob(callback, type) { this.encodedSize = { width: this.width, height: this.height }; callback(failBlob ? null : new Blob(['synthetic'], { type })); } };
    canvases.push(canvas);
    return canvas;
  } };
  globalThis.Image = class {
    naturalWidth = 1000;
    naturalHeight = 1000;
    set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
  };
  return { canvases, drawings, texts, restore() { globalThis.document = oldDocument; globalThis.Image = oldImage; } };
}

test('source screenshot draws original crop, returns PNG and releases canvas', async () => {
  const mock = browserMock();
  try {
    const blob = await createSourceScreenshot({ url: 'blob:synthetic', width: 1000, height: 1000 }, [{ bbox: { x0: 20, x1: 300, y0: 100, y1: 200 } }]);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(mock.drawings[0].slice(1, 5), [0, 85, 1000, 130]);
    assert.equal(mock.canvases[0].width, 0);
    assert.equal(mock.canvases[0].height, 0);
  } finally { mock.restore(); }
});

test('source screenshot bounds memory and releases canvas when encoding fails', async () => {
  const mock = browserMock({ failBlob: true });
  try {
    await assert.rejects(createSourceScreenshot({ url: 'blob:synthetic', width: 10000, height: 10000 }), /來源截圖/);
    assert.ok(mock.canvases[0].encodedSize.width * mock.canvases[0].encodedSize.height <= 2500000);
    assert.equal(mock.canvases[0].height, 0);
  } finally { mock.restore(); }
});

test('Excel screenshots display actual cell addresses and values, without formulas or inferred zeros', async () => {
  const mock = browserMock();
  try {
    const records = [{ sheetName: '合成測試', rowNumber: 2, cells: [{ address: 'B2', text: '60.00' }, { address: 'D2', text: '' }, { address: 'E2', text: '5.00', formula: 'unsafe()' }] }];
    const original = structuredClone(records);
    const blobs = await createExcelScreenshots(records);
    assert.equal(blobs.length, 1);
    assert.ok(mock.texts.includes('合成測試!B2'));
    assert.ok(mock.texts.includes('60.00'));
    assert.ok(mock.texts.includes('5.00'));
    assert.ok(!mock.texts.includes('unsafe()'));
    assert.ok(!mock.texts.includes('0'));
    assert.deepEqual(records, original);
    assert.ok(mock.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { mock.restore(); }
});

test('Excel screenshots split after 24 cell rows and preserve long values over bounded images', async () => {
  const mock = browserMock();
  try {
    const records = [{ sheetName: '合成測試', rowNumber: 1, cells: Array.from({ length: 25 }, (_, index) => ({ address: `A${index + 1}`, text: `${index + 1}` })) }, { sheetName: '合成測試', rowNumber: 30, cells: [{ address: 'A30', text: '長'.repeat(3000) + '尾端' }] }];
    const blobs = await createExcelScreenshots(records);
    assert.ok(blobs.length >= 3);
    assert.ok(mock.texts.join('').includes('尾端'));
    assert.ok(mock.canvases.filter(canvas => canvas.encodedSize).every(canvas => canvas.encodedSize.width <= 4096 && canvas.encodedSize.height <= 4096 && canvas.encodedSize.width * canvas.encodedSize.height <= 2500000));
  } finally { mock.restore(); }
});

test('Excel screenshots bound preview cells and indicate truncation inside the image', async () => {
  const mock = browserMock();
  try {
    const records = Array.from({ length: 501 }, (_, index) => ({ sheetName: '合成', rowNumber: index + 1, cells: [{ address: `A${index + 1}`, text: `值${index + 1}` }] }));
    await createExcelScreenshots(records);
    assert.ok(mock.texts.some(value => value.includes('部分預覽') && value.includes('前 500 列') && value.includes('完整讀取值保留於匯出')));
    assert.ok(mock.texts.includes('值240'));
    assert.ok(!mock.texts.includes('值241'));
    assert.deepEqual(await createExcelScreenshots([]), []);
  } finally { mock.restore(); }
});

test('wide 500-row Excel input stops at 240 cells rather than producing thousands of PNGs', async () => {
  const mock = browserMock();
  try {
    const cells = Array.from({ length: 1000 }, (_, index) => ({ address: `A${index + 1}`, text: `寬表${index + 1}` }));
    const records = Array.from({ length: 500 }, (_, index) => ({ sheetName: '合成寬表', rowNumber: index + 1, cells }));
    const blobs = await createExcelScreenshots(records);
    assert.equal(blobs.length, 10);
    assert.ok(mock.texts.includes('寬表240'));
    assert.ok(!mock.texts.includes('寬表241'));
    assert.ok(mock.texts.some(value => value.includes('部分預覽')));
    assert.equal(records[0].cells.length, 1000);
    assert.ok(mock.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { mock.restore(); }
});

test('one very long Excel value stops at 12 images and labels the partial source preview', async () => {
  const mock = browserMock();
  try {
    const text = '長'.repeat(300000) + '超出上限的尾端';
    const records = [{ sheetName: '合成長格', rowNumber: 1, cells: [{ address: 'A1', text }] }];
    const blobs = await createExcelScreenshots(records);
    assert.equal(blobs.length, 12);
    assert.ok(mock.texts.some(value => value.includes('部分預覽') && value.includes('完整讀取值保留於匯出')));
    assert.ok(!mock.texts.join('').includes('超出上限的尾端'));
    assert.equal(records[0].cells[0].text, text);
    assert.ok(mock.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { mock.restore(); }
});

test('Excel preview releases all allocated canvases when PNG encoding fails', async () => {
  const mock = browserMock({ failBlob: true });
  try {
    await assert.rejects(createExcelScreenshots([{ sheetName: '合成', rowNumber: 1, cells: [{ address: 'A1', text: '60' }] }]), /來源截圖/);
    assert.ok(mock.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { mock.restore(); }
});
