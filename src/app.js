import { calculateAreas } from './core.js';
import { extractCandidates } from './extract.js';
import { inspectDocument, readDocument } from './readers.js';
import { extractTranscript } from './transcript.js';

const fieldNames = ['main', 'accessory', 'common', 'parking'];
const fieldLabels = { main: '主建物', accessory: '附屬建物', common: '共有部分', parking: '車位持分' };
const resultLabels = { without: '總坪數（不含車位）', with: '總坪數（含車位）', ratio: '公設比（扣車位）', public: '公設坪數（不含車位）', parking: '車位坪數', main: '主建物坪數', accessory: '附屬建物坪數' };
const settingIds = ['scope', 'inclusion', 'share-numerator', 'share-denominator', 'share-confirmed', 'parking-scope', 'parking-share-numerator', 'parking-share-denominator', 'parking-share-confirmed'];
const element = id => document.getElementById(id);
const progressLabels = { 'loading tesseract core': '載入辨識引擎', 'initializing tesseract': '初始化辨識引擎', 'loading language traineddata': '載入中英文模型', 'initializing api': '準備文字辨識', 'recognizing text': '正在辨識文字', 'loading tesseract': '載入文字辨識元件' };
const state = { screen: 'import', file: null, metadata: null, document: null, extraction: { candidates: [], suggestions: {}, warnings: [] }, transcript: false, transcriptReading: null, settings: {}, fields: {}, history: [], imageUrls: [], generation: 0, controller: null, confirmed: false, result: null };
function clearFields() { state.fields = Object.fromEntries(fieldNames.map(name => [name, { value: '', unit: 'sqm', sourceId: '', originalValue: '', originalUnit: '' }])); }
clearFields();
function showScreen(screen) {
  state.screen = screen;
  document.querySelectorAll('[data-screen]').forEach(section => { section.hidden = section.dataset.screen !== screen; });
  element('selection').hidden = screen !== 'selection';
  element('processing').hidden = screen !== 'processing';
  document.querySelectorAll('[data-step]').forEach(step => { if (step.dataset.step === screen) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current'); });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function messageError(error) { element('global-error').textContent = error?.message || String(error); element('global-error').hidden = false; }
function clearError() { element('global-error').hidden = true; element('global-error').textContent = ''; }
function releaseImages() { for (const url of state.imageUrls) URL.revokeObjectURL(url); state.imageUrls = []; element('source-images').replaceChildren(); }
function invalidate() { state.confirmed = false; state.result = null; element('confirmed').checked = false; element('action-status').textContent = ''; updateCalculation(); }
function revokeOwnershipConfirmation(common = true) {
  for (const id of common ? ['share-confirmed', 'parking-share-confirmed'] : ['parking-share-confirmed']) {
    addHistory(id, element(id).checked, false, '換算基準或持分已修改，需重新核對');
    element(id).checked = false;
  }
}
function coreInput() {
  return { fields: state.fields, commonScope: element('scope').value, commonIncludesParking: element('inclusion').value, shareNumerator: element('share-numerator').value, shareDenominator: element('share-denominator').value, shareConfirmed: element('share-confirmed').checked, parkingScope: element('parking-scope').value, parkingShareNumerator: element('parking-share-numerator').value, parkingShareDenominator: element('parking-share-denominator').value, parkingShareConfirmed: element('parking-share-confirmed').checked };
}
function updateCalculation() {
  const result = calculateAreas(coreInput());
  fieldNames.forEach(name => { document.querySelector(`[data-field-output="${name}"]`).textContent = name === 'common' && element('scope').value !== 'household' ? '本戶共有：' + result.display.common : result.display[name]; });
  element('share-fields').hidden = element('scope').value !== 'whole';
  const parkingFromShare = element('parking-scope').value === 'common';
  element('parking-share-fields').hidden = !parkingFromShare;
  document.querySelector('[data-area-field="parking"]').hidden = parkingFromShare;
  element('parking-share-output').textContent = '本戶車位：' + result.display.parking;
  element('review-errors').textContent = result.errors.map(error => error.message).join('\n');
  element('review-errors').hidden = !result.errors.length;
  element('review-feedback').textContent = result.warnings.join('\n') || '已確認本戶面積與車位關係，仍請核對來源後再計算。';
  const hasValue = fieldNames.some(name => !(name === 'parking' && parkingFromShare) && state.fields[name].value.trim());
  element('calculate').disabled = !state.confirmed || result.errors.length > 0 || !hasValue;
  state.settings = Object.fromEntries(settingIds.map(id => [id, element(id).type === 'checkbox' ? element(id).checked : element(id).value]));
  return result;
}
function addHistory(field, previous, next, reason) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  state.history.push({ at: new Date().toISOString(), field, before: previous, after: next, reason });
}
function renderFieldControls() {
  const container = element('fields');
  container.replaceChildren();
  fieldNames.forEach(name => {
    const wrapper = document.createElement('div'); wrapper.className = 'field'; wrapper.dataset.areaField = name;
    const heading = document.createElement('div'); heading.className = 'field-heading';
    const label = document.createElement('label'); label.htmlFor = `field-${name}`; label.textContent = fieldLabels[name];
    const output = document.createElement('output'); output.dataset.fieldOutput = name;
    heading.append(label, output);
    const values = document.createElement('div'); values.className = 'field-values';
    const input = document.createElement('input'); input.type = 'text'; input.id = `field-${name}`; input.inputMode = 'decimal'; input.maxLength = 24; input.value = state.fields[name].value; input.autocomplete = 'off'; input.setAttribute('aria-label', `${fieldLabels[name]}面積`);
    const unit = document.createElement('select'); unit.setAttribute('aria-label', `${fieldLabels[name]}單位`);
    for (const [value, text] of [['sqm', '㎡'], ['ping', '坪'], ['unknown', '待確認']]) unit.add(new Option(text, value));
    unit.value = state.fields[name].unit;
    input.addEventListener('input', () => { const previous = state.fields[name].value; state.fields[name].value = input.value; addHistory(name, previous, input.value, '人工修改數值'); if (name === 'common') revokeOwnershipConfirmation(); invalidate(); });
    unit.addEventListener('change', () => { const previous = state.fields[name].unit; state.fields[name].unit = unit.value; addHistory(name, previous, unit.value, '人工確認單位'); if (name === 'common') revokeOwnershipConfirmation(); invalidate(); });
    values.append(input, unit);
    const source = document.createElement('select'); source.className = 'field-source'; source.dataset.sourceField = name; source.setAttribute('aria-label', `${fieldLabels[name]}來源候選`); source.add(new Option('手動輸入／不指定來源', ''));
    for (const candidate of state.extraction.candidates.filter(candidate => candidate.field === name || candidate.field === 'unknown')) {
      source.add(new Option(`${candidate.value} ${candidate.unit === 'sqm' ? '㎡' : candidate.unit === 'ping' ? '坪' : '單位待確認'} · ${candidate.source}`, candidate.id));
    }
    source.value = state.fields[name].sourceId;
    source.addEventListener('change', () => {
      const candidate = state.extraction.candidates.find(candidate => candidate.id === source.value);
      const previous = { ...state.fields[name] };
      state.fields[name].sourceId = source.value;
      if (candidate) Object.assign(state.fields[name], { value: candidate.value, unit: candidate.unit, originalValue: candidate.value, originalUnit: candidate.unit });
      addHistory(name, previous, { ...state.fields[name] }, '選取來源候選');
      input.value = state.fields[name].value; unit.value = state.fields[name].unit; if (name === 'common') revokeOwnershipConfirmation(); invalidate();
    });
    wrapper.append(heading, values, source); container.append(wrapper);
  });
}
function resetDocument(file) {
  state.file = file; state.document = null; state.result = null; state.history = []; state.extraction = { candidates: [], suggestions: {}, warnings: [] }; state.confirmed = false;
  clearFields(); releaseImages();
  state.transcript = element('transcript-mode').checked; state.transcriptReading = null;
  element('scope').value = 'unknown'; element('inclusion').value = 'unknown'; element('share-numerator').value = ''; element('share-denominator').value = ''; element('share-confirmed').checked = false; element('confirmed').checked = false;
  element('parking-scope').value = 'household'; element('parking-share-numerator').value = ''; element('parking-share-denominator').value = ''; element('parking-share-confirmed').checked = false;
  element('include-source').checked = false;
  element('read-warnings').hidden = true; element('source-records').replaceChildren();
  element('source-name').textContent = file?.name || '手動輸入，未讀取文件';
  renderFieldControls(); renderTranscript(); updateCalculation();
}
function renderTranscript() {
  const reading = state.transcriptReading;
  const panel = element('transcript-candidates'); panel.replaceChildren();
  element('transcript-panel').open = state.transcript;
  if (!reading) panel.textContent = '尚無謄本候選。讀取後可在此核對；也可直接在下方手動輸入。';
  else {
    for (const [field, label] of Object.entries({ main: '主建物', accessory: '附屬建物／陽台', common: '共有總面積', commonShare: '共有持分', parkingShare: '車位持分' })) {
      const candidate = reading.available[field];
      const row = document.createElement('p');
      row.textContent = `${label}：${candidate ? candidate.numerator ? `${candidate.numerator}／${candidate.denominator}` : `${candidate.value} ${candidate.unit === 'sqm' ? '㎡' : '坪'}` : '未讀出或有多筆，請對照原圖手填'}`;
      panel.append(row);
      if (candidate) {
        const evidence = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看候選來源';
        const text = document.createElement('p'); text.textContent = `${candidate.source}\n${candidate.text}`; evidence.append(summary, text); panel.append(evidence);
      }
    }
    const warnings = document.createElement('p'); warnings.textContent = reading.warnings.join('\n'); panel.append(warnings);
  }
  element('apply-transcript').disabled = !reading || !Object.keys(reading.available).length;
  element('retry-transcript').hidden = !state.file || !['pdf', 'image'].includes(state.metadata?.kind);
}
function applyTranscript() {
  const available = state.transcriptReading?.available;
  if (!available) return;
  for (const name of ['main', 'accessory', 'common']) {
    const candidate = available[name];
    if (!candidate) continue;
    const previous = { ...state.fields[name] };
    Object.assign(state.fields[name], { value: candidate.value, unit: candidate.unit, sourceId: candidate.id, originalValue: candidate.value, originalUnit: candidate.unit });
    addHistory(name, previous, { ...state.fields[name] }, `謄本候選待核對：${candidate.source}／${candidate.text}`);
  }
  if (available.common || available.commonShare || available.parkingShare) {
    addHistory('scope', element('scope').value, 'whole', '謄本候選為未分攤共有總面積，仍須確認');
    element('scope').value = 'whole';
  }
  for (const [field, prefix] of [['commonShare', 'share'], ['parkingShare', 'parking-share']]) {
    const candidate = available[field];
    if (!candidate) continue;
    for (const part of ['numerator', 'denominator']) {
      addHistory(`${prefix}-${part}`, element(`${prefix}-${part}`).value, candidate[part], `謄本候選待核對：${candidate.source}／${candidate.text}`);
      element(`${prefix}-${part}`).value = candidate[part];
    }
  }
  if (available.parkingShare) { addHistory('parking-scope', element('parking-scope').value, 'common', '帶入獨立車位持分，仍須核對同一共有建號'); element('parking-scope').value = 'common'; }
  element('share-confirmed').checked = false; element('parking-share-confirmed').checked = false;
  element('inclusion').value = 'unknown';
  renderFieldControls(); invalidate();
}
function renderSources() {
  const container = element('source-records'); container.replaceChildren();
  const records = state.document?.records || [];
  for (const record of records.slice(0, 500)) {
    const row = document.createElement('div'); row.className = 'source-row';
    const caption = document.createElement('small'); caption.textContent = record.source;
    const text = document.createElement('div'); text.textContent = record.originalText ? `${record.text}\n【局部重讀前】${record.originalText}` : record.text;
    row.append(caption, text); container.append(row);
  }
  if (records.length > 500) { const note = document.createElement('p'); note.textContent = `畫面僅顯示前 500 筆，共 ${records.length} 筆；Excel 匯出仍保留本次讀取的所有來源。`; container.append(note); }
  const warnings = [...(state.document?.warnings || []), ...state.extraction.warnings];
  if (!(state.extraction.candidates.length)) warnings.push('沒有找到可明確分類的面積，請查看來源並手動輸入；不會猜數字。');
  warnings.push('只核對同一戶；全棟總面積、土地、總價或車位數不能直接當成本戶面積。');
  element('read-warnings').textContent = [...new Set(warnings)].join('\n'); element('read-warnings').hidden = false;
}
function selectPdfPages(text, count) {
  const pages = new Set();
  const normalized = text.trim().replaceAll('，', ',');
  if (!normalized) throw new Error('請填寫要辨識的 PDF 頁碼。');
  for (const segment of normalized.split(',')) {
    const match = segment.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('頁碼格式請用 1 或 1-3,5。');
    const first = Number(match[1]); const last = Number(match[2] || match[1]);
    if (first < 1 || last < first || last > count || last - first > 5) throw new Error(`頁碼須介於 1 到 ${count}，每次最多 5 頁。`);
    for (let page = first; page <= last; page += 1) pages.add(page);
  }
  if (pages.size > 5) throw new Error('每次最多 5 頁；可以分次選擇，不會自動截斷。');
  return [...pages].sort((first, second) => first - second);
}
async function readSelectedFile() {
  clearError();
  let options;
  try { options = state.metadata.kind === 'pdf' ? { pdfPages: selectPdfPages(element('pdf-pages').value, state.metadata.pageCount) } : state.metadata.kind === 'excel' ? { excelSheet: element('excel-sheet').value } : {}; } catch (error) { messageError(error); return; }
  const generation = ++state.generation;
  const controller = new AbortController(); state.controller = controller;
  element('progress-label').textContent = '準備讀取元件與模型'; element('progress').value = 0; showScreen('processing');
  try {
    const result = await readDocument(state.file, { ...options, transcript: state.transcript, signal: controller.signal,
      onProgress: progress => { if (generation !== state.generation) return; const label = progressLabels[progress.status] || progress.status; const percentage = Math.min(1, Math.max(0, progress.progress || 0)); element('progress-label').textContent = `${progress.pageNumber ? '第 ' + progress.pageNumber + ' 頁・' : ''}${label}${progressLabels[progress.status] ? '（' + Math.round(percentage * 100) + '%）' : ''}`; element('progress').value = percentage; },
      onPage: page => {
        if (generation !== state.generation) return;
        const url = URL.createObjectURL(page.blob); state.imageUrls.push(url);
        const image = document.createElement('img'); image.src = url; image.alt = page.source; image.loading = 'lazy';
        const caption = document.createElement('p'); caption.className = 'hint'; caption.textContent = page.source; element('source-images').append(caption, image);
      }
    });
    if (generation !== state.generation) return;
    state.document = result; state.extraction = extractCandidates(result.records);
    state.transcriptReading = extractTranscript(result.records);
    state.extraction.candidates.push(...state.transcriptReading.candidates.filter(candidate => ['main', 'accessory', 'common'].includes(candidate.field)));
    for (const name of fieldNames) {
      const suggested = state.extraction.candidates.find(candidate => candidate.id === state.extraction.suggestions[name]);
      if (suggested && !state.transcript && !state.transcriptReading.detected) Object.assign(state.fields[name], { value: suggested.value, unit: suggested.unit, sourceId: suggested.id, originalValue: suggested.value, originalUnit: suggested.unit });
    }
    renderFieldControls(); renderSources(); renderTranscript(); updateCalculation(); showScreen('review');
  } catch (error) {
    if (generation !== state.generation) return;
    releaseImages();
    showScreen('import');
    if (error.name !== 'AbortError') messageError(error);
  } finally { if (generation === state.generation) state.controller = null; }
}
async function chooseFile(file) {
  if (!file) return;
  clearError(); resetDocument(file);
  const generation = ++state.generation; state.controller = new AbortController(); showScreen('processing'); element('progress-label').textContent = '檢查檔案與讀取範圍'; element('progress').value = 0;
  try {
    const metadata = await inspectDocument(file, { signal: state.controller.signal });
    if (generation !== state.generation) return;
    state.metadata = metadata;
    if (metadata.kind === 'image') { await readSelectedFile(); return; }
    element('selection-name').textContent = file.name;
    element('pdf-choice').hidden = metadata.kind !== 'pdf'; element('sheet-choice').hidden = metadata.kind !== 'excel';
    if (metadata.kind === 'pdf') { element('pdf-count').textContent = `共 ${metadata.pageCount} 頁。只會辨識你指定的頁面。`; element('pdf-pages').value = metadata.pageCount <= 5 ? `1${metadata.pageCount > 1 ? '-' + metadata.pageCount : ''}` : ''; }
    if (metadata.kind === 'excel') {
      element('excel-sheet').replaceChildren();
      for (const sheet of metadata.sheets) { const name = typeof sheet === 'string' ? sheet : sheet.name; element('excel-sheet').add(new Option(name, name)); }
    }
    state.controller = null; showScreen('selection');
  } catch (error) { if (generation !== state.generation) return; state.controller = null; showScreen('import'); if (error.name !== 'AbortError') messageError(error); }
}
function summaryText(result) {
  const shares = [];
  if (element('scope').value === 'whole') shares.push(`共有持分：${element('share-numerator').value || '待填'}／${element('share-denominator').value || '待填'}（${result.raw.share.applied ? '已確認' : '待確認'}）`);
  if (element('parking-scope').value === 'common') shares.push(`車位持分：${element('parking-share-numerator').value || '待填'}／${element('parking-share-denominator').value || '待填'}（同一共有總面積；${result.raw.parkingShare.applied ? '已確認' : '待確認'}）`);
  return ['【房屋面積換算】', ...Object.entries(resultLabels).map(([name, label]) => `${label}：${result.display[name]}`), ...shares, `來源：${state.file?.name || '手動輸入'}`, `狀態：${Object.values(result.display).some(value => value === '待確認') ? '部分資料待確認' : '已人工核對'}`, '公設比採扣車位口徑；不明項目不推估。'].join('\n');
}
function showResults() {
  const result = updateCalculation();
  if (!state.confirmed || result.errors.length || element('calculate').disabled) return;
  state.result = result;
  for (const [name, value] of Object.entries(result.display)) document.querySelector(`[data-result="${name}"]`)?.replaceChildren(document.createTextNode(value));
  element('result-status').textContent = Object.values(result.display).some(value => value === '待確認') ? '已核對輸入・部分資料待確認' : '已核對輸入';
  element('result-note').textContent = result.warnings.join('\n') || '使用原始精度計算；顯示值取兩位後相加，可能與總計相差 0.01 坪。';
  element('summary').value = summaryText(result); showScreen('result');
}
function workbookBytes() {
  if (!state.result || !state.confirmed) throw new Error('請先核對並計算。');
  const workbook = XLSX.utils.book_new();
  const summary = [['房屋面積換算明細'], ['來源', state.file?.name || '手動輸入'], ['計算時間', new Date().toISOString()], ['狀態', element('result-status').textContent], [], ['項目', '數值', '單位／說明']];
  for (const [name, label] of Object.entries(resultLabels)) {
    const value = state.result.display[name];
    summary.push([label, value === '待確認' ? '待確認' : Number(value.replace(/ 坪$|%$/g, '')) / (name === 'ratio' ? 100 : 1), name === 'ratio' ? '扣車位公設比' : '坪']);
  }
  summary.push([], ['計算口徑', '總坪數不含土地；公設比扣車位。依原始精度計算，不相加已取兩位顯示值。'], ['共有範圍', element('scope').selectedOptions[0].textContent], ['車位關係', element('inclusion').selectedOptions[0].textContent], ['持分', `${element('share-numerator').value}/${element('share-denominator').value}`], ['提醒', state.result.warnings.join('；')]);
  summary.push(['車位換算方式', element('parking-scope').selectedOptions[0].textContent], ['車位持分', `${element('parking-share-numerator').value}/${element('parking-share-denominator').value}`], ['共有持分已確認', state.result.raw.share.applied ? '是（套用一次）' : '未套用'], ['車位持分已確認', state.result.raw.parkingShare.applied ? '是（直接乘未分攤共有總面積）' : '未套用']);
  const summarySheet = XLSX.utils.aoa_to_sheet(summary);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 65 }, { wch: 22 }];
  summarySheet['!rows'] = summary.map(() => ({ hpt: 24 }));
  Object.keys(summarySheet).filter(address => !address.startsWith('!')).forEach(address => { if (summarySheet[address].t === 'n') summarySheet[address].z = address === 'B9' ? '0.00%' : '#,##0.00'; });
  XLSX.utils.book_append_sheet(workbook, summarySheet, '換算結果');
  if (!element('include-source').checked) return XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
  const inputs = [['項目', '核對值', '單位', '原讀取值', '原單位', '來源', '來源原文']];
  for (const name of fieldNames) { const field = state.fields[name]; const source = state.extraction.candidates.find(candidate => candidate.id === field.sourceId); const ignored = name === 'parking' && element('parking-scope').value === 'common'; const normalized = ignored ? '' : field.value.trim(); const numericValue = !normalized ? '' : normalized.replace(/[^0-9]/g, '').length <= 15 ? Number(normalized) : normalized; inputs.push([fieldLabels[name], numericValue, ignored ? '依共有總面積乘車位持分；手動值未使用' : field.unit, field.originalValue, field.originalUnit, source?.source || '手動輸入', source?.text || '']); }
  const inputSheet = XLSX.utils.aoa_to_sheet(inputs); inputSheet['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 55 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, inputSheet, '核對與來源');
  const rawSheet = XLSX.utils.aoa_to_sheet([['來源位置', '讀取文字', '局部重讀前文字'], ...(state.document?.records || []).map(record => [record.source, record.text, record.originalText || ''])]); rawSheet['!cols'] = [{ wch: 60 }, { wch: 100 }, { wch: 100 }]; XLSX.utils.book_append_sheet(workbook, rawSheet, '原始讀取');
  const historySheet = XLSX.utils.aoa_to_sheet([['時間', '欄位', '修改前', '修改後', '原因'], ...state.history.map(change => [change.at, fieldLabels[change.field] || change.field, typeof change.before === 'object' ? JSON.stringify(change.before) : change.before, typeof change.after === 'object' ? JSON.stringify(change.after) : change.after, change.reason])]); historySheet['!cols'] = [{ wch: 28 }, { wch: 20 }, { wch: 45 }, { wch: 45 }, { wch: 25 }]; XLSX.utils.book_append_sheet(workbook, historySheet, '修正紀錄');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
}
function resultFile() {
  const basename = (state.file?.name || '手動輸入').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  return new File([workbookBytes()], `${basename}-面積換算.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function downloadResult() {
  try { const file = resultFile(); const url = URL.createObjectURL(file); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); element('action-status').textContent = '已產生 Excel；若 iPhone 開啟預覽，請用分享按鈕存到「檔案」或傳回 LINE。'; } catch (error) { messageError(error); }
}
document.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', () => { element('file-input').accept = { pdf: '.pdf,application/pdf', image: '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp', excel: '.xlsx,.xls,.xlsm,.xlsb' }[button.dataset.pick]; element('file-input').value = ''; element('file-input').click(); }));
element('file-input').addEventListener('change', event => chooseFile(event.target.files[0]));
element('manual').addEventListener('click', () => { clearError(); resetDocument(null); showScreen('review'); });
element('start-read').addEventListener('click', readSelectedFile);
element('cancel-selection').addEventListener('click', () => { clearError(); showScreen('import'); });
element('cancel-read').addEventListener('click', () => { state.generation += 1; state.controller?.abort(); state.controller = null; releaseImages(); showScreen('import'); clearError(); });
for (const id of settingIds) element(id).addEventListener(/(?:numerator|denominator)$/.test(id) ? 'input' : 'change', () => { if (/share-(?:numerator|denominator)$/.test(id)) { const confirmedId = id.startsWith('parking-') ? 'parking-share-confirmed' : 'share-confirmed'; addHistory(confirmedId, element(confirmedId).checked, false, '持分已修改，需重新核對'); element(confirmedId).checked = false; } if (id === 'scope') revokeOwnershipConfirmation(); if (id === 'parking-scope') revokeOwnershipConfirmation(false); addHistory(id, state.settings[id], element(id).type === 'checkbox' ? element(id).checked : element(id).value, '人工修改換算設定'); invalidate(); });
element('apply-transcript').addEventListener('click', applyTranscript);
element('retry-transcript').addEventListener('click', () => { element('transcript-mode').checked = true; const file = state.file; resetDocument(file); readSelectedFile(); });
element('confirmed').addEventListener('change', () => { state.confirmed = element('confirmed').checked; updateCalculation(); });
element('calculate').addEventListener('click', showResults);
element('back-import').addEventListener('click', () => { clearError(); showScreen('import'); invalidate(); });
element('edit').addEventListener('click', () => { clearError(); invalidate(); showScreen('review'); });
element('copy-summary').addEventListener('click', async () => { try { await navigator.clipboard.writeText(element('summary').value); element('action-status').textContent = '已複製摘要，可切回 LINE 貼上；尚未自動傳送。'; } catch { element('summary').focus(); element('summary').select(); element('action-status').textContent = '請長按下方摘要，選擇複製，再切回 LINE 貼上。'; } });
element('export').addEventListener('click', downloadResult);
element('share-result').addEventListener('click', async () => { try { const file = resultFile(); if (!navigator.canShare?.({ files: [file] })) { downloadResult(); return; } await navigator.share({ files: [file], title: '房屋面積換算' }); element('action-status').textContent = '已開啟手機分享流程，請自行選擇 LINE 或儲存位置。'; } catch (error) { if (error.name !== 'AbortError') messageError(error); } });
renderFieldControls(); renderTranscript(); updateCalculation();
