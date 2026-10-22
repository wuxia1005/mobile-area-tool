import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOcrLabels } from '../src/ocr-text.js';
import { extractTranscript } from '../src/transcript.js';

test('常見的權利範圍誤讀字只用於比對，數字與其他文字不變', () => {
  assert.equal(normalizeOcrLabels('徊利範圍: *****10000分之151'), '權利範圍: *****10000分之151');
  assert.equal(normalizeOcrLabels('榷利范圍100000分之596 面積10,304.04平方公尺'), '權利範圍100000分之596 面積10,304.04平方公尺');
  assert.equal(normalizeOcrLabels('權 利 範 圍 全部'), '權利範圍 全部');
  assert.equal(normalizeOcrLabels('債權額比例 全部 1分之1'), '債權額比例 全部 1分之1');
  assert.equal(normalizeOcrLabels(undefined), '');
});

test('非 OCR 文字的誤讀標籤同樣能找到共有持分，原文仍保留', () => {
  const lines = ['建物標示部', '總面積 60.00平方公尺', '共有部分 10,000.00平方公尺', '徊利範圍 *****100000分之600*****'];
  const result = extractTranscript(lines.map((text, index) => ({ text, source: `合成測試第${index + 1}行` })));
  assert.equal(result.available.commonShare.numerator, '600');
  assert.equal(result.available.commonShare.denominator, '100000');
  assert.match(result.available.commonShare.text, /徊利範圍/u);
});
