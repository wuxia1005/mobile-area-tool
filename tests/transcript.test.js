import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTranscript } from '../src/transcript.js';

const specimen = ['建物標示部', '層數 12層 總面積 60.00平方公尺', '層次 3層 層次面積 60.00平方公尺', '附屬建物', '附屬建物用途 陽台 面積5.00平方公尺', '共有部分', '權利範圍100000分之600 面積10,000.00平方公尺', '其他登記事項 門廊7.34平方公尺', '含停車位 編號地下三層01', '權利範圍100000分之300', '其他登記事項 建築基地權利範圍10000分之45'];
const read = (lines = specimen) => extractTranscript(lines.map((text, index) => ({ text, source: `合成測試第${index + 1}行`, pageNumber: 1 })));

test('isolates transcript fields and independent ownership fractions with provenance', () => {
  const result = read();
  assert.equal(result.available.main.value, '60.00');
  assert.equal(result.available.accessory.value, '5.00');
  assert.equal(result.available.common.value, '10000.00');
  assert.equal(result.available.commonShare.numerator, '600');
  assert.equal(result.available.commonShare.denominator, '100000');
  assert.equal(result.available.parkingShare.numerator, '300');
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.every(candidate => candidate.source.startsWith('合成測試')));
});

test('never turns invalid OCR decimals into a suffix area', () => {
  const result = read(specimen.map(text => text.replace('10,000.00', '10.000.00')));
  assert.equal(result.available.common, undefined);
  assert.equal(result.available.commonShare.numerator, '600');
});

test('does not stitch spaced OCR digits or accept scientific notation', () => {
  for (const value of ['7.3 4', '1e3', '-10']) assert.equal(read(['建物標示部', `總面積${value}平方公尺`]).available.main, undefined);
  assert.equal(read(specimen.map(text => text.replace('100000分之600', '1 100000分之600'))).available.commonShare, undefined);
});

test('does not guess omitted balcony or ownership from unrelated building details', () => {
  const result = read(specimen.filter(text => !/附屬建物用途|權利範圍100000/u.test(text)));
  assert.equal(result.available.accessory, undefined);
  assert.equal(result.available.common, undefined);
  assert.equal(result.available.commonShare, undefined);
  assert.equal(result.available.parkingShare, undefined);
});

test('fraction order remains denominator 分之 numerator and invalid fractions are rejected', () => {
  for (const fraction of ['0分之1', '100分之200', '100分之0', '1.5分之1', '-100分之1']) {
    assert.equal(read(specimen.map(text => text.replace('100000分之600', fraction))).available.commonShare, undefined);
  }
});

test('multiple pages or repeated main fields are not silently combined', () => {
  const result = extractTranscript([1, 2].flatMap(pageNumber => specimen.map(text => ({ text, pageNumber }))));
  assert.equal(result.available.main, undefined);
  assert.equal(result.available.commonShare, undefined);
  assert.equal(result.available.parkingShare, undefined);
  assert.ok(result.warnings.some(warning => warning.includes('不會跨頁')));
});

test('complementary fields on different transcript pages cannot be stitched into a household', () => {
  const result = extractTranscript([
    ...['建物標示部', '總面積60平方公尺', '附屬建物 陽台5平方公尺'].map(text => ({ text, pageNumber: 1 })),
    ...['建物標示部', '共有部分', '權利範圍100000分之600 面積10000平方公尺'].map(text => ({ text, pageNumber: 2 })),
  ]);
  assert.deepEqual(result.available, {});
});

test('only a transcript section enables transcript candidates', () => {
  assert.equal(read(specimen.filter(text => text !== '建物標示部')).candidates.length, 0);
  assert.equal(read(['建物標示部', ...specimen]).candidates.length, 0);
});

test('an ownership line can have its fraction and area on the next OCR line', () => {
  const result = read(specimen.flatMap(text => text.startsWith('權利範圍100000分之600') ? ['權利範圍', '100000分之600 面積10,000.00平方公尺'] : [text]));
  assert.equal(result.available.common.value, '10000.00');
  assert.equal(result.available.commonShare.numerator, '600');
});
