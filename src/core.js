const PENDING = '待確認';
const MAXIMUM_AREA = 1000000000n;
const AREA_LABELS = {
  main: '主建物',
  accessory: '附屬建物',
  common: '共有部分',
  parking: '車位',
};

function greatestCommonDivisor(first, second) {
  let dividend = first < 0n ? -first : first;
  let divisor = second < 0n ? -second : second;
  while (divisor !== 0n) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend || 1n;
}

function rational(numerator, denominator = 1n) {
  const sign = denominator < 0n ? -1n : 1n;
  const commonDivisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator * sign / commonDivisor,
    denominator: denominator * sign / commonDivisor,
  };
}

function multiply(first, second) {
  return rational(first.numerator * second.numerator, first.denominator * second.denominator);
}

function add(first, second) {
  return rational(
    first.numerator * second.denominator + second.numerator * first.denominator,
    first.denominator * second.denominator,
  );
}

function subtract(first, second) {
  return rational(
    first.numerator * second.denominator - second.numerator * first.denominator,
    first.denominator * second.denominator,
  );
}

function isGreaterThan(first, second) {
  return first.numerator * second.denominator > second.numerator * first.denominator;
}

function sourceText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value).trim();
  return '[非數值資料]';
}

function serializeRational(value) {
  if (!value) return null;
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function formatDecimal(value) {
  const absoluteNumerator = value.numerator < 0n ? -value.numerator : value.numerator;
  const scaledNumerator = absoluteNumerator * 100n;
  let rounded = scaledNumerator / value.denominator;
  if ((scaledNumerator % value.denominator) * 2n >= value.denominator) rounded += 1n;
  const negativeSign = value.numerator < 0n && rounded !== 0n ? '-' : '';
  return `${negativeSign}${rounded / 100n}.${(rounded % 100n).toString().padStart(2, '0')}`;
}

function parseArea(fieldName, fieldInput, errors) {
  const field = fieldInput && typeof fieldInput === 'object' ? fieldInput : {};
  const value = sourceText(field.value);
  const unit = field.unit === 'sqm' || field.unit === 'ping' ? field.unit : null;
  const result = { value, unit, status: 'missing', source: null, ping: null };
  if (!value) return result;
  result.status = 'invalid';
  if (!unit) {
    errors.push({ field: fieldName, message: `${AREA_LABELS[fieldName]}請明確選擇平方公尺或坪。` });
    return result;
  }
  if (value.startsWith('-')) {
    errors.push({ field: fieldName, message: `${AREA_LABELS[fieldName]}不可為負數。` });
    return result;
  }
  if (value.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    errors.push({ field: fieldName, message: `${AREA_LABELS[fieldName]}請輸入不含逗號或其他文字的十進位數字。` });
    return result;
  }
  const [integerPart = '0', decimalPart = ''] = value.split('.');
  if (decimalPart.length > 8) {
    errors.push({ field: fieldName, message: `${AREA_LABELS[fieldName]}最多可輸入 8 位小數。` });
    return result;
  }
  const denominator = 10n ** BigInt(decimalPart.length);
  const numerator = BigInt(`${integerPart || '0'}${decimalPart}`);
  if (numerator > MAXIMUM_AREA * denominator) {
    errors.push({ field: fieldName, message: `${AREA_LABELS[fieldName]}不得超過 1,000,000,000，請核對原始文件。` });
    return result;
  }
  result.status = 'valid';
  result.source = rational(numerator, denominator);
  result.ping = unit === 'sqm' ? multiply(result.source, rational(121n, 400n)) : result.source;
  return result;
}

function parseShare(input, errors, warnings, parking = false) {
  const numeratorField = parking ? 'parkingShareNumerator' : 'shareNumerator';
  const denominatorField = parking ? 'parkingShareDenominator' : 'shareDenominator';
  const numeratorText = sourceText(input[numeratorField]);
  const denominatorText = sourceText(input[denominatorField]);
  const confirmed = input[parking ? 'parkingShareConfirmed' : 'shareConfirmed'] === true;
  const label = parking ? '車位持分' : '持分';
  const result = { numerator: numeratorText, denominator: denominatorText, confirmed, fraction: null, applied: false };
  if (parking ? input.parkingScope !== 'common' : input.commonScope !== 'whole') return result;
  const shareErrorsBefore = errors.length;
  for (const [fieldName, value, partLabel] of [
    [numeratorField, numeratorText, `${label}分子`],
    [denominatorField, denominatorText, `${label}分母`],
  ]) {
    if (!value && !confirmed) continue;
    if (!/^[0-9]{1,12}$/.test(value) || BigInt(value) <= 0n) {
      errors.push({ field: fieldName, message: `${partLabel}須為 1 至 999,999,999,999 的整數。` });
    }
  }
  if (errors.length !== shareErrorsBefore) return result;
  if (numeratorText && denominatorText) {
    if (BigInt(numeratorText) > BigInt(denominatorText)) {
      errors.push({ field: numeratorField, message: `${label}分子不得大於分母。` });
      return result;
    }
    result.fraction = rational(BigInt(numeratorText), BigInt(denominatorText));
  }
  if (!confirmed || !result.fraction) {
    warnings.push(parking ? '車位持分必須另填分子、分母並確認適用同一筆共有總面積，才會計算本戶車位面積。' : '整體共有面積必須填寫並勾選確認持分，才會計算本戶共有面積。');
    return result;
  }
  result.applied = true;
  return result;
}

function sumIfComplete(...values) {
  if (values.some((value) => !value)) return null;
  return values.reduce((total, value) => add(total, value), rational(0n));
}

export function calculateAreas(input = {}) {
  const safeInput = input && typeof input === 'object' ? input : {};
  const errors = [];
  const warnings = [];
  const sourceFields = safeInput.fields && typeof safeInput.fields === 'object' ? safeInput.fields : {};
  const parkingScope = safeInput.parkingScope ?? 'household';
  const fields = Object.fromEntries(Object.keys(AREA_LABELS).map((fieldName) => [
    fieldName,
    parseArea(fieldName, fieldName === 'parking' && parkingScope === 'common' ? {} : sourceFields[fieldName], errors),
  ]));
  const commonScope = safeInput.commonScope ?? 'unknown';
  const commonIncludesParking = safeInput.commonIncludesParking ?? 'unknown';
  if (!['household', 'whole', 'unknown'].includes(commonScope)) {
    errors.push({ field: 'commonScope', message: '請選擇有效的共有部分範圍。' });
  }
  if (!['included', 'excluded', 'unknown'].includes(commonIncludesParking)) {
    errors.push({ field: 'commonIncludesParking', message: '請選擇有效的共有部分與車位關係。' });
  }
  if (!['household', 'common'].includes(parkingScope)) {
    errors.push({ field: 'parkingScope', message: '請選擇有效的車位面積換算方式。' });
  }
  if (parkingScope === 'common' && commonScope !== 'whole') {
    errors.push({ field: 'parkingScope', message: '車位按共有總面積持分換算時，上方共有範圍必須選全棟／全層；不能對本戶共有面積再乘一次持分。' });
  }
  const share = parseShare({ ...safeInput, commonScope }, errors, warnings);
  const parkingShare = parseShare({ ...safeInput, parkingScope }, errors, warnings, true);
  if (parkingScope === 'common' && (commonScope !== 'whole' || !fields.common.ping)) parkingShare.applied = false;
  const values = {
    main: fields.main.ping,
    accessory: fields.accessory.ping,
    common: null,
    parking: parkingScope === 'household' ? fields.parking.ping : null,
    public: null,
    without: null,
    with: null,
    ratio: null,
  };
  if (commonScope === 'household') values.common = fields.common.ping;
  if (commonScope === 'whole' && share.applied && fields.common.ping) {
    values.common = multiply(fields.common.ping, share.fraction);
  }
  if (parkingScope === 'common' && commonScope === 'whole' && parkingShare.applied && fields.common.ping) {
    values.parking = multiply(fields.common.ping, parkingShare.fraction);
  }
  if (commonScope === 'unknown') {
    warnings.push('共有部分尚未確認為本戶面積或整體面積，不會推算本戶共有及相關合計。');
  }
  if (commonIncludesParking === 'included' && values.common) {
    const parkingExceedsCommon = values.parking && isGreaterThan(values.parking, values.common);
    if (parkingExceedsCommon) {
      errors.push({ field: 'parking', message: '共有部分已含車位時，車位面積不得大於本戶共有面積，請核對文件。' });
    } else {
      if (values.parking) values.public = subtract(values.common, values.parking);
      values.without = sumIfComplete(values.main, values.accessory, values.public);
      if (fields.parking.status !== 'invalid') values.with = sumIfComplete(values.main, values.accessory, values.common);
      if (!values.parking && fields.parking.status === 'missing') {
        warnings.push('共有部分已含車位但未提供車位面積，只能計算含車位總坪數，不能拆算公設及扣車位結果。');
      }
    }
  }
  if (commonIncludesParking === 'excluded' && values.common) {
    values.public = values.common;
    values.without = sumIfComplete(values.main, values.accessory, values.public);
    values.with = sumIfComplete(values.without, values.parking);
  }
  if (commonIncludesParking === 'unknown') {
    warnings.push('共有部分是否已包含車位尚未確認，不會猜測公設、總坪數或公設比。');
  }
  if (values.public && values.without) {
    if (values.without.numerator === 0n) {
      warnings.push('不含車位總坪數為 0，無法計算公設比。');
    } else {
      values.ratio = rational(
        values.public.numerator * values.without.denominator * 100n,
        values.public.denominator * values.without.numerator,
      );
    }
  }
  const missingLabels = Object.entries(fields)
    .filter(([fieldName, field]) => field.status === 'missing' && !(fieldName === 'parking' && parkingScope === 'common'))
    .map(([fieldName]) => AREA_LABELS[fieldName]);
  if (missingLabels.length) {
    warnings.push(`尚未提供${missingLabels.join('、')}；空白不視為 0，無法確定的結果會標示待確認。`);
  }
  const display = Object.fromEntries(Object.entries(values).map(([fieldName, value]) => [
    fieldName,
    value ? `${formatDecimal(value)}${fieldName === 'ratio' ? '%' : ' 坪'}` : PENDING,
  ]));
  const serializedFields = Object.fromEntries(Object.entries(fields).map(([fieldName, field]) => [
    fieldName,
    { ...field, source: serializeRational(field.source), ping: serializeRational(field.ping) },
  ]));
  return {
    errors,
    warnings,
    display,
    raw: {
      version: 2,
      sqmToPing: { numerator: '121', denominator: '400' },
      fields: serializedFields,
      commonScope,
      commonIncludesParking,
      parkingScope,
      share: { ...share, fraction: serializeRational(share.fraction) },
      parkingShare: { ...parkingShare, fraction: serializeRational(parkingShare.fraction) },
      values: Object.fromEntries(Object.entries(values).map(([fieldName, value]) => [fieldName, serializeRational(value)])),
    },
  };
}
