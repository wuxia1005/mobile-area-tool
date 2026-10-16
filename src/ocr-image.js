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
