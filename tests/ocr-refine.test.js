import test from 'node:test';
import assert from 'node:assert/strict';
import { refineTranscript } from '../src/ocr-refine.js';

function canvasHarness(readings = []) {
  const created = [];
  const modes = [];
  const recognitionCalls = [];
  const drawCalls = [];
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          drawImage(...argumentsList) { drawCalls.push(argumentsList); },
          getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
          putImageData() {}
        })
      };
      created.push(canvas);
      return canvas;
    }
  };
  const ocr = {
    async setParameters(parameters) { modes.push(parameters.tessedit_pageseg_mode); },
    async recognize(canvas) {
      assert.ok(canvas.width <= 4096 && canvas.height <= 4096);
      assert.ok(canvas.width * canvas.height <= 2500000);
      recognitionCalls.push({ width: canvas.width, height: canvas.height });
      const reading = readings.shift();
      if (reading instanceof Error) throw reading;
      const text = typeof reading === 'function' ? await reading() : reading || '';
      return { data: { text, confidence: 80 } };
    }
  };
  return { created, modes, recognitionCalls, drawCalls, ocr, close() { globalThis.document = previousDocument; } };
}

function row(text, top = 100) {
  return { text, source: '測試原頁', bbox: { x0: 40, y0: top, x1: 740, y1: top + 24 } };
}

test('局部重讀交叉核對漏掉的小數點並保留原文', async () => {
  const harness = canvasHarness(['附屬建物用途 陽台 面積5.08平方公尺', '附屬建物用途 陽台 面積5.08平方公尺']);
  try {
    const records = [row('附屬建物用途 陽台 面積508平方公尺')];
    records[0].unitHint = 'unknown';
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.match(records[0].text, /5\.08平方公尺/u);
    assert.match(records[0].originalText, /508平方公尺/u);
    assert.match(records[0].source, /面積小數點局部重讀/u);
    assert.equal(records[0].unitHint, 'sqm');
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(harness.modes.at(-1), '6');
  } finally { harness.close(); }
});

test('已有完整小數與有效持分時不讓重讀破壞正確數字', async () => {
  const harness = canvasHarness(['總面積56072平方公尺']);
  try {
    const records = [row('總面積56.72平方公尺'), row('權利範圍100000分之596 面積10,304.04平方公尺', 160)];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(records[0].text, '總面積56.72平方公尺');
    assert.equal(records[1].text, '權利範圍100000分之596 面積10,304.04平方公尺');
    assert.equal(harness.created.length, 0);
  } finally { harness.close(); }
});

test('持分數字與車位標籤分開重讀且不使用基地持分', async () => {
  const harness = canvasHarness(['權利範圍100000分之310', '權利範圍100000分之310', '含停車位']);
  try {
    const records = [row('編號 地下三層09'), row('全還位 權琍入還6000分2310', 140), row('建築基地權利 範圍738地號 一萬分之四五', 200)];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.match(records[1].text, /含停車位.*100000分之310/u);
    assert.equal(records[1].originalText, '全還位 權琍入還6000分2310');
    assert.equal(records[2].originalText, undefined);
    assert.equal(harness.created.length, 3);
  } finally { harness.close(); }
});

test('重讀出現多筆持分時不任選其中一筆', async () => {
  const harness = canvasHarness(['權利範圍100000分之310\n權利範圍100000分之596']);
  try {
    const records = [row('全還位6000分2310')];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(records[0].text, '全還位6000分2310');
    assert.equal(records[0].originalText, undefined);
  } finally { harness.close(); }
});

test('取消後不新增局部辨識並保留記錄', async () => {
  const harness = canvasHarness();
  try {
    const signal = AbortSignal.abort();
    await assert.rejects(refineTranscript({ width: 800, height: 1000 }, [row('附屬建物用途 陽台 面積508平方公尺')], harness.ocr, { transcript: true, signal }), { name: 'AbortError' });
    assert.equal(harness.created.length, 0);
  } finally { harness.close(); }
});

test('未啟用謄本模式或沒有座標時不建立局部影像', async () => {
  const harness = canvasHarness();
  try {
    const records = [row('總面積6012平方公尺')];
    assert.equal(await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr), records);
    const withoutBoxes = [{ text: '總面積6012平方公尺' }];
    assert.equal(await refineTranscript({ width: 800, height: 1000 }, withoutBoxes, harness.ocr, { transcript: true }), withoutBoxes);
    assert.equal(harness.created.length, 0);
    assert.equal(harness.recognitionCalls.length, 0);
    assert.equal(harness.modes.length, 0);
  } finally { harness.close(); }
});

test('兩次局部小數辨識不一致時保留原文而不任選結果', async () => {
  const harness = canvasHarness(['附屬建物用途陽台 面積5.12平方公尺', '附屬建物用途陽台 面積5.13平方公尺']);
  try {
    const records = [row('附屬建物用途陽台 面積512平方公尺')];
    const before = structuredClone(records);
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.deepEqual(records, before);
    assert.equal(harness.recognitionCalls.length, 3);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('兩次一致的無效數字也不能提升為有效面積', async () => {
  for (const invalid of ['5.1 2平方公尺', '-5.12平方公尺', '−5.12平方公尺', '1e5.12平方公尺', '5.12.3平方公尺', '5.12m20']) {
    const reading = `附屬建物用途陽台 面積${invalid}`;
    const harness = canvasHarness([reading, reading]);
    try {
      const records = [row('附屬建物用途陽台 面積512平方公尺')];
      const before = structuredClone(records);
      await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
      assert.deepEqual(records, before, invalid);
      assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
    } finally { harness.close(); }
  }
});

test('第三次數值欄重讀必須與先前明確面積一致才採用二取三結果', async () => {
  const harness = canvasHarness([
    '附屬建物用途陽台 面積55123.45平方公尺',
    '附屬建物用途陽台 面積7.65平方公尺',
    '7.65平方公尺',
  ]);
  try {
    const records = [row('附屬建物用途陽台 面積765平方公尺')];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(records[0].text, '附屬建物用途陽台 面積7.65平方公尺');
    assert.equal(records[0].originalText, '附屬建物用途陽台 面積765平方公尺');
    assert.equal(harness.recognitionCalls.length, 3);
    assert.ok(harness.recognitionCalls[2].width < harness.recognitionCalls[1].width);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('第三次數值欄或先前重讀缺少明確面積單位時不補猜單位', async () => {
  for (const readings of [
    ['附屬建物用途陽台 面積7.65平方公尺', '附屬建物用途陽台 面積7.66平方公尺', '7.65'],
    ['附屬建物用途陽台 面積7.65', '附屬建物用途陽台 面積7.65', '7.65平方公尺'],
  ]) {
    const harness = canvasHarness([...readings]);
    try {
      const records = [row('附屬建物用途陽台 面積765平方公尺')];
      const before = structuredClone(records);
      await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
      assert.deepEqual(records, before);
      assert.equal(harness.recognitionCalls.length, 3);
    } finally { harness.close(); }
  }
});

test('提供原始圖片時局部辨識座標會依來源比例換算且不改寫原圖', async () => {
  const harness = canvasHarness(['附屬建物用途陽台 面積7.65平方公尺', '附屬建物用途陽台 面積7.65平方公尺']);
  try {
    const canvas = { width: 800, height: 1000 };
    const sourceImage = { width: 400, height: 500 };
    const records = [row('附屬建物用途陽台 面積765平方公尺')];
    await refineTranscript(canvas, records, harness.ocr, { transcript: true, sourceImage, sourceScale: 2 });
    assert.equal(records[0].text, '附屬建物用途陽台 面積7.65平方公尺');
    assert.equal(harness.drawCalls.length, 2);
    for (const call of harness.drawCalls) {
      assert.equal(call[0], sourceImage);
      assert.equal(call[1], 0);
      assert.equal(call[3], 400);
      assert.ok(call[2] > 0 && call[2] < sourceImage.height);
      assert.ok(call[4] > 0 && call[4] < sourceImage.height);
    }
    assert.deepEqual(canvas, { width: 800, height: 1000 });
    assert.deepEqual(sourceImage, { width: 400, height: 500 });
    assert.ok(harness.created.every(crop => crop.width === 0 && crop.height === 0));
  } finally { harness.close(); }
});

test('持分重讀拒絕空白拆開的數字、負號與未讀完的數字尾端', async () => {
  for (const invalid of ['100 000分之150', '10000分之1 50', '-10000分之150', '−10000分之150', '1e10000分之150', '10000分之1人', '10000分之150A', '10000分之1,50']) {
    const harness = canvasHarness([`權利範圍${invalid}`, `權利範圍${invalid}`]);
    try {
      const records = [row('權利範圍10000分之無法辨識150')];
      const before = structuredClone(records);
      await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
      assert.deepEqual(records, before, invalid);
      assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
    } finally { harness.close(); }
  }
});

test('原始持分尾端未辨識完整時仍啟動重讀而不保留部分分子', async () => {
  const harness = canvasHarness(['權利範圍10000分之150', '權利範圍10000分之150']);
  try {
    const records = [row('權利範圍10000分之1人')];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(records[0].text, '權利範圍10000分之150');
    assert.equal(records[0].originalText, '權利範圍10000分之1人');
    assert.equal(harness.recognitionCalls.length, 2);
  } finally { harness.close(); }
});

test('同一重讀行出現多筆持分仍視為歧義而不更新記錄', async () => {
  const harness = canvasHarness(['權利範圍10000分之150 權利範圍10000分之250']);
  try {
    const records = [row('權利範圍10000分之無法辨識150')];
    const before = structuredClone(records);
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.deepEqual(records, before);
  } finally { harness.close(); }
});

test('單次有效持分沒有第二次一致結果時不更新原記錄', async () => {
  const harness = canvasHarness(['權利範圍10000分之150', '權利範圍無法辨識', '', '']);
  try {
    const records = [row('權利範圍10000分之無法辨識150')];
    const before = structuredClone(records);
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.deepEqual(records, before);
    assert.equal(harness.recognitionCalls.length, 4);
  } finally { harness.close(); }
});

test('持分需分子分母完全一致而不是只看相同分子', async () => {
  const harness = canvasHarness([
    '權利範圍10000分之150', '權利範圍110000分之150',
    '權利範圍120000分之150', '權利範圍130000分之150',
  ]);
  try {
    const records = [row('權利範圍10000分之無法辨識150')];
    const before = structuredClone(records);
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.deepEqual(records, before);
    assert.equal(harness.recognitionCalls.length, 4);
  } finally { harness.close(); }
});

test('先前持分分母誤讀可由其後兩次完全一致的結果取代', async () => {
  const harness = canvasHarness([
    '權利範圍110000分之150', '權利範圍10000分之150', '權利範圍10000分之150',
  ]);
  try {
    const records = [row('權利範圍10000分之無法辨識150')];
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(records[0].text, '權利範圍10000分之150');
    assert.equal(records[0].originalText, '權利範圍10000分之無法辨識150');
    assert.equal(harness.recognitionCalls.length, 3);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('持分與車位標籤的交叉重讀共用十二次上限', async () => {
  const harness = canvasHarness(Array.from({ length: 5 }, () => [
    '權利範圍10000分之150', '權利範圍10000分之150', '含停車位',
  ]).flat());
  try {
    const records = Array.from({ length: 5 }, (_, index) => row('車位權利範圍10000分之無法辨識150', 20 + index * 60));
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.equal(harness.recognitionCalls.length, 12);
    assert.equal(records.filter(record => record.originalText).length, 4);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('未達持分共識的多列輸入仍受總重讀次數限制', async () => {
  const harness = canvasHarness(Array(30).fill('權利範圍無法辨識'));
  try {
    const records = Array.from({ length: 5 }, (_, index) => row('權利範圍10000分之無法辨識150', 20 + index * 60));
    const before = structuredClone(records);
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true });
    assert.deepEqual(records, before);
    assert.equal(harness.recognitionCalls.length, 12);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('面積局部重讀有次數上限且會釋放所有暫存畫布', async () => {
  const progress = [];
  const harness = canvasHarness(Array(30).fill('附屬建物用途陽台 面積5.12平方公尺'));
  try {
    const records = Array.from({ length: 20 }, (_, index) => row('附屬建物用途陽台 面積512平方公尺', 20 + index * 30));
    await refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true, onProgress: item => progress.push(item) });
    assert.equal(harness.recognitionCalls.length, 12);
    assert.equal(progress.length, 12);
    assert.equal(records.filter(record => record.originalText).length, 6);
    assert.equal(harness.modes.at(-1), '6');
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('OCR中途取消會釋放已建立畫布並且不帶入半完成資料', async () => {
  const controller = new AbortController();
  const harness = canvasHarness([() => { controller.abort(); return '附屬建物用途陽台 面積5.12平方公尺'; }]);
  try {
    const records = [row('附屬建物用途陽台 面積512平方公尺')];
    const before = structuredClone(records);
    await assert.rejects(refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true, signal: controller.signal }), { name: 'AbortError', code: 'ABORTED' });
    assert.deepEqual(records, before);
    assert.equal(harness.recognitionCalls.length, 1);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { harness.close(); }
});

test('OCR例外會釋放畫布並恢復原本頁面辨識模式', async () => {
  const harness = canvasHarness([new Error('synthetic OCR failure')]);
  try {
    const records = [row('附屬建物用途陽台 面積512平方公尺')];
    const before = structuredClone(records);
    await assert.rejects(refineTranscript({ width: 800, height: 1000 }, records, harness.ocr, { transcript: true }), /synthetic OCR failure/u);
    assert.deepEqual(records, before);
    assert.ok(harness.created.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(harness.modes.at(-1), '6');
  } finally { harness.close(); }
});
