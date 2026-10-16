const fieldNames = ['main', 'accessory', 'common', 'parking', 'total', 'land'];

const labelPatterns = [
  ['main', /主建物(?:總面積|面積|坪數)?/gu],
  ['accessory', /附屬建物(?:總面積|面積|坪數)?|附屬(?:面積|坪數)/gu],
  ['common', /(?:共有|共用)(?:部分|部份)?(?:總面積|面積|坪數)?|公設(?:總面積|面積|坪數)?|公共設施(?:總面積|面積|坪數)?/gu],
  ['parking', /(?:停車位|車位|停車空間)(?:登記|持分)?(?:總面積|面積|坪數)?|停車場面積/gu],
  ['total', /建物(?:總面積|總坪數|面積合計|面積)|總(?:建物面積|坪數|建坪|面積)|權狀(?:面積|坪數)|登記總面積|合計(?:面積|坪數)|建坪/gu],
  ['land', /土地(?:總面積|面積|坪數)?|基地(?:總面積|面積|坪數)?/gu],
];

const unitPattern = /平方公尺|平方米|m\s*(?:\^\s*)?2(?!\d)|坪/giu;
const numberPattern = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu;
const sharedOwnershipPattern = /持分|權利範圍|應有部分|應有部份|分之|分子|分母/u;
const nonAreaGapPattern = /用途|構造|層次|戶數|數量|編號|號碼|單價|總價|售價|價款|價格|日期|年度|年份|公設比/u;

function normalizeText(text) {
  return text.normalize('NFKC').replace(/[−﹣]/gu, '-');
}

function classifyUnit(text) {
  if (/平方公尺|平方米|m\s*(?:\^\s*)?2/iu.test(text)) return 'sqm';
  if (/坪/u.test(text)) return 'ping';
  return 'unknown';
}

function findUnits(text) {
  return Array.from(text.matchAll(unitPattern), match => ({
    start: match.index,
    end: match.index + match[0].length,
    unit: classifyUnit(match[0]),
  }));
}

function findLabels(text) {
  const labels = labelPatterns.flatMap(([field, pattern]) =>
    Array.from(text.matchAll(pattern), match => ({
      field,
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })),
  ).filter(label => {
    const suffix = text.slice(label.end);
    if (label.field === 'common' && /^(?:比|比例)/u.test(suffix)) return false;
    if (label.field === 'parking' && /^(?:數量?|編號|號碼|單價|價格|價款|價)/u.test(suffix)) return false;
    return true;
  }).sort((first, second) => first.start - second.start || second.end - first.end);

  return labels.filter((label, index) =>
    !labels.slice(0, index).some(previous => previous.end > label.start),
  );
}

function findLabel(text, labels, start, end) {
  const preceding = labels.filter(label => label.end <= start).at(-1);
  if (preceding && start - preceding.end <= 40) {
    const gap = text.slice(preceding.end, start);
    if (!nonAreaGapPattern.test(gap) && !/[;；。]/u.test(gap)) return preceding;
  }
  const following = labels.find(label => label.start >= end);
  if (following && following.start - end <= 10) {
    const gap = text.slice(end, following.start).replace(unitPattern, '');
    if (/^[\s:：()（）\[\]【】]*$/u.test(gap)) return following;
  }
  return null;
}

function excludedNumber(text, start, end, units) {
  if (units.some(unit => start < unit.end && end > unit.start)) return true;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (/[\d.,/／]$/u.test(before) || /^[\d.,/／]/u.test(after)) return true;
  if (/[A-Za-z]$/u.test(before) && !/[mM]$/u.test(before)) return true;
  if (/^\s*(?:%|元|萬元|億元|個|格|輛|戶|位|房|廳|衛|棟|筆|年|月|日|樓|層|F\b)/iu.test(after)) return true;
  if (/(?:總價|單價|售價|價格|價款|戶號|室號|建號|地號|編號|日期)\s*[:：]?\s*$/u.test(before)) return true;
  if (/\d\s*[-年/]\s*$/u.test(before) || /^\s*[-年/]\s*\d/u.test(after)) return true;
  return false;
}

function inferUnit(text, label, start, end, units, unitHint) {
  const immediate = units.find(unit => unit.start >= end && /^\s*$/u.test(text.slice(end, unit.start)));
  if (immediate) return { unit: immediate.unit, explicit: true };
  if (label) {
    const prefixUnits = units.filter(unit => unit.start >= label.end && unit.end <= start);
    const localUnits = [...new Set(prefixUnits.map(unit => unit.unit))];
    if (localUnits.length === 1) return { unit: localUnits[0], explicit: true };
    if (/坪數|建坪/u.test(label.text)) return { unit: 'ping', explicit: false };
    if (unitHint === 'sqm' || unitHint === 'ping') return { unit: unitHint, explicit: false };
  }
  return { unit: 'unknown', explicit: false };
}

function neighboringSharedRisk(records, index, extraText = '') {
  const current = records[index];
  const nearby = records.slice(Math.max(0, index - 2), index + 3).filter(record =>
    current.pageNumber == null || record.pageNumber == null || current.pageNumber === record.pageNumber,
  ).map(record => normalizeText(record.text)).concat(normalizeText(extraText)).join('\n');
  return /共有|共用|公設|公共設施/u.test(nearby)
    && /總面積|面積總計|面積合計|權利範圍|持分|應有部分|應有部份|分之/u.test(nearby);
}

function prepareReadingRecords(records) {
  return records.flatMap((record, index) => {
    const cells = (Array.isArray(record.cells) ? record.cells : []).filter(cell => cell && typeof cell.text === 'string');
    const householdText = [record.text, ...cells.map(cell => `${cell.header ?? ''} ${cell.text}`)].join('\n');
    const areaCells = cells.filter(cell => {
      if (typeof cell.header !== 'string') return false;
      const header = normalizeText(cell.header);
      const value = normalizeText(cell.text).trim();
      return /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u.test(value)
        && findLabels(header).length === 1
        && !nonAreaGapPattern.test(header);
    });
    if (areaCells.length === 0) {
      return [{ ...record, householdText, sharedNearbyRisk: neighboringSharedRisk(records, index) }];
    }
    return areaCells.map(cell => ({
      ...record,
      text: `${cell.header} ${cell.text}`,
      traceText: `欄位原文：${cell.header}\n儲存格原文：${cell.text}\n原列文字：${record.text}`,
      originalText: record.text,
      source: `${typeof record.source === 'string' ? record.source : ''}／儲存格 ${cell.address ?? '位置未提供'}`,
      unitHint: cell.unitHint ?? record.unitHint,
      householdText,
      sharedNearbyRisk: neighboringSharedRisk(records, index, cell.header),
    }));
  });
}

export function extractCandidates(records) {
  const candidates = [];
  const warnings = new Set();
  const unsafeIds = new Set();
  const householdIds = new Set();
  const suggestions = Object.fromEntries(fieldNames.map(field => [field, null]));
  const validRecords = (Array.isArray(records) ? records : []).filter(record => record && typeof record.text === 'string');

  for (const record of prepareReadingRecords(validRecords)) {
    const source = typeof record.source === 'string' ? record.source : '';
    const rawText = record.text;
    const normalizedRecord = normalizeText(`${rawText}\n${record.originalText ?? ''}`);
    const recordHasOwnership = sharedOwnershipPattern.test(normalizedRecord);
    const recordHasSharedTotal = /(?:共有|共用|公設|公共設施)[^;；。]{0,20}(?:總面積|面積總計|面積合計)/u.test(normalizedRecord);
    const nearbySharedRisk = record.sharedNearbyRisk;
    const normalizedHouseholds = normalizeText(record.householdText ?? rawText);
    for (const household of normalizedHouseholds.matchAll(/(?:戶號|戶別|室號)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]*)/gu)) {
      householdIds.add(household[1].toUpperCase());
    }

    for (const rawLine of rawText.split(/\r?\n/u)) {
      const line = normalizeText(rawLine);
      const labels = findLabels(line);
      const units = findUnits(line);

      for (const match of line.matchAll(numberPattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (excludedNumber(line, start, end, units)) continue;
        const label = findLabel(line, labels, start, end);
        const inferred = inferUnit(line, label, start, end, units, record.unitHint);
        if (!label && inferred.unit === 'unknown') continue;
        if (label && nonAreaGapPattern.test(line.slice(label.end, start))) continue;
        const value = match[0].replace(/,/gu, '').replace(/^\+/u, '');
        const candidate = {
          id: `candidate-${candidates.length + 1}`,
          field: label?.field ?? 'unknown',
          value,
          unit: inferred.unit,
          source,
          text: record.traceText ?? rawText,
        };
        candidates.push(candidate);

        if (!Number.isFinite(Number(value)) || Number(value) < 0) {
          unsafeIds.add(candidate.id);
          warnings.add('發現負值或無效面積，不會自動帶入，請核對原文件。');
        }
        if (candidate.unit === 'unknown') {
          unsafeIds.add(candidate.id);
          warnings.add('部分面積沒有明確單位，請核對原文件後手動選擇平方公尺或坪。');
        }
        if (recordHasOwnership) {
          unsafeIds.add(candidate.id);
          warnings.add('來源包含持分或權利範圍，未確認是本戶面積前不會自動帶入。');
        }
        if ((candidate.field === 'common' || candidate.field === 'total') && recordHasSharedTotal) {
          unsafeIds.add(candidate.id);
          warnings.add('共用部分總面積可能是整棟面積，不代表本戶公設，請先核對持分。');
        }
        if (candidate.field === 'common' && nearbySharedRisk) {
          unsafeIds.add(candidate.id);
          warnings.add('鄰近資料含共有總面積或權利範圍，公設面積需人工核對持分，不會自動帶入。');
        }
        if (candidate.field === 'unknown' && nearbySharedRisk) {
          warnings.add('鄰近資料含共有總面積或權利範圍，未分類面積可能是整棟數值，請人工核對持分。');
        }
        if (label && /坪數|建坪/u.test(label.text) && inferred.explicit && inferred.unit !== 'ping') {
          unsafeIds.add(candidate.id);
          warnings.add('欄位名稱與數值單位不一致，請核對原文件。');
        }
        if (inferred.explicit && (record.unitHint === 'sqm' || record.unitHint === 'ping') && record.unitHint !== inferred.unit) {
          unsafeIds.add(candidate.id);
          warnings.add('表頭單位與數值單位不一致，請核對原文件。');
        }
      }
    }
  }

  const grouped = Object.fromEntries(fieldNames.map(field => [
    field,
    candidates.filter(candidate => candidate.field === field),
  ]));
  const hasRepeatedField = fieldNames.some(field => grouped[field].length > 1);
  if (hasRepeatedField || householdIds.size > 1) {
    warnings.add('偵測到重複欄位或多筆戶別候選，請逐項選擇，不會自動帶入。');
  } else {
    for (const field of fieldNames) {
      const candidate = grouped[field][0];
      if (candidate && !unsafeIds.has(candidate.id)) suggestions[field] = candidate.id;
    }
  }

  if (candidates.length === 0) warnings.add('未找到可確認的面積候選，請檢查辨識文字或手動輸入。');
  return { candidates, suggestions, warnings: [...warnings] };
}
