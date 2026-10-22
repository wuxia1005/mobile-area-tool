import { cleanTranscriptPixels, removeTableRulings } from './ocr-image.js?v=4';
import { normalizeOcrLabels } from './ocr-text.js?v=1';

const MAX_PIXELS = 2500000;

function compact(value) {
  return normalizeOcrLabels(String(value || '').normalize('NFKC')).replace(/\s+/gu, '');
}

function fractions(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/(?<=\d)\s+(?=\d)/gu, '?');
  return [...normalized.matchAll(/(?<![\d.,+\-−A-Za-z/?])(\d{1,12})\s*分\s*之\s*(\d{1,12})(?![\d.,?])/gu)].filter(match => {
    const following = normalized.slice(match.index + match[0].length);
    const malformedTail = /^[\p{L}\p{N}]/u.test(following) && !/^(?:面積|平方公尺|平方米|坪)/u.test(following);
    return !malformedTail && BigInt(match[1]) > 0n && BigInt(match[2]) > 0n && BigInt(match[2]) <= BigInt(match[1]);
  });
}

function decimalAreas(text) {
  const normalized = String(text || '').normalize('NFKC').replace(/(?<=\d)\s+(?=\d)/gu, '?');
  return [...normalized.matchAll(/(?<![\d.,+\-−A-Za-z/?])((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{1,8})\s*(?:平方\s*公尺|平方\s*米|m2|㎡)(?![\dA-Za-z])/giu)].map(match => match[1].replaceAll(',', ''));
}

function checkAbort(options) {
  if (options.signal?.aborted) throw Object.assign(new Error('已取消讀取。'), { name: 'AbortError', code: 'ABORTED' });
}

function updateRecord(record, text, method, confidence) {
  if (!text || compact(text) === compact(record.text)) return;
  record.originalText ||= record.text;
  record.text = text.trim();
  record.source = `${record.source || '原頁'}（${method}）`;
  record.confidence = confidence;
  const sqm = /平方公尺|平方米|㎡|m\s*[²2]/iu.test(text);
  const ping = /坪/u.test(text);
  record.unitHint = sqm === ping ? undefined : sqm ? 'sqm' : 'ping';
}

async function recognizeCrop(canvas, box, scale, mode, threshold, ocr, options) {
  checkAbort(options);
  const left = Math.max(0, Math.floor(box.left));
  const top = Math.max(0, Math.floor(box.top));
  const width = Math.min(canvas.width - left, Math.ceil(box.width));
  const height = Math.min(canvas.height - top, Math.ceil(box.height));
  if (width <= 0 || height <= 0) return { text: '', confidence: 0 };
  const boundedScale = Math.min(scale, Math.sqrt(MAX_PIXELS / (width * height)), 4096 / width, 4096 / height);
  const crop = document.createElement('canvas');
  crop.width = Math.max(1, Math.floor(width * boundedScale));
  crop.height = Math.max(1, Math.floor(height * boundedScale));
  try {
    const context = crop.getContext('2d', { willReadFrequently: true });
    if (!context) return { text: '', confidence: 0 };
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, crop.width, crop.height);
    const sourceScale = Number(options.sourceScale);
    if (options.sourceImage && Number.isFinite(sourceScale) && sourceScale > 0) {
      const sourceWidth = Number(options.sourceImage.naturalWidth || options.sourceImage.width);
      const sourceHeight = Number(options.sourceImage.naturalHeight || options.sourceImage.height);
      const scaleX = sourceWidth > 0 ? canvas.width / sourceWidth : sourceScale;
      const scaleY = sourceHeight > 0 ? canvas.height / sourceHeight : sourceScale;
      context.drawImage(options.sourceImage, left / scaleX, top / scaleY, width / scaleX, height / scaleY, 0, 0, crop.width, crop.height);
    } else context.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height);
    const pixels = context.getImageData(0, 0, crop.width, crop.height);
    let cleaned = cleanTranscriptPixels({ width: crop.width, height: crop.height, data: pixels.data });
    const lineHeight = Number(box.lineHeight) * boundedScale;
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
      cleaned = removeTableRulings(cleaned, {
        minVerticalRun: Math.max(8, Math.round(lineHeight * 1.2)),
        minHorizontalRun: Math.max(16, Math.round(lineHeight * 3)),
        maxThickness: Math.max(3, Math.round(lineHeight / 6))
      });
    }
    pixels.data.set(cleaned.data);
    if (threshold) {
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        const gray = (pixels.data[offset] + pixels.data[offset + 1] + pixels.data[offset + 2]) / 3;
        const color = gray < threshold ? 0 : 255;
        pixels.data[offset] = color;
        pixels.data[offset + 1] = color;
        pixels.data[offset + 2] = color;
      }
    }
    context.putImageData(pixels, 0, 0);
    await ocr.setParameters({ tessedit_pageseg_mode: mode });
    const result = await ocr.recognize(crop);
    checkAbort(options);
    return { text: String(result.data.text || '').trim(), confidence: result.data.confidence };
  } finally {
    crop.width = 0;
    crop.height = 0;
  }
}

export async function refineTranscript(canvas, records, ocr, options = {}) {
  if (!options.transcript || !records.some(record => record.bbox)) return records;
  const geometric = records.filter(record => record.bbox && record.bbox.y1 > record.bbox.y0);
  const heights = geometric.map(record => record.bbox.y1 - record.bbox.y0).sort((first, second) => first - second);
  const typicalHeight = heights[Math.floor(heights.length / 2)] || 20;
  const contentLeft = Math.max(0, Math.min(...geometric.map(record => record.bbox.x0)) - typicalHeight * 0.6);
  const contentRight = Math.min(canvas.width, Math.max(...geometric.map(record => record.bbox.x1)) + typicalHeight * 0.6);
  let attempts = 0;
  const announce = description => {
    attempts += 1;
    options.onProgress?.({ stage: 'ocr-row', status: `加強辨識${description}（${attempts}）`, progress: 0 });
  };
  try {
    for (const record of geometric) {
      checkAbort(options);
      if (attempts + 2 > 12) break;
      const text = compact(record.text);
      const ownershipArea = /權利範圍/u.test(text) && /面積/u.test(text) && !/土地|基地|地號/u.test(text);
      const labeledArea = /陽台|附屬建物用途|總面積|層次面積/u.test(text)
        || ownershipArea;
      if (!labeledArea || decimalAreas(record.text).length) continue;
      const height = record.bbox.y1 - record.bbox.y0;
      const box = { left: 0, top: record.bbox.y0 - height * 0.2, width: canvas.width, height: height * 1.4, lineHeight: height };
      announce('面積小數點');
      const binary = await recognizeCrop(canvas, box, 2, '7', 165, ocr, options);
      announce('面積原字');
      const enlarged = await recognizeCrop(canvas, box, 3, '7', undefined, ocr, options);
      const binaryAreas = decimalAreas(binary.text);
      const enlargedAreas = decimalAreas(enlarged.text);
      const readings = [binary, enlarged];
      const agreement = binaryAreas.find(value => enlargedAreas.includes(value));
      let selected = agreement;
      let reading = enlargedAreas.includes(selected) ? enlarged : binary;
      if (!selected && attempts < 12) {
        announce('面積數值欄位');
        const columnBox = { ...box, left: canvas.width * 0.53, width: canvas.width * 0.42 };
        const valueColumn = await recognizeCrop(canvas, columnBox, 3, '7', undefined, ocr, options);
        readings.push(valueColumn);
        const columnAreas = decimalAreas(valueColumn.text);
        selected = columnAreas.find(value => binaryAreas.includes(value) || enlargedAreas.includes(value));
        if (selected) reading = enlargedAreas.includes(selected) ? enlarged : binary;
        else if (!ownershipArea && columnAreas.length === 1 && attempts < 12) {
          const columnValue = columnAreas[0];
          const columnText = valueColumn.text.replace(/\r?\n/gu, ' ');
          const labelStart = columnText.search(/面積/u);
          const valueStart = columnText.indexOf(columnValue);
          const labelled = labelStart >= 0 && valueStart > labelStart && /(?:面積|[:：])\s*[*#$%＊]*\s*$/u.test(columnText.slice(0, valueStart));
          const consistent = [binaryAreas, enlargedAreas].every(areas => !areas.length || areas.some(value => value.endsWith(columnValue)));
          if (labelled && consistent) {
            announce('面積數值欄位複讀');
            const columnAgain = await recognizeCrop(canvas, columnBox, 2.4, '7', undefined, ocr, options);
            readings.push(columnAgain);
            if (decimalAreas(columnAgain.text).includes(columnValue)) {
              selected = columnValue;
              reading = { ...valueColumn, text: `${record.text.split(/面積/u)[0]}${columnText.slice(labelStart)}`.trim() };
            }
          }
        }
      }
      if (selected && ownershipArea) {
        const signature = value => fractions(value).map(fraction => `${fraction[2]}/${fraction[1]}`).join('|');
        const originalShares = fractions(record.text);
        const matching = readings.filter(item => /權利範圍/u.test(compact(item.text)) && decimalAreas(item.text).includes(selected)
          && fractions(item.text).length <= 1 && (!originalShares.length || signature(item.text) === signature(record.text)));
        reading = matching.find(item => matching.filter(other => signature(other.text) === signature(item.text)).length >= 2);
        if (!reading) continue;
      }
      if (selected) {
        updateRecord(record, reading.text.replace(/\r?\n/gu, ' '), '面積小數點局部重讀', reading.confidence);
        if (ownershipArea && fractions(reading.text).length === 1) {
          const verifiedShare = fractions(reading.text)[0];
          record.shareVerification = { status: 'verified', numerator: verifiedShare[2], denominator: verifiedShare[1] };
        }
      }
    }
    for (const [index, record] of geometric.entries()) {
      checkAbort(options);
      if (attempts >= 12) break;
      if (/土地|基地|地號/u.test(compact(record.text))) continue;
      const previous = geometric[index - 1];
      const numberedParkingAbove = previous && /地下[一二三四五六七八九十\d]+層[\dA-Za-z-]+/u.test(compact(previous.text)) && record.bbox.y0 - previous.bbox.y1 < typicalHeight * 1.5;
      const originalFractions = fractions(record.text);
      if (originalFractions.length > 1 || (!numberedParkingAbove && !/分[之2]|權利範圍|車位|還位/u.test(compact(record.text)))) continue;
      if (originalFractions.length === 1 && record.shareVerification?.status === 'verified'
        && record.shareVerification.numerator === originalFractions[0][2] && record.shareVerification.denominator === originalFractions[0][1]) continue;
      if (!/\d/u.test(record.text)) continue;
      const originalShare = originalFractions[0];
      if (originalShare) record.shareVerification = { status: 'unverified' };
      const height = record.bbox.y1 - record.bbox.y0;
      const box = { left: contentLeft, top: record.bbox.y0 - height * 2, width: contentRight - contentLeft, height: height * 3.6, lineHeight: height };
      const inset = Math.max(contentLeft, canvas.width * 0.2);
      const sourceScale = Number.isFinite(Number(options.sourceScale)) && Number(options.sourceScale) > 0 ? Number(options.sourceScale) : 1.6;
      const variants = [
        { box, scale: 1.9 },
        { box: { ...box, left: inset, width: contentRight - inset }, scale: 2.2 },
        { box: { ...box, left: canvas.width * 0.2, width: canvas.width * 0.76 }, scale: 3 / sourceScale },
        { box: { ...box, left: canvas.width * 0.2, width: canvas.width * 0.76 }, scale: 3.5 / sourceScale }
      ];
      if (originalShare || /權利範圍/u.test(compact(record.text))) {
        const rowBox = { left: contentLeft, top: record.bbox.y0 - height * 0.2, width: contentRight - contentLeft, height: height * 1.4, lineHeight: height };
        variants.unshift({ box: rowBox, scale: 2, mode: '7', threshold: 165 }, { box: rowBox, scale: 3, mode: '7' });
      }
      const evidence = new Map();
      let selected;
      for (const variant of variants) {
        if (attempts >= 12) break;
        announce('持分交叉核對');
        const reading = await recognizeCrop(canvas, variant.box, variant.scale, variant.mode || '6', variant.threshold, ocr, options);
        const validLines = reading.text.split(/\r?\n/u).filter(line => fractions(line).length);
        if (validLines.length !== 1 || fractions(validLines[0]).length !== 1) continue;
        const fraction = fractions(validLines[0])[0];
        const key = `${fraction[2]}/${fraction[1]}`;
        if (originalShare && key !== `${originalShare[2]}/${originalShare[1]}`) {
          record.shareVerification = { status: 'conflict' };
          break;
        }
        const count = (evidence.get(key) || 0) + 1;
        evidence.set(key, count);
        if (count >= 2) {
          selected = { ...reading, line: validLines[0] };
          break;
        }
      }
      if (!selected) continue;
      const verifiedShare = fractions(selected.line)[0];
      if (originalShare) {
        record.shareVerification = { status: 'verified', numerator: verifiedShare[2], denominator: verifiedShare[1] };
        continue;
      }
      const nearby = geometric.slice(Math.max(0, index - 3), index + 2).map(item => item.text).join(' ');
      const parkingContext = /車位|還位|地下[一二三四五六七八九十\d]+層/u.test(compact(nearby));
      let replacement = selected.line;
      if (/權利範圍/u.test(compact(record.text))) {
        if (!/權利範圍/u.test(compact(replacement))) replacement = `權利範圍 ${replacement}`;
        const originalAreas = decimalAreas(record.text);
        const replacementAreas = decimalAreas(replacement);
        if (originalAreas.length > 1 || replacementAreas.length > 1 || originalAreas.length && replacementAreas.length && originalAreas[0] !== replacementAreas[0]) continue;
        if (originalAreas.length === 1 && !replacementAreas.length) replacement = `${replacement} 面積${originalAreas[0]}平方公尺`;
      }
      if (parkingContext && !/含停車位|停車位權利範圍/u.test(compact(replacement))) {
        if (attempts >= 12) continue;
        const labelBox = { left: contentLeft, top: record.bbox.y0 - height * 1.2, width: Math.max(1, canvas.width * 0.29 - contentLeft), height: height * 2, lineHeight: height };
        announce('車位表格標籤');
        const label = await recognizeCrop(canvas, labelBox, 3, '6', undefined, ocr, options);
        if (/含停車位|停車位/u.test(compact(label.text))) replacement = `${label.text.replace(/\r?\n/gu, ' ')} ${replacement}`;
      }
      updateRecord(record, replacement, '持分相鄰表格交叉重讀', selected.confidence);
      record.shareVerification = { status: 'verified', numerator: verifiedShare[2], denominator: verifiedShare[1] };
    }
  } finally {
    if (!options.signal?.aborted) await ocr.setParameters({ tessedit_pageseg_mode: '6' });
  }
  return records;
}
