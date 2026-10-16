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

test('multiple building-description pages are not silently combined', () => {
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

test('a common building area before its ownership line is associated with that section', () => {
  const result = read([
    '建物標示部',
    '總面積＊＊＊78.32平方公尺',
    '層次面積＊＊＊78.32平方公尺',
    '附屬建物用途：陽台 面積＊＊6.12平方公尺',
    '共有部分：測試段01234-000建號＊＊＊3,456.78平方公尺',
    '權利範圍：＊＊＊＊10000分之123＊＊＊＊',
    '其他登記事項：門廊7.34平方公尺',
    '建物所有權部',
    '權利範圍：全部 1分之1',
  ]);
  assert.equal(result.available.main.value, '78.32');
  assert.equal(result.available.common.value, '3456.78');
  assert.equal(result.available.commonShare.numerator, '123');
  assert.equal(result.available.commonShare.denominator, '10000');
  assert.equal(result.candidates.length, 4);
  assert.match(result.available.common.text, /共有部分/u);
  assert.match(result.available.common.text, /權利範圍/u);
  assert.match(result.available.main.text, /層次面積/u);
});

test('one building description can be found among multiple land and mortgage pages', () => {
  const result = extractTranscript([
    { pageNumber: 1, text: '土地標示部\n面積800平方公尺\n土地所有權部\n權利範圍10000分之250', source: '合成第1頁' },
    { pageNumber: 2, text: '土地他項權利部\n權利範圍10000分之250', source: '合成第2頁' },
    { pageNumber: 3, text: '建物標示部\n總面積78.32平方公尺\n附屬建物用途陽台 面積6.12平方公尺\n共有部分：測試段01234-000建號3,456.78平方公尺\n權利範圍10000分之123\n建物所有權部\n權利範圍1分之1', source: '合成第3頁' },
    { pageNumber: 4, text: '建物他項權利部\n設定權利範圍1分之1\n其他登記事項面積900平方公尺', source: '合成第4頁' },
  ]);
  assert.equal(result.available.main.value, '78.32');
  assert.equal(result.available.accessory.value, '6.12');
  assert.equal(result.available.common.value, '3456.78');
  assert.equal(result.available.commonShare.numerator, '123');
  assert.ok(result.candidates.every(candidate => candidate.source === '合成第3頁'));
  assert.equal(result.available.parkingShare, undefined);
});

test('building ownership and mortgages cannot supply a missing common or parking fraction', () => {
  const result = read([
    '建物標示部', '總面積50平方公尺', '附屬建物用途陽台 面積4平方公尺',
    '共有部分：測試段01234-000建號1000平方公尺', '權利範圍：無法辨識',
    '含停車位：地下二層01', '權利範圍：無法辨識',
    '建物所有權部', '權利範圍：1分之1',
    '建物他項權利部', '權利範圍：10000分之123',
  ]);
  assert.equal(result.available.commonShare, undefined);
  assert.equal(result.available.parkingShare, undefined);
  assert.equal(result.available.common.value, '1000');
});

test('repeated equal main totals are corroboration rather than separate buildings', () => {
  const result = read(['建物標示部', '總面積60.00平方公尺', '主建物面積60平方公尺', '層次面積60.000平方公尺']);
  assert.equal(result.available.main.value, '60.00');
  assert.equal(result.candidates.length, 1);
  assert.match(result.available.main.text, /主建物面積/u);
  assert.match(result.available.main.text, /層次面積/u);
  assert.match(result.available.main.source, /合成測試第2行/u);
  assert.match(result.available.main.source, /合成測試第3行/u);
});

test('conflicting main totals remain ambiguous and floor areas are not added to an explicit total', () => {
  const conflict = read(['建物標示部', '總面積60平方公尺', '主建物面積65平方公尺']);
  assert.equal(conflict.available.main, undefined);
  assert.ok(conflict.warnings.some(warning => warning.includes('主建物有多筆候選')));
  const severalFloors = read(['建物標示部', '總面積80平方公尺', '一層 層次面積40平方公尺', '二層 層次面積40平方公尺']);
  assert.equal(severalFloors.available.main.value, '80');
});

test('one floor area may be a warned fallback but multiple floor areas are never summed', () => {
  const single = read(['建物標示部', '層次面積60平方公尺']);
  assert.equal(single.available.main.value, '60');
  assert.ok(single.warnings.some(warning => warning.includes('單筆層次面積')));
  assert.equal(read(['建物標示部', '一層 層次面積30平方公尺', '二層 層次面積30平方公尺']).available.main, undefined);
});

test('a separate OCR line may contain only the explicitly labeled main area', () => {
  const result = read(['建物標示部', '總面積：', '＊＊＊＊60.00平方公尺', '附屬建物陽台 面積5平方公尺']);
  assert.equal(result.available.main.value, '60.00');
  assert.match(result.available.main.text, /總面積/u);
  assert.equal(read(['建物標示部', '總面積：', '層次3層', '60平方公尺']).available.main, undefined);
});

test('same-line floor area does not become an extra total candidate', () => {
  const result = read(['建物標示部', '總面積80平方公尺 層次面積40平方公尺']);
  assert.equal(result.available.main.value, '80');
  assert.equal(result.candidates.length, 1);
});

test('different common buildings with equal areas and shares remain ambiguous', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺',
    '共有部分：測試段01234-000建號1000平方公尺', '權利範圍10000分之123',
    '共有部分：測試段01235-000建號1000平方公尺', '權利範圍10000分之123',
  ]);
  assert.equal(result.available.main.value, '60');
  assert.equal(result.available.common, undefined);
  assert.equal(result.available.commonShare, undefined);
});

test('invalid decimal and Unicode negative signs cannot produce positive area candidates', () => {
  for (const value of ['−10', '60.00.1', '60?00', '1e3']) {
    assert.equal(read(['建物標示部', `總面積${value}平方公尺`]).available.main, undefined);
  }
});

test('narrow OCR section-heading variants still isolate description from ownership', () => {
  const result = read([
    '建物標十部', '總面積60平方公尺', '共有部分：測試段01234-000建號1000平方公尺',
    '權利範圍10000分之123', '建物所有有權部', '權利範圍1分之1',
  ]);
  assert.equal(result.detected, true);
  assert.equal(result.available.main.value, '60');
  assert.equal(result.available.commonShare.numerator, '123');
  assert.equal(result.candidates.filter(candidate => candidate.field === 'commonShare').length, 1);
});

test('a numbered basement slot beside a labeled fraction can recover an unread parking heading', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺', '共有部分',
    '權利範圍100000分之600 面積10000平方公尺', '其他登記事項：共有項目',
    '編號 地下三層09', '權利範圍100000分之300',
    '其他登記事項：建築基地權利10000分之45',
  ]);
  assert.equal(result.available.commonShare.numerator, '600');
  assert.equal(result.available.parkingShare.numerator, '300');
  assert.match(result.available.parkingShare.text, /地下三層09/u);
  assert.ok(result.warnings.some(warning => warning.includes('地下樓層編號')));
});

test('a basement layer without a numbered slot does not imply a parking fraction', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺', '共有部分',
    '權利範圍100000分之600 面積10000平方公尺', '其他登記事項：地下三層',
    '權利範圍100000分之300',
  ]);
  assert.equal(result.available.parkingShare, undefined);
  assert.equal(read([
    '建物標示部', '總面積60平方公尺', '共有部分',
    '權利範圍100000分之600 面積10000平方公尺', '其他登記事項：共有項目',
    '地下三層09平方公尺', '權利範圍100000分之300',
  ]).available.parkingShare, undefined);
});

test('an unusually large accessory candidate is preserved but not auto-filled or decimal-corrected', () => {
  const result = read(['建物標示部', '總面積60平方公尺', '附屬建物用途 陽台 面積500平方公尺']);
  assert.equal(result.available.main.value, '60');
  assert.equal(result.available.accessory, undefined);
  assert.equal(result.candidates.find(candidate => candidate.field === 'accessory').value, '500');
  assert.ok(result.warnings.some(warning => warning.includes('小數點漏辨識')));
  assert.equal(read(['建物標示部', '總面積60平方公尺', '附屬建物用途 陽台 面積5.00平方公尺']).available.accessory.value, '5.00');
});

test('common building identification may mention its building site without ending the area section', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺', '共有部分',
    '測試段（權狀註記事項）建築基地地號：測試段123地號01234-000建號',
    '權利範圍100000分之600 面積10000平方公尺',
    '主要用途本共有部分之項目有防空避難室兼停車空間',
    '其他登記事項：門廊7.34平方公尺',
  ]);
  assert.equal(result.available.common.value, '10000');
  assert.equal(result.available.commonShare.numerator, '600');
});

test('an explicitly labeled common raw area is retained without fabricating a missing share', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺',
    '共有部分：測試段01234-000建號1000平方公尺',
    '其他登記事項：門廊7.34平方公尺',
    '建物所有權部', '權利範圍1分之1',
  ]);
  assert.equal(result.available.common.value, '1000');
  assert.equal(result.available.commonShare, undefined);
  assert.ok(result.warnings.some(warning => warning.includes('不能當作本戶公設')));
});

test('a numerator glued to unread characters is not accepted as a partial fraction', () => {
  for (const fraction of ['10000分之1人', '10000分之1入', '10000分之151A', '1e10000分之151', '10000分之1,51', '10000分之1?51', '+10000分之151']) {
    const result = read(['建物標示部', '總面積60平方公尺', '共有部分', `權利範圍${fraction}`, '面積1000平方公尺']);
    assert.equal(result.available.commonShare, undefined);
  }
});

test('clear numeric token boundaries remain valid before OCR noise or a recognized next field', () => {
  for (const fraction of ['10000分之151 Ps', '10000分之151＊＊＊', '10000分之151面積1000平方公尺']) {
    const result = read(['建物標示部', '總面積60平方公尺', '共有部分', `權利範圍${fraction}`]);
    assert.equal(result.available.commonShare.numerator, '151');
  }
});

test('Latin OCR label noise separated from a common area does not merge into its numeric token', () => {
  const result = read([
    '建物標示部', '總面積60平方公尺', '共有部分',
    '_ 權利範圍100000分之600 Eht 10,000.00平方公尺',
    '主要用途防空避難室兼停車空間，門廊7.34平方公尺',
  ]);
  assert.equal(result.available.common.value, '10000.00');
  assert.equal(result.available.commonShare.numerator, '600');
  assert.equal(read(['建物標示部', '總面積1e 3平方公尺']).available.main, undefined);
});
