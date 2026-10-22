function readPixels(imageData) {
  const { width, height, data } = imageData || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(width * height * 4)) {
    throw new RangeError('圖片尺寸必須是有效的正整數。');
  }
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new TypeError('圖片像素資料與尺寸不符。');
  }
  return { width, height, data };
}

function clearlyRed(red, green, blue) {
  return red > green + 35 && red > blue + 25;
}

export function cleanTranscriptPixels(imageData) {
  const { width, height, data: original } = readPixels(imageData);
  const data = new Uint8ClampedArray(original);
  for (let offset = 0; offset < data.length; offset += 4) {
    if (!clearlyRed(data[offset], data[offset + 1], data[offset + 2])) continue;
    data[offset] = 255;
    data[offset + 1] = 255;
    data[offset + 2] = 255;
  }
  return { width, height, data };
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} 必須是非負整數。`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必須大於零。`);
  return value;
}

function isInk(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const alpha = data[offset + 3];
  if (clearlyRed(red, green, blue)) return false;
  const luminance = red * 299 + green * 587 + blue * 114;
  return luminance * alpha + 255000 * (255 - alpha) < 180000 * 255;
}

export function removeTableRulings(imageData, options = {}) {
  const { width, height, data: original } = readPixels(imageData);
  const minVerticalRun = positiveInteger(options.minVerticalRun ?? Math.max(24, Math.round(height * 0.08)), 'minVerticalRun');
  const minHorizontalRun = positiveInteger(options.minHorizontalRun ?? Math.max(48, Math.round(width * 0.25)), 'minHorizontalRun');
  const maxThickness = positiveInteger(options.maxThickness ?? Math.max(3, Math.round(Math.min(width, height) / 250)), 'maxThickness');
  const ink = new Uint8Array(width * height);
  for (let index = 0, offset = 0; index < ink.length; index += 1, offset += 4) ink[index] = isInk(original, offset) ? 1 : 0;
  const erase = new Uint8Array(width * height);
  const thickness = (x, y, vertical) => {
    let count = 1;
    if (vertical) {
      for (let left = x - 1; left >= 0 && ink[y * width + left]; left -= 1) count += 1;
      for (let right = x + 1; right < width && ink[y * width + right]; right += 1) count += 1;
    } else {
      for (let up = y - 1; up >= 0 && ink[up * width + x]; up -= 1) count += 1;
      for (let down = y + 1; down < height && ink[down * width + x]; down += 1) count += 1;
    }
    return count;
  };
  const thinLine = (fixed, start, length, vertical) => {
    let thin = 0;
    for (let sample = 1; sample <= 5; sample += 1) {
      const along = start + Math.floor((length * sample) / 6);
      if ((vertical ? thickness(fixed, along, true) : thickness(along, fixed, false)) <= maxThickness) thin += 1;
    }
    return thin >= 4;
  };
  let removed = 0;
  for (let x = 0; x < width; x += 1) {
    let start = -1;
    for (let y = 0; y <= height; y += 1) {
      const dark = y < height && ink[y * width + x] === 1;
      if (dark && start < 0) start = y;
      if (dark || start < 0) continue;
      const length = y - start;
      if (length >= minVerticalRun && thinLine(x, start, length, true)) {
        for (let row = start; row < y; row += 1) erase[row * width + x] = 1;
        removed += 1;
      }
      start = -1;
    }
  }
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const dark = x < width && ink[y * width + x] === 1;
      if (dark && start < 0) start = x;
      if (dark || start < 0) continue;
      const length = x - start;
      if (length >= minHorizontalRun && thinLine(y, start, length, false)) {
        for (let column = start; column < x; column += 1) erase[y * width + column] = 1;
        removed += 1;
      }
      start = -1;
    }
  }
  const data = new Uint8ClampedArray(original);
  if (removed) {
    for (let index = 0, offset = 0; index < erase.length; index += 1, offset += 4) {
      if (!erase[index]) continue;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
    }
  }
  return { width, height, data, removed };
}

export function horizontalTextBands(imageData, options = {}) {
  const { width, height, data } = readPixels(imageData);
  const minRowPixels = nonnegativeInteger(options.minRowPixels ?? Math.max(2, Math.ceil(width * 0.002)), 'minRowPixels');
  const maxGap = nonnegativeInteger(options.maxGap ?? 2, 'maxGap');
  const padding = nonnegativeInteger(options.padding ?? 2, 'padding');
  if (minRowPixels < 1) throw new RangeError('minRowPixels 必須大於零。');
  const occupiedRows = [];
  for (let row = 0; row < height; row += 1) {
    let inkPixels = 0;
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];
      if (clearlyRed(red, green, blue)) continue;
      const luminance = red * 299 + green * 587 + blue * 114;
      if (luminance * alpha + 255000 * (255 - alpha) < 180000 * 255) inkPixels += 1;
      if (inkPixels >= minRowPixels) break;
    }
    if (inkPixels >= minRowPixels) occupiedRows.push(row);
  }
  const bands = [];
  for (const row of occupiedRows) {
    const previous = bands.at(-1);
    if (previous && row - previous.y1 <= maxGap) previous.y1 = row + 1;
    else bands.push({ x0: 0, y0: row, x1: width, y1: row + 1 });
  }
  const paddedBands = [];
  for (const band of bands) {
    band.y0 = Math.max(0, band.y0 - padding);
    band.y1 = Math.min(height, band.y1 + padding);
    const previous = paddedBands.at(-1);
    if (previous && band.y0 <= previous.y1) previous.y1 = Math.max(previous.y1, band.y1);
    else paddedBands.push(band);
  }
  return paddedBands;
}
