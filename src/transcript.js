import { normalizeOcrLabels } from './ocr-text.js?v=1';

const labels = { main: '主建物', accessory: '附屬建物／陽台', common: '共有總面積', commonShare: '共有持分', parkingShare: '車位持分' };
const areaPattern = /([\d,.]+)(平方公尺|平方米|m2(?![\dA-Za-z])|坪)/giu;
const decimalPattern = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,8})?$/u;
const buildingSectionPattern = /建物標[示十]部/u;
const commonSectionPattern = /^\**(?:共有部分|共用部分)/u;
const sectionEndPattern = /(?:建物|土地)?所有有?權部|(?:建物|土地)?他項權利部|土地標示部/u;
const remarksPattern = /其他登記事項|基地權利|建築基地|土地/u;

function compact(text) {
  return normalizeOcrLabels(text.normalize('NFKC')).replace(/[−﹣]/gu, '-').replace(/(?<=\d)\s+(?=\d)/gu, '?').replace(/(?<![\dA-Za-z])([A-Za-z]{2,})\s+(?=\d)/gu, '$1|').replace(/(分之\d+)\s+(?=[^\d\s])/gu, '$1|').replace(/\s+/gu, '');
}

function areas(line) {
  return [...line.matchAll(areaPattern)].filter(match => decimalPattern.test(match[1]) && !/[\d.,+\-A-Za-z/?]/u.test(line[match.index - 1] ?? '')).map(match => ({ value: match[1].replaceAll(',', ''), unit: match[2] === '坪' ? 'ping' : 'sqm' }));
}

function shares(line) {
  return [...line.matchAll(/(?<![\d.,?A-Za-z+\-])(\d{1,12})分之(\d{1,12})(?![\d.,?])(?=$|[*#_|:：;；。)）\]】]|面積|其他登記|權利範圍|共有部分|共用部分|停車位)/gu)].filter(match => BigInt(match[1]) > 0n && BigInt(match[2]) > 0n && BigInt(match[2]) <= BigInt(match[1])).map(match => ({ numerator: match[2], denominator: match[1] }));
}

function checkedShares(line, warnings, label) {
  const values = shares(line.compact);
  if (!line.ocr && !line.bbox) return values;
  const verified = line.shareVerification;
  if (verified?.status === 'verified') {
    const matching = values.filter(value => value.numerator === verified.numerator && value.denominator === verified.denominator);
    if (matching.length === 1) return matching;
  }
  warnings.add(`${label}未通過局部交叉核對，未自動帶入；請對照原圖手動輸入分子、分母。`);
  return [];
}

function evidence(lines) {
  return lines.map(line => line.originalText ? `${line.text}\n【局部重讀前】${line.originalText}` : line.text).join('\n');
}

function labeledAreas(lines, pattern) {
  const found = [];
  for (const [index, line] of lines.entries()) {
    const labels = [...line.compact.matchAll(pattern)];
    for (const [labelIndex, label] of labels.entries()) {
      const segment = line.compact.slice(label.index + label[0].length, labels[labelIndex + 1]?.index).split(/層次面積|附屬建物|附屬建築物|共有部分|共用部分/u)[0];
      const values = areas(segment);
      for (const value of values) found.push({ value, lines: [line] });
      const next = lines[index + 1];
      if (!values.length && next && /^[*:：()（）\d.,平方公尺平方米mM2坪]+$/u.test(next.compact)) {
        for (const value of areas(next.compact)) found.push({ value, lines: [line, next] });
      }
    }
  }
  return found;
}

function areaKey(value) {
  const [integer, decimal = ''] = value.value.split('.');
  return `${value.unit}:${BigInt(integer)}.${decimal.replace(/0+$/u, '')}`;
}

function scaledArea(value) {
  const [integer, decimal = ''] = value.split('.');
  return BigInt(integer) * 100000000n + BigInt(decimal.padEnd(8, '0'));
}

export function extractTranscript(records = []) {
  const candidates = [];
  const warnings = new Set(['謄本候選會先帶入待核對；不會自動確認持分，缺漏或衝突請對照原圖修正。']);
  const pages = new Map();
  for (const record of records.filter(record => record && typeof record.text === 'string')) {
    const key = `${record.sheetName ?? ''}:${record.pageNumber ?? 1}`;
    if (!pages.has(key)) pages.set(key, []);
    for (const text of record.text.split(/\r?\n/u)) if (text.trim()) pages.get(key).push({ ...record, text, compact: compact(text) });
  }
  let detected = false;
  let transcriptPageCount = 0;
  for (const lines of pages.values()) {
    const markers = lines.filter(line => buildingSectionPattern.test(line.compact));
    if (!markers.length) continue;
    detected = true;
    transcriptPageCount += 1;
    if (markers.length !== 1) {
      warnings.add('同頁包含多個建物標示部，不能混用不同戶的面積與持分，請分開讀取。');
      continue;
    }
    const beginning = lines.indexOf(markers[0]);
    const following = lines.slice(beginning + 1).findIndex(line => sectionEndPattern.test(line.compact));
    const body = lines.slice(beginning, following < 0 ? undefined : beginning + 1 + following);
    const accessoryStart = body.findIndex(line => /附屬建物|附屬建築物|陽台/u.test(line.compact));
    const commonStart = body.findIndex(line => commonSectionPattern.test(line.compact));
    let parkingStart = body.findIndex(line => /含停車位|停車位權利範圍|車位編號/u.test(line.compact));
    if (parkingStart < 0 && commonStart >= 0) {
      parkingStart = body.findIndex((line, index) => index > commonStart
        && /地下[一二三四五六七八九十\d]+層[\dA-Za-z-]{1,6}(?![\dA-Za-z-])/u.test(line.compact)
        && !/面積/u.test(line.compact) && !areas(line.compact).length
        && body.slice(index, index + 3).some(nearby => /權利範圍/u.test(nearby.compact)));
      if (parkingStart >= 0) warnings.add('車位候選依地下樓層編號與鄰近權利範圍辨識，請對照原圖確認確為車位。');
    }
    const add = (field, value, sources) => candidates.push({ id: `transcript-${candidates.length + 1}`, field, label: labels[field], ...value, source: [...new Set(sources.map(line => line.source ?? '位置未提供'))].join('／'), text: evidence(sources) });
    const mainEnd = Math.min(...[accessoryStart, commonStart, parkingStart, body.length].filter(index => index >= 0));
    const mainLines = body.slice(0, mainEnd).filter(line => !/共有|共用|土地|基地/u.test(line.compact));
    let mainAreas = labeledAreas(mainLines, /主建物(?:總面積|面積)?|總面積/gu);
    const floorAreas = labeledAreas(mainLines, /層次面積/gu);
    if (!mainAreas.length && floorAreas.length === 1) {
      mainAreas = floorAreas;
      warnings.add('主建物只有單筆層次面積候選，請確認沒有其他樓層或遺漏的總面積。');
    }
    const mainGroups = new Map();
    for (const entry of mainAreas) {
      const key = areaKey(entry.value);
      if (!mainGroups.has(key)) mainGroups.set(key, { value: entry.value, lines: [] });
      mainGroups.get(key).lines.push(...entry.lines);
    }
    for (const entry of mainGroups.values()) {
      const matchingFloors = floorAreas.filter(floor => areaKey(floor.value) === areaKey(entry.value));
      const sources = [...new Set([...entry.lines, ...matchingFloors.flatMap(floor => floor.lines)])];
      add('main', entry.value, sources);
    }
    if (accessoryStart >= 0) {
      const end = commonStart > accessoryStart ? commonStart : Math.min(body.length, accessoryStart + 4);
      let accessoryLabel = false;
      for (const line of body.slice(accessoryStart, end)) {
        if (/附屬建物|附屬建築物|陽台/u.test(line.compact)) accessoryLabel = true;
        if (accessoryLabel && !remarksPattern.test(line.compact)) for (const value of areas(line.compact)) add('accessory', value, [line]);
      }
    }
    if (commonStart >= 0) {
      const commonEnd = parkingStart > commonStart ? parkingStart : body.length;
      const shared = body.slice(commonStart, commonEnd);
      const groupStarts = shared.flatMap((line, index) => commonSectionPattern.test(line.compact) ? [index] : []);
      for (const [groupIndex, start] of groupStarts.entries()) {
        const group = shared.slice(start, groupStarts[groupIndex + 1]);
        const remarkStart = group.findIndex(line => /其他登記/u.test(line.compact));
        const section = remarkStart < 0 ? group : group.slice(0, remarkStart);
        const ownershipLines = section.filter(line => /權利範圍/u.test(line.compact));
        const hasDirectArea = section.some(line => (commonSectionPattern.test(line.compact) || ownershipLines.includes(line)) && areas(line.compact).length);
        for (const [index, line] of section.entries()) {
          if (/(?:土地|基地)(?:面積|總面積)|基地權利/u.test(line.compact)) continue;
          const directlyLabeled = commonSectionPattern.test(line.compact) || ownershipLines.includes(line);
          const besideOwnership = !hasDirectArea && !/門廊|夾層|屋頂|用途/u.test(line.compact)
            && [section[index - 1], section[index + 1]].some(nearby => ownershipLines.includes(nearby));
          if (!directlyLabeled && !besideOwnership) continue;
          for (const value of areas(line.compact)) add('common', value, [section[0], ...ownershipLines, ...(line !== section[0] && !ownershipLines.includes(line) ? [line] : [])]);
        }
        if (!ownershipLines.length && section.some(line => commonSectionPattern.test(line.compact) && areas(line.compact).length)) {
          warnings.add('已辨識共有部分的原始總面積，但未讀到共有持分；不能當作本戶公設或直接加入總坪數。');
        }
        for (const line of ownershipLines) {
          const next = section[section.indexOf(line) + 1];
          const fractionLines = shares(line.compact).length ? [line] : next && !/門廊|夾層|屋頂|用途/u.test(next.compact) ? [line, next] : [line];
          for (const value of checkedShares(fractionLines.at(-1), warnings, '共有持分')) add('commonShare', value, fractionLines);
        }
      }
    }
    if (parkingStart >= 0) {
      const parking = body.slice(parkingStart, parkingStart + 5);
      for (const [index, line] of parking.entries()) {
        if (index > 0 && /其他登記事項|基地權利|土地/u.test(line.compact)) break;
        if (/權利範圍/u.test(line.compact)) {
          for (const value of checkedShares(line, warnings, '車位持分')) add('parkingShare', value, [...new Set([parking[0], line])]);
          const next = parking[index + 1];
          if (next && !/其他登記事項|基地權利|土地/u.test(next.compact) && !shares(line.compact).length) {
            for (const value of checkedShares(next, warnings, '車位持分')) add('parkingShare', value, [...new Set([parking[0], line, next])]);
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
  if (available.main && available.accessory && available.main.unit === available.accessory.unit
    && scaledArea(available.accessory.value) > scaledArea(available.main.value)) {
    delete available.accessory;
    warnings.add('附屬建物候選大於主建物，可能有小數點漏辨識；保留原文但不自動帶入，請核對原圖。');
  }
  if (!detected) warnings.add('未確認單一建物標示部，請使用下方欄位手動核對，勿套用整份文件的任意數字。');
  return { detected, candidates, available, warnings: [...warnings] };
}
