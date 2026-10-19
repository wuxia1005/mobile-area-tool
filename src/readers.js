import { cleanTranscriptPixels } from './ocr-image.js?v=3';
import { refineTranscript } from './ocr-refine.js?v=1.7';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 2500000;
const MAX_PDF_IMAGE_PIXELS = 16000000;
const MAX_EXCEL_CELLS = 150000;
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const workbookCache = new WeakMap();
let pdfModulePromise;
let ocrLifecycleTail = Promise.resolve();
let pendingOcrLifecycles = 0;

function readerError(code, message, details = {}) {
  return Object.assign(new Error(message), { name: 'DocumentReaderError', code, ...details });
}

function abortError() {
  return Object.assign(new Error('已取消讀取。'), { name: 'AbortError', code: 'ABORTED' });
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function abortable(promise, signal, cleanup) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      Promise.resolve().then(() => cleanup?.()).catch(() => {});
      reject(abortError());
    };
    if (signal.aborted) {
      aborted();
      Promise.resolve(promise).catch(() => {});
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    });
  });
}

function getKind(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw readerError('FILE_REQUIRED', '請先選擇一個檔案。');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw readerError('FILE_TOO_LARGE', '單一檔案上限為 10 MB，請先縮小圖片或拆分文件。');
  }
  if (file.size === 0) throw readerError('EMPTY_FILE', '這個檔案是空的，請重新選擇。');
  const name = String(file.name || '').toLowerCase();
  const mime = String(file.type || '').toLowerCase();
  if (/\.(?:heic|heif)$/.test(name) || /image\/(?:heic|heif)/.test(mime)) {
    throw readerError('HEIC_NOT_SUPPORTED', '目前不支援 HEIC／HEIF，請先轉存 JPEG 或 PNG 再選擇。');
  }
  if (/\.pdf$/.test(name) || mime === 'application/pdf') return 'pdf';
  if (/\.(?:xlsx|xls|xlsm|xlsb)$/.test(name) || /(?:spreadsheetml|ms-excel|excel\.sheet|excel\.sheet\.binary)/.test(mime)) return 'excel';
  if (/\.(?:png|jpe?g|webp)$/.test(name) || /^image\/(?:png|jpeg|webp)$/.test(mime)) return 'image';
  throw readerError('UNSUPPORTED_FILE', '請選擇 PDF、JPG、PNG、WebP 或 Excel（xlsx、xls、xlsm、xlsb）檔案。');
}

function detectUnit(text) {
  const sqm = /平方公尺|平方米|㎡|[mｍ]\s*(?:[²2２]|[\^＾]\s*[2２])/i.test(text);
  const ping = /坪/.test(text);
  return sqm === ping ? undefined : sqm ? 'sqm' : 'ping';
}

function report(options, stage, status, progress, details = {}) {
  options.onProgress?.({ stage, status, progress, ...details });
}

async function getPdfModule() {
  pdfModulePromise ||= import('../vendor/pdfjs/pdf.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
    return module;
  }).catch(error => {
    pdfModulePromise = undefined;
    throw readerError('PDF_ENGINE_UNAVAILABLE', 'PDF 讀取元件未載入，請確認工具檔案完整並重新整理。', { cause: error });
  });
  return pdfModulePromise;
}

async function openPdf(file, signal) {
  checkAbort(signal);
  const pdfjs = await abortable(getPdfModule(), signal);
  const bytes = new Uint8Array(await abortable(file.arrayBuffer(), signal));
  checkAbort(signal);
  const task = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    useSystemFonts: true,
    isOffscreenCanvasSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    verbosity: 0
  });
  try {
    const document = await abortable(task.promise, signal, () => task.destroy());
    return { pdfjs, document, task };
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error.name === 'AbortError') throw error;
    if (error.name === 'PasswordException') {
      throw readerError('PASSWORD_PROTECTED', '這份 PDF 有密碼保護，請先在手機解鎖後另存副本。');
    }
    throw readerError('INVALID_PDF', '無法開啟 PDF，可能已損壞或格式不支援。', { cause: error });
  }
}

function checkZipExpansion(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return;
  const view = new DataView(buffer);
  let trailer = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position -= 1) {
    if (view.getUint32(position, true) === 0x06054b50) {
      trailer = position;
      break;
    }
  }
  if (trailer < 0) throw readerError('INVALID_EXCEL', 'Excel 壓縮結構不完整，請重新另存檔案。');
  const count = view.getUint16(trailer + 10, true);
  let position = view.getUint32(trailer + 16, true);
  let unpackedBytes = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (position + 46 > bytes.length || view.getUint32(position, true) !== 0x02014b50) {
      throw readerError('INVALID_EXCEL', 'Excel 檔案結構無法安全讀取，請重新另存。');
    }
    const expanded = view.getUint32(position + 24, true);
    unpackedBytes += expanded;
    if (expanded === 0xffffffff || unpackedBytes > MAX_UNPACKED_BYTES) {
      throw readerError('EXCEL_TOO_COMPLEX', '這份 Excel 展開後過大，請另存只含需要工作表的精簡檔。');
    }
    position += 46 + view.getUint16(position + 28, true) + view.getUint16(position + 30, true) + view.getUint16(position + 32, true);
  }
}

async function openWorkbook(file, signal) {
  checkAbort(signal);
  if (workbookCache.has(file)) return workbookCache.get(file);
  const spreadsheet = globalThis.XLSX;
  if (!spreadsheet?.read) throw readerError('EXCEL_ENGINE_UNAVAILABLE', 'Excel 讀取元件未載入，請重新整理。');
  const buffer = await abortable(file.arrayBuffer(), signal);
  checkZipExpansion(buffer);
  let workbook;
  try {
    workbook = spreadsheet.read(buffer, {
      type: 'array',
      cellStyles: true,
      cellFormula: true,
      cellHTML: false,
      cellNF: true,
      cellText: true,
      cellDates: true,
      bookVBA: false,
      dense: false
    });
  } catch (error) {
    throw readerError('INVALID_EXCEL', '無法讀取 Excel，請確認檔案沒有密碼且可以正常開啟。', { cause: error });
  }
  checkAbort(signal);
  workbookCache.set(file, workbook);
  return workbook;
}

function visibleSheets(workbook) {
  return workbook.SheetNames.filter((name, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
}

export async function inspectDocument(file, { signal } = {}) {
  const kind = getKind(file);
  checkAbort(signal);
  if (kind === 'pdf') {
    const { document, task } = await openPdf(file, signal);
    try {
      return { kind, fileName: file.name, pageCount: document.numPages, maxPages: 5 };
    } finally {
      await task.destroy().catch(() => {});
    }
  }
  if (kind === 'excel') {
    const workbook = await openWorkbook(file, signal);
    const sheets = visibleSheets(workbook).map(name => ({ name, hidden: false }));
    if (!sheets.length) throw readerError('NO_VISIBLE_SHEETS', '這個 Excel 沒有可見工作表，不會讀取隱藏的內容。');
    return { kind, fileName: file.name, sheets, hiddenSheetCount: workbook.SheetNames.length - sheets.length };
  }
  return { kind, fileName: file.name, pageCount: 1 };
}

function canvasDimensions(width, height, preferredScale = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw readerError('INVALID_IMAGE_SIZE', '無法判斷圖片或頁面的大小。');
  }
  const scale = Math.min(preferredScale, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), 4096 / width, 4096 / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw readerError('CANVAS_UNAVAILABLE', '這個瀏覽器無法處理圖片，請改用 Safari 開啟。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return { canvas, context };
}

function cleanedCanvas(canvas) {
  const drawing = createCanvas(canvas.width, canvas.height);
  const original = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const cleaned = cleanTranscriptPixels(original);
  drawing.context.putImageData(new ImageData(cleaned.data, cleaned.width, cleaned.height), 0, 0);
  return drawing.canvas;
}

async function emitPage(canvas, options, details) {
  checkAbort(options.signal);
  if (!options.onPage) return;
  const blob = await abortable(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), options.signal);
  if (!blob) throw readerError('PREVIEW_FAILED', '無法產生頁面預覽，請換一個較小的檔案。');
  await options.onPage({ ...details, blob, width: canvas.width, height: canvas.height });
  checkAbort(options.signal);
}

function ocrRecords(data, source, pageNumber) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = String(line.text || '').trim();
        if (text) lines.push({ text, bbox: line.bbox, confidence: line.confidence });
      }
    }
  }
  if (!lines.length) {
    String(data.text || '').split(/\r?\n/).forEach(text => {
      if (text.trim()) lines.push({ text: text.trim(), confidence: data.confidence });
    });
  }
  return lines.map((line, index) => ({
    ...line,
    source: `${source}，第 ${index + 1} 行`,
    pageNumber,
    unitHint: detectUnit(line.text)
  }));
}

async function acquireOcrSlot(options, context) {
  checkAbort(options.signal);
  const previous = ocrLifecycleTail;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  ocrLifecycleTail = previous.then(() => completion);
  const waiting = pendingOcrLifecycles > 0;
  pendingOcrLifecycles += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pendingOcrLifecycles -= 1;
    resolveCompletion();
  };
  try {
    if (waiting) report(options, 'cleanup', '等待前次辨識完成或初始化清理；不會重複載入辨識引擎。', 0, context);
    await abortable(previous, options.signal);
    checkAbort(options.signal);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

async function createOcrSession(options, context) {
  if (!globalThis.Tesseract?.createWorker) {
    throw readerError('OCR_ENGINE_UNAVAILABLE', '文字辨識元件未載入，請確認工具檔案完整並重新整理。');
  }
  const releaseSlot = await acquireOcrSlot(options, context);
  let worker;
  let terminatePromise;
  let initializationStarted = false;
  const terminate = () => {
    if (worker && !terminatePromise) terminatePromise = Promise.resolve().then(() => worker.terminate()).catch(() => {});
    return terminatePromise;
  };
  const initialization = Promise.resolve().then(() => {
    checkAbort(options.signal);
    initializationStarted = true;
    return globalThis.Tesseract.createWorker('chi_tra+eng', 1, {
    workerPath: new URL('../vendor/tesseract/worker.min.js', import.meta.url).href,
    corePath: new URL('../vendor/tesseract-core', import.meta.url).href,
    langPath: new URL('../vendor/lang', import.meta.url).href,
    workerBlobURL: false,
    logger: message => {
      if (!options.signal?.aborted) report(options, 'ocr', message.status, message.progress, context);
    }
    });
  }).then(async created => {
    worker = created;
    if (options.signal?.aborted) {
      await terminate();
      throw abortError();
    }
    return created;
  });
  const cancelInitialization = () => {
    if (!worker && initializationStarted) report(options, 'cleanup', '本次已取消；辨識引擎尚在初始化，完成後會清理。再次讀取會等待，不會疊加載入。', 0, context);
    return terminate();
  };
  const onAbort = () => { terminate(); };
  try {
    await abortable(initialization, options.signal, cancelInitialization);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    await abortable(worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: options.transcript ? '200' : '150', tessedit_pageseg_mode: options.transcript ? '6' : '3' }), options.signal, terminate);
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort);
    if (worker) {
      await terminate();
      releaseSlot();
    } else {
      initialization.then(terminate, terminate).then(releaseSlot, releaseSlot);
      if (error.name === 'AbortError' && initializationStarted) {
        error.initializationPending = true;
        error.message = '已取消本次讀取；辨識引擎仍在初始化，完成並清理前，新的讀取會先等待。';
      }
    }
    throw error;
  }
  return {
    setParameters: parameters => abortable(worker.setParameters(parameters), options.signal, terminate),
    recognize: canvas => abortable(worker.recognize(canvas, {}, { text: true, blocks: true }), options.signal, terminate),
    async close() {
      options.signal?.removeEventListener('abort', onAbort);
      await terminate();
      releaseSlot();
    }
  };
}

function selectedPages(pageCount, requested, maxPages) {
  const limit = Math.max(1, Math.min(5, Math.floor(Number(maxPages) || 5)));
  if (requested === undefined && pageCount > limit) {
    throw readerError('PDF_PAGE_SELECTION_REQUIRED', `這份 PDF 有 ${pageCount} 頁，請先選擇本次要辨識的頁面（最多 ${limit} 頁）。`, { pageCount, maxPages: limit });
  }
  const pages = requested === undefined ? Array.from({ length: pageCount }, (_, index) => index + 1) : requested;
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > pageCount)) {
    throw readerError('INVALID_PAGE_SELECTION', '請選擇有效的 PDF 頁碼。', { pageCount, maxPages: limit });
  }
  const unique = [...new Set(pages)].sort((first, second) => first - second);
  if (unique.length > limit) throw readerError('TOO_MANY_PAGES', `每次最多辨識 ${limit} 頁，請分次選擇。`, { pageCount, maxPages: limit });
  return unique;
}

async function findTranscriptPages(pdfDocument, pdfjs, ocr, options) {
  if (pdfDocument.numPages > 12) throw readerError('PDF_AUTO_SCAN_LIMIT', '自動找頁最多檢查 12 頁，請關閉自動模式並指定建物標示頁。');
  const found = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    checkAbort(options.signal);
    report(options, 'find-page', `自動尋找建物標示頁 ${pageNumber}／${pdfDocument.numPages}`, (pageNumber - 1) / pdfDocument.numPages, { pageNumber });
    const page = await abortable(pdfDocument.getPage(pageNumber), options.signal);
    let canvas;
    let header;
    let centered;
    try {
      const base = page.getViewport({ scale: 1 });
      const dimensions = canvasDimensions(base.width, base.height, 1.7);
      const drawing = createCanvas(dimensions.width, dimensions.height);
      canvas = drawing.canvas;
      const render = page.render({ canvasContext: drawing.context, viewport: page.getViewport({ scale: dimensions.scale }), background: '#ffffff', annotationMode: pdfjs.AnnotationMode.ENABLE });
      await abortable(render.promise, options.signal, () => render.cancel());
      const drawingHeader = createCanvas(canvas.width, Math.ceil(canvas.height * 0.38));
      header = drawingHeader.canvas;
      drawingHeader.context.drawImage(canvas, 0, 0);
      await ocr.setParameters({ tessedit_pageseg_mode: '6' });
      const result = await ocr.recognize(header);
      let heading = String(result.data.text).replace(/\s+/gu, '');
      if (!/建物[標摽][示十]部/u.test(heading)) {
        const cropWidth = Math.ceil(header.width * 0.44);
        const focusedSize = canvasDimensions(cropWidth, header.height, 2);
        const focused = createCanvas(focusedSize.width, focusedSize.height);
        centered = focused.canvas;
        focused.context.drawImage(header, Math.floor(header.width * 0.29), 0, cropWidth, header.height, 0, 0, centered.width, centered.height);
        await ocr.setParameters({ tessedit_pageseg_mode: '11' });
        const focusedResult = await ocr.recognize(centered);
        heading = String(focusedResult.data.text).replace(/\s+/gu, '');
        await ocr.setParameters({ tessedit_pageseg_mode: '6' });
      }
      if (/建物[標摽][示十]部/u.test(heading)) found.push(pageNumber);
    } finally {
      if (centered) { centered.width = 0; centered.height = 0; }
      if (header) { header.width = 0; header.height = 0; }
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      page.cleanup();
    }
  }
  if (!found.length) throw readerError('PDF_BUILDING_PAGE_NOT_FOUND', '未能自動找到建物標示頁。請關閉「自動找建物標示頁」，手動填入該頁頁碼；一般面積表也請使用手動選頁。');
  if (found.length > 1) throw readerError('PDF_MULTIPLE_BUILDINGS', `第 ${found.join('、')} 頁都含建物標示部，可能有不同建物。請關閉自動模式，一次選取一戶的建物標示頁，不會混用或加總。`);
  return found;
}

async function readPdf(file, options) {
  report(options, 'read', '開啟 PDF', 0);
  const { document: pdfDocument, task, pdfjs } = await openPdf(file, options.signal);
  let ocr;
  const records = [];
  const warnings = ['PDF 僅辨識頁面上可見的畫面，不讀取隱藏文字層；辨識結果仍須對照原頁核對。', '為保護手機記憶體，PDF 內嵌圖片上限為 1,600 萬像素；超過上限的圖片可能被略過。請務必核對渲染預覽與原文件，若缺少內容，請先將該頁轉成較小的 JPG／PNG 再讀取。'];
  if (options.transcript) warnings.push('已使用謄本分區加強辨識；持分、小數點仍須核對，土地、所有權與抵押權資料不會混入建物面積。');
  try {
    let pages = options.autoTranscriptPages ? null : selectedPages(pdfDocument.numPages, options.pdfPages, options.maxPages);
    const context = { pageNumber: pages?.[0], totalPages: pages?.length || pdfDocument.numPages };
    ocr = await createOcrSession(options, context);
    if (options.autoTranscriptPages) {
      pages = await findTranscriptPages(pdfDocument, pdfjs, ocr, options);
      context.pageNumber = pages[0]; context.totalPages = pages.length;
      warnings.push(`已自動選取第 ${pages.join('、')} 頁建物標示部；其餘頁未帶入面積。`);
    }
    for (const pageNumber of pages) {
      checkAbort(options.signal);
      context.pageNumber = pageNumber;
      report(options, 'render', `處理第 ${pageNumber} 頁`, 0, context);
      const page = await abortable(pdfDocument.getPage(pageNumber), options.signal, () => task.destroy());
      let canvas;
      let enhanced;
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const dimensions = canvasDimensions(baseViewport.width, baseViewport.height, 2);
        const viewport = page.getViewport({ scale: dimensions.scale });
        const drawing = createCanvas(dimensions.width, dimensions.height);
        canvas = drawing.canvas;
        const render = page.render({ canvasContext: drawing.context, viewport, background: '#ffffff', annotationMode: pdfjs.AnnotationMode.ENABLE });
        await abortable(render.promise, options.signal, () => render.cancel());
        const source = `${file.name}，第 ${pageNumber} 頁`;
        await emitPage(canvas, options, { kind: 'pdf', fileName: file.name, pageNumber, source });
        enhanced = options.transcript ? cleanedCanvas(canvas) : canvas;
        const result = await ocr.recognize(enhanced);
        const pageRecords = await refineTranscript(enhanced, ocrRecords(result.data, source, pageNumber), ocr, { ...options, sourceScale: dimensions.scale });
        if (!pageRecords.length) warnings.push(`第 ${pageNumber} 頁沒有辨識到文字，請對照原頁或改傳清晰照片。`);
        records.push(...pageRecords);
      } finally {
        if (enhanced && enhanced !== canvas) { enhanced.width = 0; enhanced.height = 0; }
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        page.cleanup();
      }
    }
    report(options, 'complete', 'PDF 辨識完成', 1);
    return { kind: 'pdf', records, warnings, meta: { fileName: file.name, pageCount: pdfDocument.numPages, selectedPages: pages, imagePixelLimit: MAX_PDF_IMAGE_PIXELS, method: 'visible-page-ocr' } };
  } finally {
    await ocr?.close();
    await task.destroy().catch(() => {});
  }
}

async function loadImage(file, signal) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  try {
    await abortable(new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(readerError('INVALID_IMAGE', '無法開啟圖片，請轉存 JPG 或 PNG 再試一次。'));
      image.src = url;
    }), signal, () => { image.src = ''; });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readImage(file, options) {
  report(options, 'read', '開啟圖片', 0);
  const image = await loadImage(file, options.signal);
  const dimensions = canvasDimensions(image.naturalWidth, image.naturalHeight, options.transcript ? 1.6 : 1);
  const { canvas, context } = createCanvas(dimensions.width, dimensions.height);
  let ocr;
  let enhanced;
  try {
    context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
    const source = `${file.name}，圖片`;
    await emitPage(canvas, options, { kind: 'image', fileName: file.name, pageNumber: 1, source });
    ocr = await createOcrSession(options, { pageNumber: 1, totalPages: 1 });
    enhanced = options.transcript ? cleanedCanvas(canvas) : canvas;
    const result = await ocr.recognize(enhanced);
    const records = await refineTranscript(enhanced, ocrRecords(result.data, source, 1), ocr, { ...options, sourceScale: dimensions.scale, sourceImage: image });
    const warnings = ['圖片文字由手機辨識，請核對小數點、面積與單位。'];
    if (options.transcript) warnings.push('已使用謄本表格模式及持分列局部重讀；仍可能錯讀分母、零的個數或小數點，請對照原圖，不會自動確認持分。');
    if (!records.length) warnings.push('沒有辨識到文字，請選擇清楚、正向且完整的圖片，或手動輸入。');
    if (dimensions.scale < 1) warnings.push('為降低手機記憶體用量，辨識圖片已縮小；小字不清楚時請裁切相關區域再傳入。');
    report(options, 'complete', '圖片辨識完成', 1);
    return { kind: 'image', records, warnings, meta: { fileName: file.name, pageCount: 1, method: 'local-image-ocr', width: dimensions.width, height: dimensions.height } };
  } finally {
    if (enhanced && enhanced !== canvas) { enhanced.width = 0; enhanced.height = 0; }
    image.src = '';
    canvas.width = 0;
    canvas.height = 0;
    await ocr?.close();
  }
}

function cellText(cell, address, warnings) {
  if ((cell.f || cell.F) && (cell.v === undefined || cell.v === null || cell.t === 'z')) {
    warnings.push(`${address} 的公式沒有已儲存結果，已略過；請先用 Excel 重算並儲存，不會當成 0。`);
    return '';
  }
  if (cell.t === 'e') {
    warnings.push(`${address} 是 Excel 錯誤值，已略過。`);
    return '';
  }
  if (cell.t === 'z' || cell.v === undefined || cell.v === null) return '';
  const text = cell.w !== undefined ? String(cell.w) : globalThis.XLSX.utils.format_cell(cell);
  return String(text || '').trim();
}

function isHeaderText(text) {
  const withoutUnits = text.replace(/平方公尺|平方米|㎡|[mｍ]\s*(?:[²2２]|[\^＾]\s*[2２])|坪/gi, '');
  return !/[0-9０-９]/.test(withoutUnits);
}

function visibleRowCells(sheet, sheetName, warnings) {
  const groups = new Map();
  let cellCount = 0;
  for (const address of Object.keys(sheet)) {
    if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
    cellCount += 1;
    if (cellCount > MAX_EXCEL_CELLS) throw readerError('EXCEL_TOO_COMPLEX', '這張工作表資料太多，請先另存只含需要欄位的精簡 Excel。');
    const position = globalThis.XLSX.utils.decode_cell(address);
    if (sheet['!rows']?.[position.r]?.hidden || sheet['!cols']?.[position.c]?.hidden) continue;
    const text = cellText(sheet[address], `${sheetName}!${address}`, warnings);
    if (!text) continue;
    if (!groups.has(position.r)) groups.set(position.r, []);
    groups.get(position.r).push({ address, column: position.c, text, unitHint: detectUnit(text), formula: Boolean(sheet[address].f || sheet[address].F) });
  }
  return [...groups.entries()].sort(([first], [second]) => first - second).map(([row, cells]) => ({ row, cells: cells.sort((first, second) => first.column - second.column) }));
}

async function readExcel(file, options) {
  report(options, 'read', '讀取 Excel', 0);
  const workbook = await openWorkbook(file, options.signal);
  try {
    const sheets = visibleSheets(workbook);
    if (!sheets.length) throw readerError('NO_VISIBLE_SHEETS', '這個 Excel 沒有可見工作表，不會讀取隱藏內容。');
    if (options.excelSheet === undefined && sheets.length > 1) {
      throw readerError('EXCEL_SHEET_SELECTION_REQUIRED', '請先選擇本次要讀取的工作表，避免混用不同戶別。', { sheets });
    }
    const sheetName = options.excelSheet ?? sheets[0];
    if (!sheets.includes(sheetName)) throw readerError('INVALID_SHEET_SELECTION', '選擇的工作表不存在或已隱藏，不會讀取。');
    const sheet = workbook.Sheets[sheetName];
    const warnings = ['Excel 僅讀取可見工作表、列與欄；不執行公式或巨集，請確認公式快取是最新結果。', '若 Excel 以圖形、圖片或色塊蓋住儲存格，請改傳畫面截圖或先真正刪除該內容；此工具不解析圖形遮蓋。'];
    const rows = visibleRowCells(sheet, sheetName, warnings);
    const columnHeaders = new Map();
    let sheetUnit;
    let formulaFound = false;
    const records = [];
    for (const [index, row] of rows.entries()) {
      checkAbort(options.signal);
      const text = row.cells.map(cell => cell.text).join(' | ');
      if (/(?:單位|单位)\s*[:：]?/.test(text)) sheetUnit = detectUnit(text);
      const rowUnits = [...new Set(row.cells.map(cell => cell.unitHint).filter(Boolean))];
      const rowUnit = rowUnits.length === 1 ? rowUnits[0] : undefined;
      const cells = row.cells.map(cell => {
        const header = columnHeaders.get(cell.column);
        const unitHint = cell.unitHint || header?.unitHint || rowUnit || sheetUnit;
        const output = { address: cell.address, text: cell.text, unitHint, header: header?.text };
        if (cell.formula) formulaFound = true;
        if (isHeaderText(cell.text)) {
          columnHeaders.set(cell.column, { text: cell.text, unitHint: cell.unitHint || header?.unitHint });
        }
        return output;
      });
      const hintedUnits = [...new Set(cells.map(cell => cell.unitHint).filter(Boolean))];
      records.push({ text, source: `${file.name}，${sheetName}!${row.cells[0].address}:${row.cells.at(-1).address}`, sheetName, rowNumber: row.row + 1, cells, unitHint: hintedUnits.length === 1 ? hintedUnits[0] : undefined });
      if (index % 100 === 0) {
        report(options, 'read', `讀取 ${sheetName}，第 ${row.row + 1} 列`, (index + 1) / Math.max(1, rows.length));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    if (!records.length) warnings.push('選定的工作表沒有可讀取的可見儲存格內容。');
    if (formulaFound) warnings.push('已使用檔案中儲存的公式結果，未重新計算公式。');
    report(options, 'complete', 'Excel 讀取完成', 1);
    return { kind: 'excel', records, warnings: [...new Set(warnings)], meta: { fileName: file.name, sheetName, sheets, hiddenSheetCount: workbook.SheetNames.length - sheets.length, method: 'visible-cells-only' } };
  } finally {
    workbookCache.delete(file);
  }
}

export async function readDocument(file, options = {}) {
  const kind = getKind(file);
  checkAbort(options.signal);
  if (kind === 'pdf') return readPdf(file, options);
  if (kind === 'image') return readImage(file, options);
  return readExcel(file, options);
}
