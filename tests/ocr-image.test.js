import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscriptPixels, horizontalTextBands } from '../src/ocr-image.js';

function image(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function paint(target, left, top, width, height, color = [0, 0, 0, 255]) {
  for (let row = top; row < top + height; row += 1) {
    for (let column = left; column < left + width; column += 1) target.data.set(color, (row * target.width + column) * 4);
  }
}

function pixel(target, column, row) {
  const offset = (row * target.width + column) * 4;
  return Array.from(target.data.slice(offset, offset + 4));
}

test('cleans clearly red watermark pixels without changing the source', () => {
  const original = image(30, 20);
  paint(original, 1, 2, 10, 12, [230, 85, 90, 255]);
  paint(original, 15, 4, 5, 10, [240, 180, 190, 180]);
  const before = new Uint8ClampedArray(original.data);
  const cleaned = cleanTranscriptPixels(original);
  assert.notEqual(cleaned.data, original.data);
  assert.deepEqual(original.data, before);
  assert.deepEqual(pixel(cleaned, 3, 5), [255, 255, 255, 255]);
  assert.deepEqual(pixel(cleaned, 17, 5), [255, 255, 255, 180]);
});

test('preserves black privacy masks, thin text, decimal dots and horizontal strokes', () => {
  const original = image(100, 30);
  paint(original, 5, 2, 80, 6);
  paint(original, 20, 14, 1, 8);
  paint(original, 23, 21, 1, 1);
  paint(original, 1, 26, 98, 1);
  assert.deepEqual(cleanTranscriptPixels(original).data, original.data);
});

test('leaves near-neutral antialiasing and blue ink unchanged', () => {
  const original = image(4, 1);
  original.data.set([90, 70, 75, 255, 245, 230, 230, 255, 45, 60, 210, 255, 125, 90, 100, 255]);
  assert.deepEqual(cleanTranscriptPixels(original).data, original.data);
});

test('finds full-width row strips with exclusive ends and bridges small glyph gaps', () => {
  const original = image(50, 40);
  paint(original, 4, 4, 5, 3);
  paint(original, 4, 8, 5, 2);
  paint(original, 9, 20, 5, 5);
  paint(original, 1, 0, 20, 1, [220, 30, 45, 255]);
  const before = new Uint8ClampedArray(original.data);
  assert.deepEqual(horizontalTextBands(original), [
    { x0: 0, y0: 2, x1: 50, y1: 12 },
    { x0: 0, y0: 18, x1: 50, y1: 27 },
  ]);
  assert.deepEqual(original.data, before);
});

test('row detection ignores transparent black and isolated specks by default', () => {
  const original = image(20, 15);
  paint(original, 0, 1, 15, 2, [0, 0, 0, 0]);
  paint(original, 6, 7, 1, 1);
  assert.deepEqual(horizontalTextBands(original), []);
  assert.deepEqual(horizontalTextBands(original, { minRowPixels: 1, padding: 0 }), [{ x0: 0, y0: 7, x1: 20, y1: 8 }]);
});

test('padding stays within the image and merges overlapping crops', () => {
  const original = image(20, 12);
  paint(original, 1, 0, 2, 1);
  paint(original, 1, 4, 2, 1);
  paint(original, 1, 11, 2, 1);
  assert.deepEqual(horizontalTextBands(original, { maxGap: 0, padding: 3 }), [{ x0: 0, y0: 0, x1: 20, y1: 12 }]);
});

test('empty white pages have no row strips', () => {
  assert.deepEqual(horizontalTextBands(image(50, 30)), []);
});

test('rejects malformed image geometry and crop settings', () => {
  assert.throws(() => cleanTranscriptPixels({ width: -1, height: 1, data: new Uint8ClampedArray(4) }), RangeError);
  assert.throws(() => horizontalTextBands({ width: 2, height: 1, data: new Uint8ClampedArray(4) }), TypeError);
  for (const options of [{ minRowPixels: 0 }, { maxGap: -1 }, { padding: 1.5 }]) assert.throws(() => horizontalTextBands(image(5, 5), options), RangeError);
});
