import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAreas } from '../src/core.js';

function createInput(overrides = {}) {
  return {
    fields: {
      main: { value: '70', unit: 'sqm' },
      accessory: { value: '10', unit: 'sqm' },
      common: { value: '50', unit: 'sqm' },
      parking: { value: '20', unit: 'sqm' },
      ...overrides.fields,
    },
    commonScope: 'household',
    commonIncludesParking: 'included',
    shareNumerator: '',
    shareDenominator: '',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'fields')),
  };
}

test('converts square metres and calculates included-parking totals without double counting', () => {
  const result = calculateAreas(createInput());
  assert.deepEqual(result.display, {
    main: '21.18 坪',
    accessory: '3.03 坪',
    common: '15.13 坪',
    parking: '6.05 坪',
    public: '9.08 坪',
    without: '33.28 坪',
    with: '39.33 坪',
    ratio: '27.27%',
  });
  assert.deepEqual(result.errors, []);
});

test('keeps ping inputs unchanged and supports mixed units', () => {
  const result = calculateAreas(createInput({ fields: {
    main: { value: '20', unit: 'ping' },
    common: { value: '15', unit: 'ping' },
    parking: { value: '5', unit: 'ping' },
  } }));
  assert.equal(result.display.main, '20.00 坪');
  assert.equal(result.display.accessory, '3.03 坪');
  assert.equal(result.display.public, '10.00 坪');
  assert.equal(result.display.with, '38.03 坪');
  assert.equal(result.display.without, '33.03 坪');
});

test('rounds decimal ties half up using exact decimal values', () => {
  const result = calculateAreas(createInput({ fields: {
    main: { value: '1.005', unit: 'ping' },
    accessory: { value: '2.675', unit: 'ping' },
    common: { value: '0.015', unit: 'ping' },
    parking: { value: '0', unit: 'ping' },
  } }));
  assert.equal(result.display.main, '1.01 坪');
  assert.equal(result.display.accessory, '2.68 坪');
  assert.equal(result.display.common, '0.02 坪');
  assert.equal(result.display.without, '3.70 坪');
});

test('sums exact values rather than rounded display values', () => {
  const result = calculateAreas(createInput({ fields: {
    main: { value: '1', unit: 'sqm' },
    accessory: { value: '1', unit: 'sqm' },
    common: { value: '1', unit: 'sqm' },
    parking: { value: '0', unit: 'sqm' },
  } }));
  assert.equal(result.display.main, '0.30 坪');
  assert.equal(result.display.with, '0.91 坪');
  assert.equal(result.display.ratio, '33.33%');
});

test('does not interpret missing or whitespace inputs as zero', () => {
  const result = calculateAreas(createInput({ fields: { accessory: { value: '  ', unit: 'sqm' } } }));
  assert.equal(result.display.accessory, '待確認');
  assert.equal(result.display.public, '9.08 坪');
  assert.equal(result.display.with, '待確認');
  assert.equal(result.display.without, '待確認');
  assert.equal(result.raw.fields.accessory.status, 'missing');
});

test('accepts explicit zero as a known value', () => {
  const result = calculateAreas(createInput({ fields: { accessory: { value: '0', unit: 'sqm' } } }));
  assert.equal(result.display.accessory, '0.00 坪');
  assert.equal(result.display.without, '30.25 坪');
  assert.equal(result.errors.length, 0);
});

test('included parking can calculate inclusive total when parking is missing', () => {
  const result = calculateAreas(createInput({ fields: { parking: { value: '', unit: 'sqm' } } }));
  assert.equal(result.display.with, '39.33 坪');
  assert.equal(result.display.public, '待確認');
  assert.equal(result.display.without, '待確認');
  assert.equal(result.display.ratio, '待確認');
});

test('invalid parking blocks totals that depend on included-parking confirmation', () => {
  const result = calculateAreas(createInput({ fields: { parking: { value: '??', unit: 'sqm' } } }));
  assert.equal(result.display.with, '待確認');
  assert.equal(result.display.without, '待確認');
  assert.equal(result.errors[0].field, 'parking');
});

test('excluded parking does not require a parking value for the public ratio', () => {
  const result = calculateAreas(createInput({
    commonIncludesParking: 'excluded',
    fields: { parking: { value: '', unit: 'sqm' } },
  }));
  assert.equal(result.display.public, '15.13 坪');
  assert.equal(result.display.without, '39.33 坪');
  assert.equal(result.display.ratio, '38.46%');
  assert.equal(result.display.with, '待確認');
});

test('excluded parking adds the independent parking amount exactly once', () => {
  const result = calculateAreas(createInput({ commonIncludesParking: 'excluded' }));
  assert.equal(result.display.without, '39.33 坪');
  assert.equal(result.display.with, '45.38 坪');
});

test('unknown parking relation does not guess derived values, even when parking is zero', () => {
  const result = calculateAreas(createInput({
    commonIncludesParking: 'unknown',
    fields: { parking: { value: '0', unit: 'sqm' } },
  }));
  assert.equal(result.display.common, '15.13 坪');
  for (const fieldName of ['public', 'without', 'with', 'ratio']) assert.equal(result.display[fieldName], '待確認');
});

test('included parking larger than household common blocks all derived totals', () => {
  const result = calculateAreas(createInput({ fields: { parking: { value: '51', unit: 'sqm' } } }));
  assert.ok(result.errors.some((error) => error.field === 'parking'));
  for (const fieldName of ['public', 'without', 'with', 'ratio']) assert.equal(result.display[fieldName], '待確認');
});

test('separate parking may be larger than common without being rejected', () => {
  const result = calculateAreas(createInput({
    commonIncludesParking: 'excluded',
    fields: { parking: { value: '60', unit: 'sqm' } },
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.display.with, '57.48 坪');
});

test('applies a confirmed ownership fraction only to whole common area', () => {
  const result = calculateAreas(createInput({
    commonScope: 'whole',
    shareNumerator: '1',
    shareDenominator: '2',
    shareConfirmed: true,
    fields: { common: { value: '100', unit: 'sqm' } },
  }));
  assert.equal(result.display.common, '15.13 坪');
  assert.equal(result.display.with, '39.33 坪');
  assert.equal(result.raw.share.applied, true);
  assert.deepEqual(result.raw.fields.common.ping, { numerator: '121', denominator: '4' });
  assert.deepEqual(result.raw.values.common, { numerator: '121', denominator: '8' });
});

test('does not apply an unconfirmed ownership fraction', () => {
  const result = calculateAreas(createInput({ commonScope: 'whole', shareNumerator: '1', shareDenominator: '2' }));
  assert.equal(result.display.common, '待確認');
  assert.equal(result.display.with, '待確認');
  assert.equal(result.raw.share.applied, false);
});

test('does not apply ownership a second time to household common', () => {
  const result = calculateAreas(createInput({ shareNumerator: '1', shareDenominator: '20', shareConfirmed: true }));
  assert.equal(result.display.common, '15.13 坪');
  assert.equal(result.raw.share.applied, false);
});

test('unknown common scope does not presume that whole common belongs to the household', () => {
  const result = calculateAreas(createInput({ commonScope: 'unknown' }));
  assert.equal(result.display.common, '待確認');
  assert.equal(result.display.with, '待確認');
  assert.equal(result.display.main, '21.18 坪');
});

for (const [numerator, denominator] of [['0', '1'], ['1', '0'], ['2', '1'], ['1.5', '2'], ['1', ''], ['1e2', '200'], ['1000000000000', '1000000000000']]) {
  test(`rejects invalid confirmed ownership ${numerator}/${denominator}`, () => {
    const result = calculateAreas(createInput({
      commonScope: 'whole',
      shareNumerator: numerator,
      shareDenominator: denominator,
      shareConfirmed: true,
    }));
    assert.ok(result.errors.length > 0);
    assert.equal(result.display.common, '待確認');
  });
}

test('checks parking against household common after ownership allocation', () => {
  const result = calculateAreas(createInput({
    commonScope: 'whole',
    shareNumerator: '1',
    shareDenominator: '10',
    shareConfirmed: true,
  }));
  assert.ok(result.errors.some((error) => error.field === 'parking'));
  assert.equal(result.display.with, '待確認');
});

for (const invalidValue of ['-1', 'abc', 'NaN', 'Infinity', '1e3', '1,000', '1.123456789', '1000000000.00000001']) {
  test(`rejects invalid area ${invalidValue}`, () => {
    const result = calculateAreas(createInput({ fields: { main: { value: invalidValue, unit: 'sqm' } } }));
    assert.ok(result.errors.some((error) => error.field === 'main'));
    assert.equal(result.display.main, '待確認');
    assert.equal(result.display.with, '待確認');
  });
}

test('accepts up to eight decimal digits and the maximum area', () => {
  const precise = calculateAreas(createInput({ fields: { main: { value: '.12345678', unit: 'sqm' } } }));
  assert.equal(precise.display.main, '0.04 坪');
  assert.deepEqual(precise.raw.fields.main.source, { numerator: '6172839', denominator: '50000000' });
  const maximum = calculateAreas(createInput({ fields: { main: { value: '1000000000', unit: 'sqm' } } }));
  assert.equal(maximum.display.main, '302500000.00 坪');
  assert.deepEqual(maximum.errors, []);
});

test('does not guess an unknown or missing unit', () => {
  const result = calculateAreas(createInput({ fields: { main: { value: '70', unit: 'm2' } } }));
  assert.equal(result.display.main, '待確認');
  assert.equal(result.errors[0].field, 'main');
});

test('all-zero known areas show zero totals but no invented ratio', () => {
  const zeroFields = Object.fromEntries(['main', 'accessory', 'common', 'parking'].map((fieldName) => [fieldName, { value: '0', unit: 'sqm' }]));
  const result = calculateAreas(createInput({ fields: zeroFields }));
  assert.equal(result.display.with, '0.00 坪');
  assert.equal(result.display.without, '0.00 坪');
  assert.equal(result.display.public, '0.00 坪');
  assert.equal(result.display.ratio, '待確認');
  assert.ok(result.warnings.some((warning) => warning.includes('無法計算公設比')));
});

test('never adds land or unrecognized fields to building totals', () => {
  const result = calculateAreas(createInput({ fields: { land: { value: '999999', unit: 'ping' } } }));
  assert.equal(result.display.with, '39.33 坪');
  assert.equal(Object.hasOwn(result.raw.fields, 'land'), false);
});

test('returns JSON-serializable exact provenance and does not mutate input', () => {
  const input = createInput();
  const snapshot = JSON.stringify(input);
  const result = calculateAreas(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.deepEqual(result.raw.sqmToPing, { numerator: '121', denominator: '400' });
  assert.deepEqual(result.raw.values.ratio, { numerator: '300', denominator: '11' });
});

test('handles omitted input and non-object input without inventing zero values', () => {
  for (const input of [undefined, null, false]) {
    const result = calculateAreas(input);
    assert.equal(result.display.main, '待確認');
    assert.equal(result.display.with, '待確認');
    assert.doesNotThrow(() => JSON.stringify(result));
  }
});

test('rejects invalid relationship enums without deriving totals', () => {
  const result = calculateAreas(createInput({ commonScope: 'invalid', commonIncludesParking: 'invalid' }));
  assert.ok(result.errors.some((error) => error.field === 'commonScope'));
  assert.ok(result.errors.some((error) => error.field === 'commonIncludesParking'));
  assert.equal(result.display.with, '待確認');
});

test('separate parking share uses the unallocated common area exactly once', () => {
  const result = calculateAreas(createInput({
    fields: { main: { value: '60', unit: 'sqm' }, accessory: { value: '5', unit: 'sqm' }, common: { value: '10000', unit: 'sqm' }, parking: { value: 'stale', unit: 'unknown' } },
    commonScope: 'whole', shareNumerator: '600', shareDenominator: '100000', shareConfirmed: true,
    parkingScope: 'common', parkingShareNumerator: '300', parkingShareDenominator: '100000', parkingShareConfirmed: true,
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.display.common, '18.15 坪');
  assert.equal(result.display.parking, '9.08 坪');
  assert.equal(result.display.public, '9.08 坪');
  assert.equal(result.display.with, '37.81 坪');
  assert.equal(result.display.without, '28.74 坪');
  assert.equal(result.display.ratio, '31.58%');
  assert.equal(result.raw.parkingShare.applied, true);
  assert.deepEqual(result.raw.values.parking, { numerator: '363', denominator: '40' });
});

test('parking share requires its own confirmation and never reuses common ownership', () => {
  const result = calculateAreas(createInput({ commonScope: 'whole', shareNumerator: '1', shareDenominator: '2', shareConfirmed: true, parkingScope: 'common', parkingShareNumerator: '1', parkingShareDenominator: '4' }));
  assert.equal(result.display.parking, '待確認');
  assert.equal(result.display.public, '待確認');
  assert.equal(result.raw.parkingShare.applied, false);
});

test('parking share refuses a household common base or an invalid scope', () => {
  const result = calculateAreas(createInput({ parkingScope: 'common', parkingShareNumerator: '1', parkingShareDenominator: '4', parkingShareConfirmed: true }));
  assert.ok(result.errors.some(error => error.field === 'parkingScope'));
  assert.equal(result.display.parking, '待確認');
  const invalid = calculateAreas(createInput({ parkingScope: 'invalid' }));
  assert.ok(invalid.errors.some(error => error.field === 'parkingScope'));
  assert.equal(invalid.display.parking, '待確認');
});

for (const [numerator, denominator] of [['0', '1'], ['1', '0'], ['2', '1'], ['1.2', '3'], ['1', ''], ['1e2', '200']]) {
  test(`rejects invalid parking ownership ${numerator}/${denominator}`, () => {
    const result = calculateAreas(createInput({ commonScope: 'whole', parkingScope: 'common', parkingShareNumerator: numerator, parkingShareDenominator: denominator, parkingShareConfirmed: true }));
    assert.ok(result.errors.some(error => error.field.startsWith('parkingShare')));
    assert.equal(result.display.parking, '待確認');
  });
}

test('parking share larger than allocated common area blocks dependent totals', () => {
  const result = calculateAreas(createInput({ commonScope: 'whole', shareNumerator: '1', shareDenominator: '4', shareConfirmed: true, parkingScope: 'common', parkingShareNumerator: '1', parkingShareDenominator: '2', parkingShareConfirmed: true }));
  assert.ok(result.errors.some(error => error.field === 'parking'));
  assert.equal(result.display.with, '待確認');
});
