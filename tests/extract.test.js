import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates } from '../src/extract.js';

function extract(text, extra = {}) {
  return extractCandidates([{ text, source: '文件.pdf 第 2 頁', ...extra }]);
}

function suggested(result, field) {
  return result.candidates.find(candidate => candidate.id === result.suggestions[field]);
}

test('spaced OCR digits and malformed decimals do not yield suffix area candidates', () => {
  for (const text of ['共有面積 10.304.04平方公尺', '7.3 4平方公尺', '共有面積 7 34平方公尺']) {
    assert.equal(extract(text).candidates.length, 0);
  }
});

test('辨識明確面積並保留來源與原始文字', () => {
  const text = '主建物：100 平方公尺　附屬建物：10㎡　共有部分：20m²　車位面積：8m2';
  const result = extract(text);
  assert.equal(result.candidates.length, 4);
  assert.equal(suggested(result, 'main').value, '100');
  assert.equal(suggested(result, 'accessory').value, '10');
  assert.equal(suggested(result, 'common').value, '20');
  assert.equal(suggested(result, 'parking').value, '8');
  assert.ok(result.candidates.every(candidate => candidate.unit === 'sqm'));
  assert.ok(result.candidates.every(candidate => candidate.source === '文件.pdf 第 2 頁' && candidate.text === text));
});

test('總坪數不會當作主建物，坪數保留原數字而不二次換算', () => {
  const result = extract('主建物 20 坪　附屬建物 2 坪　公設坪數 10　總坪數 32');
  assert.equal(suggested(result, 'main').value, '20');
  assert.equal(suggested(result, 'total').value, '32');
  assert.equal(suggested(result, 'total').unit, 'ping');
  assert.equal(result.candidates.length, 4);
});

test('可讀千分位、全形字元及零值', () => {
  const result = extract('主建物：１,２３４.５６㎡\n附屬建物：0 平方公尺');
  assert.equal(suggested(result, 'main').value, '1234.56');
  assert.equal(suggested(result, 'accessory').value, '0');
});

test('明確的表頭單位可用於有標籤的數字，但不套用到無標籤資料', () => {
  const result = extract('主建物 100\n附屬建物 10\n12345', { unitHint: 'sqm' });
  assert.equal(suggested(result, 'main').unit, 'sqm');
  assert.equal(suggested(result, 'accessory').unit, 'sqm');
  assert.equal(result.candidates.length, 2);
});

test('Excel 直向表頭依 cell header 辨識且保留儲存格來源，不重複解析原列', () => {
  const result = extractCandidates([{
    text: '70 | 10 | 50 | 20',
    source: '房屋資料 第 2 列',
    cells: [
      { address: 'A2', text: '70', header: '主建物（㎡）', unitHint: 'sqm' },
      { address: 'B2', text: '10', header: '附屬建物（㎡）', unitHint: 'sqm' },
      { address: 'C2', text: '50', header: '共有部分（㎡）', unitHint: 'sqm' },
      { address: 'D2', text: '20', header: '車位面積（㎡）', unitHint: 'sqm' },
    ],
  }]);
  assert.equal(result.candidates.length, 4);
  assert.equal(suggested(result, 'main').value, '70');
  assert.equal(suggested(result, 'accessory').value, '10');
  assert.equal(suggested(result, 'common').value, '50');
  assert.equal(suggested(result, 'parking').value, '20');
  assert.match(suggested(result, 'main').source, /儲存格 A2/u);
  assert.match(suggested(result, 'main').text, /主建物（㎡）/u);
  assert.match(suggested(result, 'main').text, /70 \| 10 \| 50 \| 20/u);
});

test('Excel cell 模式不重複收集原列已出現的面積文字', () => {
  const result = extractCandidates([{
    text: '主建物 70㎡',
    source: '第 2 列',
    cells: [{ address: 'B2', text: '70', header: '主建物（㎡）' }],
  }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(suggested(result, 'main').value, '70');
});

test('Excel cell 只有明確欄名與純數字才透過表頭映射', () => {
  const result = extractCandidates([{
    text: '70 | 30 | 2 | 20或30 | 12345',
    source: '第 2 列',
    cells: [
      { address: 'A2', text: '70', header: '主建物', unitHint: 'sqm' },
      { address: 'B2', text: '30', header: '公設比', unitHint: 'sqm' },
      { address: 'C2', text: '2', header: '車位數', unitHint: 'sqm' },
      { address: 'D2', text: '20或30', header: '公設面積', unitHint: 'sqm' },
      { address: 'E2', text: '12345', header: '主建物編號', unitHint: 'sqm' },
    ],
  }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(suggested(result, 'main').value, '70');
});

test('Excel cell 的總坪數維持坪單位且數字千分位可正規化', () => {
  const result = extractCandidates([{
    text: '1,234.56',
    source: '第 2 列',
    cells: [{ address: 'A2', text: '1,234.56', header: '總坪數' }],
  }]);
  assert.equal(result.candidates.length, 1);
  assert.equal(suggested(result, 'total').value, '1234.56');
  assert.equal(suggested(result, 'total').unit, 'ping');
  assert.equal(result.suggestions.main, null);
});

test('Excel cell 缺單位不猜測，負值也不自動建議', () => {
  const result = extractCandidates([{
    text: '70 | -10',
    source: '第 2 列',
    cells: [
      { address: 'A2', text: '70', header: '主建物' },
      { address: 'B2', text: '-10', header: '附屬建物（㎡）' },
    ],
  }]);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].unit, 'unknown');
  assert.equal(result.candidates[1].value, '-10');
  assert.equal(result.suggestions.main, null);
  assert.equal(result.suggestions.accessory, null);
});

test('Excel cell 中不同戶號不能把不同列欄位拼成同一戶', () => {
  const result = extractCandidates([
    {
      text: 'A1 | 70', source: '第 2 列', cells: [
        { address: 'A2', text: 'A1', header: '戶號' },
        { address: 'B2', text: '70', header: '主建物（㎡）' },
      ],
    },
    {
      text: 'A2 | 10', source: '第 3 列', cells: [
        { address: 'A3', text: 'A2', header: '戶號' },
        { address: 'C3', text: '10', header: '附屬建物（㎡）' },
      ],
    },
  ]);
  assert.equal(result.candidates.length, 2);
  assert.ok(Object.values(result.suggestions).every(value => value === null));
});

test('Excel cell 公設仍受到相鄰權利範圍文字保護而主建物不受影響', () => {
  const result = extractCandidates([
    { text: '權利範圍', source: '第 1 列' },
    {
      text: '70 | 1000', source: '第 2 列', cells: [
        { address: 'A2', text: '70', header: '主建物（㎡）' },
        { address: 'B2', text: '1000', header: '公設面積（㎡）' },
      ],
    },
  ]);
  assert.equal(result.candidates.length, 2);
  assert.equal(suggested(result, 'main').value, '70');
  assert.equal(result.suggestions.common, null);
  assert.match(result.warnings.join(' '), /人工核對持分/u);
});

test('無法使用 cell header 時仍可解析有標籤的原列', () => {
  const result = extractCandidates([{
    text: '主建物 70㎡', source: '第 2 列', cells: [
      { address: 'A2', text: '備註', header: '說明' },
    ],
  }]);
  assert.equal(suggested(result, 'main').value, '70');
});

test('同一欄位的括號單位可明確指定平方公尺', () => {
  const result = extract('主建物（㎡）100\n附屬建物（坪）2');
  assert.equal(suggested(result, 'main').unit, 'sqm');
  assert.equal(suggested(result, 'accessory').unit, 'ping');
});

test('缺少單位只列候選，不猜平方公尺', () => {
  const result = extract('主建物 100');
  assert.equal(result.candidates[0].unit, 'unknown');
  assert.equal(result.suggestions.main, null);
  assert.match(result.warnings.join(' '), /單位/u);
});

test('無標籤的明確面積列為 unknown 讓使用者選擇', () => {
  const result = extract('面積 100 平方公尺');
  assert.equal(result.candidates[0].field, 'unknown');
  assert.ok(Object.values(result.suggestions).every(value => value === null));
});

test('排除價格、百分比、數量、戶號、日期與持分分數', () => {
  const result = extract('總價 3000 萬元\n每平方公尺單價 50000 元\n車位數 2 個\n戶號 A5\n日期 2026/10/15\n公設比 30%\n權利範圍 1/100', { unitHint: 'sqm' });
  assert.equal(result.candidates.length, 0);
});

test('同一行的價款與車位數不會混入面積', () => {
  const result = extract('主建物面積 100㎡ 總價 3000萬元 車位數 2個');
  assert.equal(result.candidates.length, 1);
  assert.equal(suggested(result, 'main').value, '100');
});

test('整棟共用部分總面積可以列候選但不能自動當本戶', () => {
  const result = extract('共用部分總面積 1000㎡');
  assert.equal(result.candidates[0].field, 'common');
  assert.equal(result.suggestions.common, null);
  assert.match(result.warnings.join(' '), /整棟/u);
});

test('共用部分與總面積分行也不會把整棟面積當本戶總面積', () => {
  const result = extract('共用部分\n總面積 1000㎡');
  assert.equal(result.suggestions.total, null);
  assert.match(result.warnings.join(' '), /整棟/u);
});

test('含持分段落的面積不自動帶入，也不把分子分母讀成面積', () => {
  const result = extract('共有部分面積 1000㎡\n權利範圍 1/100');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.suggestions.common, null);
  assert.match(result.warnings.join(' '), /持分/u);
});

test('PDF OCR 拆成相鄰 records 時公設候選仍須人工核對持分', () => {
  const result = extractCandidates([
    { text: '共有部分總面積', source: '第 1 頁第 1 行', pageNumber: 1 },
    { text: '公設面積 1000㎡', source: '第 1 頁第 2 行', pageNumber: 1 },
    { text: '權利範圍', source: '第 1 頁第 3 行', pageNumber: 1 },
    { text: '1/100', source: '第 1 頁第 4 行', pageNumber: 1 },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].field, 'common');
  assert.equal(result.candidates[0].value, '1000');
  assert.equal(result.suggestions.common, null);
  assert.match(result.warnings.join(' '), /人工核對持分/u);
});

test('Excel 前列的共有總面積提示會阻擋下一列公設自動建議', () => {
  const result = extractCandidates([
    { text: '共用部分總面積', source: '工作表 1 第 5 列' },
    { text: '共有部分 1000㎡', source: '工作表 1 第 6 列' },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.suggestions.common, null);
  assert.match(result.warnings.join(' '), /人工核對持分/u);
});

test('鄰近持分提示不會阻擋主建物與一般總面積', () => {
  const result = extractCandidates([
    { text: '主建物 80㎡', source: '第 1 頁第 1 行', pageNumber: 1 },
    { text: '公設面積 20㎡', source: '第 1 頁第 2 行', pageNumber: 1 },
    { text: '權利範圍', source: '第 1 頁第 3 行', pageNumber: 1 },
    { text: '建物面積 100㎡', source: '第 1 頁第 4 行', pageNumber: 1 },
  ]);
  assert.equal(suggested(result, 'main').value, '80');
  assert.equal(suggested(result, 'total').value, '100');
  assert.equal(result.suggestions.common, null);
});

test('不同頁的持分提示不會無條件污染另一頁公設', () => {
  const result = extractCandidates([
    { text: '權利範圍', source: '第 1 頁最後一行', pageNumber: 1 },
    { text: '本戶公設面積 20㎡', source: '第 2 頁第 1 行', pageNumber: 2 },
  ]);
  assert.equal(suggested(result, 'common').value, '20');
});

test('拆行的未分類面積不被吞掉，也會提示核對持分', () => {
  const result = extractCandidates([
    { text: '共用部分總面積', source: '第 1 頁第 1 行', pageNumber: 1 },
    { text: '1000㎡', source: '第 1 頁第 2 行', pageNumber: 1 },
    { text: '權利範圍 1/100', source: '第 1 頁第 3 行', pageNumber: 1 },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].field, 'unknown');
  assert.equal(result.candidates[0].value, '1000');
  assert.match(result.warnings.join(' '), /人工核對持分/u);
});

test('負面積保留供核對，但不能自動帶入', () => {
  const result = extract('主建物 −10㎡');
  assert.equal(result.candidates[0].value, '-10');
  assert.equal(result.suggestions.main, null);
  assert.match(result.warnings.join(' '), /負值/u);
});

test('多戶與相同值重複出現時不會任選一筆自動帶入', () => {
  const result = extractCandidates([
    { text: '戶號 A1 主建物 100㎡', source: '第 1 頁' },
    { text: '戶號 A2 主建物 100㎡ 附屬建物 10㎡', source: '第 2 頁' },
  ]);
  assert.equal(result.candidates.filter(candidate => candidate.field === 'main').length, 2);
  assert.ok(Object.values(result.suggestions).every(value => value === null));
  assert.match(result.warnings.join(' '), /重複/u);
});

test('不同戶號即使沒有重複欄位也不能拼成一戶', () => {
  const result = extractCandidates([
    { text: '戶號 A1 主建物 100㎡', source: '第 1 頁' },
    { text: '戶號 A2 附屬建物 10㎡', source: '第 2 頁' },
  ]);
  assert.equal(result.candidates.length, 2);
  assert.ok(Object.values(result.suggestions).every(value => value === null));
});

test('房數與樓層不是面積', () => {
  const result = extract('主建物 3房 2廳 2衛 8樓');
  assert.equal(result.candidates.length, 0);
});

test('建物面積視為總面積而不是主建物', () => {
  const result = extract('建物面積 100㎡');
  assert.equal(suggested(result, 'total').value, '100');
  assert.equal(result.suggestions.main, null);
});

test('土地面積獨立於建物與總坪數', () => {
  const result = extract('土地面積 50㎡\n主建物 100㎡\n總坪數 40');
  assert.equal(suggested(result, 'land').value, '50');
  assert.equal(suggested(result, 'main').value, '100');
  assert.equal(suggested(result, 'total').unit, 'ping');
});

test('不跨換行把缺標籤數字自動映射到上一列', () => {
  const result = extract('主建物\n100㎡');
  assert.equal(result.candidates[0].field, 'unknown');
  assert.equal(result.suggestions.main, null);
});

test('名稱和明確單位矛盾時不會自動套用', () => {
  const result = extract('總坪數 100㎡');
  assert.equal(result.candidates[0].unit, 'sqm');
  assert.equal(result.suggestions.total, null);
  assert.match(result.warnings.join(' '), /不一致/u);
});

test('表頭與數值的明確單位矛盾時不自動套用', () => {
  const result = extract('主建物 100㎡', { unitHint: 'ping' });
  assert.equal(result.candidates[0].unit, 'sqm');
  assert.equal(result.suggestions.main, null);
  assert.match(result.warnings.join(' '), /表頭/u);
});

test('無資料或格式不正確時安全回傳空候選', () => {
  assert.equal(extractCandidates(null).candidates.length, 0);
  assert.equal(extractCandidates([{ text: null }, {}]).candidates.length, 0);
});
