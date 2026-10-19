const MAX_PIXELS = 2500000;
const MAX_EDGE = 4096;
const EXCEL_WIDTH = 1000;
const EXCEL_HEIGHT = 2500;
const EXCEL_LINE_HEIGHT = 30;
const EXCEL_FONT = '20px system-ui, sans-serif';
const MAX_EXCEL_PAGES = 12;
const MAX_EXCEL_PREVIEW_CELLS = 240;
const MAX_EXCEL_PREVIEW_LINES = MAX_EXCEL_PAGES * 80;

function pageSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('無法判斷來源圖片尺寸。');
  return { width: Math.floor(width), height: Math.floor(height) };
}

export function sourceCropBounds(records, width, height) {
  const size = pageSize(width, height);
  const wholePage = { x: 0, y: 0, ...size };
  if (!Array.isArray(records) || !records.length) return wholePage;
  const boxes = records.map(record => record?.bbox);
  if (boxes.some(box => !box || ![box.x0, box.x1, box.y0, box.y1].every(Number.isFinite) || box.x1 <= box.x0 || box.y1 <= box.y0 || box.x1 <= 0 || box.x0 >= size.width || box.y1 <= 0 || box.y0 >= size.height)) return wholePage;
  const padding = Math.max(12, Math.round(size.height * 0.015));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y0)) - padding));
  const bottom = Math.min(size.height, Math.ceil(Math.max(...boxes.map(box => box.y1)) + padding));
  return { x: 0, y: top, width: size.width, height: bottom - top };
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.width = 0;
    canvas.height = 0;
    throw new Error('無法產生來源截圖。');
  }
  return { canvas, context };
}

function pngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('無法產生來源截圖。')), 'image/png');
  });
}

export async function createSourceScreenshot(preview, records = []) {
  const size = pageSize(preview?.width, preview?.height);
  if (typeof preview?.url !== 'string' || !preview.url) throw new Error('找不到來源圖片。');
  const image = new Image();
  image.decoding = 'async';
  let canvas;
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('無法開啟來源圖片。'));
      image.src = preview.url;
    });
    const naturalSize = pageSize(image.naturalWidth, image.naturalHeight);
    const crop = sourceCropBounds(records, size.width, size.height);
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (crop.width * crop.height)), MAX_EDGE / crop.width, MAX_EDGE / crop.height);
    const drawing = makeCanvas(Math.max(1, Math.floor(crop.width * scale)), Math.max(1, Math.floor(crop.height * scale)));
    canvas = drawing.canvas;
    drawing.context.drawImage(image, crop.x * naturalSize.width / size.width, crop.y * naturalSize.height / size.height, crop.width * naturalSize.width / size.width, crop.height * naturalSize.height / size.height, 0, 0, canvas.width, canvas.height);
    return await pngBlob(canvas);
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = '';
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

function wrappedLines(context, value, width) {
  const output = [];
  const text = String(value ?? '');
  let line = '';
  let position = 0;
  let carriageReturn = false;
  for (const character of text) {
    position += character.length;
    if (character === '\n' && carriageReturn) { carriageReturn = false; continue; }
    carriageReturn = character === '\r';
    if (character === '\n' || carriageReturn) {
      output.push(line);
      line = '';
    } else if (line && (line.length >= 128 || context.measureText(line + character).width > width)) {
      output.push(line);
      line = character;
    } else line += character;
    if (output.length >= MAX_EXCEL_PREVIEW_LINES) {
      return { lines: output, truncated: Boolean(line || position < text.length) };
    }
  }
  output.push(line);
  return { lines: output, truncated: false };
}

function drawExcelHeader(context, truncated) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, EXCEL_WIDTH, EXCEL_HEIGHT);
  context.fillStyle = '#142d26';
  context.font = 'bold 25px system-ui, sans-serif';
  context.fillText('Excel 可見儲存格預覽', 24, 37);
  context.font = '16px system-ui, sans-serif';
  context.fillText(truncated ? '部分預覽：最多 12 張／240 格／前 500 列；完整讀取值保留於匯出' : '依儲存格位置顯示可見值，非原始工作表版面', 24, 67);
  context.fillStyle = '#e6efeb';
  context.fillRect(24, 84, 952, 40);
  context.fillStyle = '#142d26';
  context.font = EXCEL_FONT;
  context.fillText('工作表／儲存格', 36, 112);
  context.fillText('可見值', 332, 112);
}

export async function createExcelScreenshots(records) {
  const allRecords = Array.isArray(records) ? records : [];
  const selected = allRecords.slice(0, 500);
  const blobs = [];
  const pages = [];
  const measuring = makeCanvas(EXCEL_WIDTH, 1);
  measuring.context.font = EXCEL_FONT;
  let truncated = allRecords.length > 500;
  let cellCount = 0;
  const nextPage = () => {
    if (pages.length >= MAX_EXCEL_PAGES) return undefined;
    const page = { rows: [], position: 124 };
    pages.push(page);
    return page;
  };
  try {
    sourceRows:
    for (const record of selected) {
      for (const cell of Array.isArray(record?.cells) ? record.cells : []) {
        if (cellCount >= MAX_EXCEL_PREVIEW_CELLS) { truncated = true; break sourceRows; }
        cellCount += 1;
        const address = `${record.sheetName || ''}${record.sheetName ? '!' : ''}${cell?.address || (record.rowNumber ? `第 ${record.rowNumber} 列` : '')}`;
        const wrappedAddress = wrappedLines(measuring.context, address, 272);
        const wrappedValue = wrappedLines(measuring.context, cell?.text, 632);
        const addressLines = wrappedAddress.lines;
        const valueLines = wrappedValue.lines;
        truncated ||= wrappedAddress.truncated || wrappedValue.truncated;
        while (addressLines.length || valueLines.length) {
          let page = pages.at(-1);
          if (!page || page.rows.length >= 24 || page.position + 54 > EXCEL_HEIGHT - 24) page = nextPage();
          if (!page) { truncated = true; break sourceRows; }
          const availableLines = Math.floor((EXCEL_HEIGHT - 24 - page.position - 24) / EXCEL_LINE_HEIGHT);
          const addressPart = addressLines.splice(0, availableLines);
          const valuePart = valueLines.splice(0, availableLines);
          const height = Math.max(addressPart.length, valuePart.length, 1) * EXCEL_LINE_HEIGHT + 24;
          page.rows.push({ address: addressPart, value: valuePart, top: page.position, height });
          page.position += height;
        }
      }
    }
  } finally {
    measuring.canvas.width = 0;
    measuring.canvas.height = 0;
  }
  for (const page of pages) {
    const { canvas, context } = makeCanvas(EXCEL_WIDTH, Math.min(EXCEL_HEIGHT, Math.max(160, page.position + 24)));
    try {
      drawExcelHeader(context, truncated);
      for (const row of page.rows) {
        context.font = EXCEL_FONT;
        context.fillStyle = '#142d26';
        row.address.forEach((line, index) => context.fillText(line, 36, row.top + 30 + index * EXCEL_LINE_HEIGHT));
        row.value.forEach((line, index) => context.fillText(line, 332, row.top + 30 + index * EXCEL_LINE_HEIGHT));
        context.strokeStyle = '#ccd9d2';
        context.strokeRect(24, row.top, 952, row.height);
        context.beginPath(); context.moveTo(320, row.top); context.lineTo(320, row.top + row.height); context.stroke();
      }
      blobs.push(await pngBlob(canvas));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return blobs;
}
