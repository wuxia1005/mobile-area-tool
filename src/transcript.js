const labels = { main: '主建物', accessory: '附屬建物／陽台', common: '共有總面積', commonShare: '共有持分', parkingShare: '車位持分' };
const areaPattern = /([\d,.]+)(平方公尺|平方米|m2|坪)/gu;
const decimalPattern = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,8})?$/u;

function compact(text) {
  return text.normalize('NFKC').replace(/(?<=\d)\s+(?=\d)/gu, '?').replace(/\s+/gu, '');
}

function areas(line) {
  return [...line.matchAll(areaPattern)].filter(match => decimalPattern.test(match[1]) && !/[\d.,+\-A-Za-z/?]/u.test(line[match.index - 1] ?? '')).map(match => ({ value: match[1].replaceAll(',', ''), unit: match[2] === '坪' ? 'ping' : 'sqm' }));
}

function shares(line) {
  return [...line.matchAll(/(?<![\d.,?-])(\d{1,12})分之(\d{1,12})(?![\d.,?])/gu)].filter(match => BigInt(match[1]) > 0n && BigInt(match[2]) > 0n && BigInt(match[2]) <= BigInt(match[1])).map(match => ({ numerator: match[2], denominator: match[1] }));
}

export function extractTranscript(records = []) {
  const candidates = [];
  const warnings = new Set(['謄本候選只供核對，不會直接算入；缺漏、重複或小數點不明時請對照原圖手填。']);
  const pages = new Map();
  for (const record of records.filter(record => record && typeof record.text === 'string')) {
    const key = `${record.sheetName ?? ''}:${record.pageNumber ?? 1}`;
    if (!pages.has(key)) pages.set(key, []);
    for (const text of record.text.split(/\r?\n/u)) if (text.trim()) pages.get(key).push({ ...record, text, compact: compact(text) });
  }
  let detected = false;
  let transcriptPageCount = 0;
  for (const lines of pages.values()) {
    const markers = lines.filter(line => /建物標示部/u.test(line.compact));
    if (!markers.length) continue;
    detected = true;
    transcriptPageCount += 1;
    if (markers.length !== 1) {
      warnings.add('同頁包含多個建物標示部，不能混用不同戶的面積與持分，請分開讀取。');
      continue;
    }
    const beginning = lines.indexOf(markers[0]);
    const body = lines.slice(beginning);
    const accessoryStart = body.findIndex(line => /附屬建物|附屬建築物|陽台/u.test(line.compact));
    const commonStart = body.findIndex(line => /共有部分|共用部分/u.test(line.compact));
    const parkingStart = body.findIndex(line => /含停車位|停車位權利範圍/u.test(line.compact));
    const add = (field, value, line, evidence = line.text) => candidates.push({ id: `transcript-${candidates.length + 1}`, field, label: labels[field], ...value, source: line.source ?? '位置未提供', text: line.originalText ? `${evidence}\n【局部重讀前】${line.originalText}` : evidence });
    const mainEnd = Math.min(...[accessoryStart, commonStart, body.length].filter(index => index >= 0));
    for (const line of body.slice(0, mainEnd)) {
      if (/主建物(?:面積)?|總面積/u.test(line.compact) && !/共有|共用|土地|基地/u.test(line.compact)) {
        for (const value of areas(line.compact)) add('main', value, line);
      }
    }
    if (accessoryStart >= 0) {
      const end = commonStart > accessoryStart ? commonStart : Math.min(body.length, accessoryStart + 4);
      let accessoryLabel = false;
      for (const line of body.slice(accessoryStart, end)) {
        if (/附屬建物|附屬建築物|陽台/u.test(line.compact)) accessoryLabel = true;
        if (accessoryLabel) for (const value of areas(line.compact)) add('accessory', value, line);
      }
    }
    if (commonStart >= 0) {
      const commonEnd = parkingStart > commonStart ? parkingStart : body.length;
      const shared = body.slice(commonStart, commonEnd);
      for (const [index, line] of shared.entries()) {
        if (!/權利範圍/u.test(line.compact)) continue;
        const next = shared[index + 1];
        const window = [line, ...(next && !/其他登記|基地|土地|門廊|夾層|屋頂|用途/u.test(next.compact) ? [next] : [])];
        const fractionLine = shares(line.compact).length ? line : window[1];
        const areaLine = areas(line.compact).length ? line : window[1];
        if (fractionLine) for (const value of shares(fractionLine.compact)) add('commonShare', value, fractionLine, window.map(item => item.text).join('\n'));
        if (areaLine) for (const value of areas(areaLine.compact)) add('common', value, areaLine, window.map(item => item.text).join('\n'));
      }
    }
    if (parkingStart >= 0) {
      const parking = body.slice(parkingStart, parkingStart + 5);
      for (const [index, line] of parking.entries()) {
        if (index > 0 && /其他登記事項|基地權利|土地/u.test(line.compact)) break;
        if (/權利範圍/u.test(line.compact)) {
          for (const value of shares(line.compact)) add('parkingShare', value, line);
          const next = parking[index + 1];
          if (next && !/其他登記事項|基地權利|土地/u.test(next.compact) && !shares(line.compact).length) {
            for (const value of shares(next.compact)) add('parkingShare', value, next, `${line.text}\n${next.text}`);
          }
        }
      }
    }
  }
  const available = {};
  if (transcriptPageCount > 1) {
    warnings.add('多頁包含建物標示部，不能確認為同一戶，不會跨頁拼湊候選；請一次選取一戶的一頁。');
    return { detected, candidates, available, warnings: [...warnings] };
  }
  for (const field of Object.keys(labels)) {
    const options = candidates.filter(candidate => candidate.field === field);
    if (options.length === 1) available[field] = options[0];
    else if (options.length > 1) warnings.add(`${labels[field]}有多筆候選，不會任選或合併，請逐項核對後手填。`);
  }
  if (!detected) warnings.add('未確認單一建物標示部，請使用下方欄位手動核對，勿套用整份文件的任意數字。');
  return { detected, candidates, available, warnings: [...warnings] };
}
