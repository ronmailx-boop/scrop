// Scrop engine: loads a scan (JPG / PNG / PDF page) at full resolution and
// exports pixel-exact crops. Nothing here ever downscales the source pixels.

const MAX_PREVIEW_SIDE = 4096;          // display-only copy, never used for output
const MAX_RENDER_PIXELS = 64e6;         // safety cap for rasterizing vector PDF pages
const MAX_CANVAS_SIDE = 16384;
const MIN_RENDER_DPI = 300;
const A4_MM = [210, 297];

let pdfjsP, pdfLibP, fflateP;
const loadPdfjs = () => pdfjsP ??= import('./vendor/pdf.min.mjs').then((m) => {
  m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  return m;
});
const loadPdfLib = () => pdfLibP ??= import('./vendor/pdf-lib.esm.min.js');
const loadFflate = () => fflateP ??= import('./vendor/fflate.mjs');

export class UserError extends Error {}

// ---------- canvas helpers ----------

function newCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function freeCanvas(c) {
  c.width = 0;
  c.height = 0;
}

function canvasToBlob(c, type, quality) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => c.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}

function makePreview(drawable, w, h) {
  const k = Math.min(1, MAX_PREVIEW_SIDE / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * k));
  const ph = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, pw, ph);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, pw, ph);
  return c;
}

// ---------- resolution metadata ----------

function jpegDpi(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe0 && b[i + 4] === 0x4a && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
      const units = b[i + 11];
      const x = (b[i + 12] << 8) | b[i + 13];
      if (units === 1) return x;
      if (units === 2) return x * 2.54;
      return 0;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 0;
}

function pngDpi(b) {
  // Chunks follow the 8-byte signature; pHYs must come before IDAT.
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'pHYs') {
      const ppm = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0;
      return b[i + 16] === 1 ? ppm * 0.0254 : 0;
    }
    if (type === 'IDAT') break;
    i += 12 + len;
  }
  return 0;
}

// A scan of the whole A4 bed: derive the DPI from the page size.
function a4Dpi(w, h) {
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (Math.abs(long / short - A4_MM[1] / A4_MM[0]) > 0.02) return 0;
  return long / (A4_MM[1] / 25.4);
}

const niceDpi = (d) => Math.round(d * 10) / 10;

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Write the source resolution into the encoder output (metadata only, pixels untouched)
// so the cropped photo keeps its physical print size.
function stampJpegDpi(bytes, dpi) {
  const d = Math.round(dpi);
  if (d < 1 || d > 65535) return bytes;
  if (bytes[2] === 0xff && bytes[3] === 0xe0 && bytes[6] === 0x4a && bytes[7] === 0x46) {
    bytes[13] = 1;
    bytes[14] = d >> 8; bytes[15] = d & 0xff;
    bytes[16] = d >> 8; bytes[17] = d & 0xff;
  }
  return bytes;
}

function stampPngDpi(bytes, dpi) {
  if (pngDpi(bytes)) return bytes;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1;
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // signature (8) + IHDR chunk (25)
  const out = new Uint8Array(bytes.length + 21);
  out.set(bytes.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(bytes.subarray(at), at + 21);
  return out;
}

// ---------- sources ----------
// A source exposes the full-resolution pixels of one scan:
//   width, height, dpi, origType ('jpeg'|'png'|'pdf'), lossy, preview (canvas),
//   origBlob (original encoded image, if any), note, open() -> {img, close()}, release()

async function decodeBlob(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
  } catch (e) {
    throw new UserError('לא ניתן לפענח את התמונה. ייתכן שהקובץ פגום או גדול מדי לזיכרון המכשיר.');
  }
}

async function blobSource(blob, type, { origType = type, dpi = 0, note } = {}) {
  const bmp = await decodeBlob(blob);
  const { width, height } = bmp;
  const preview = makePreview(bmp, width, height);
  bmp.close();
  if (!dpi) {
    const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    dpi = (type === 'jpeg' ? jpegDpi(head) : pngDpi(head)) || a4Dpi(width, height) || 300;
  }
  return {
    width, height, dpi: niceDpi(dpi), origType, lossy: type === 'jpeg', preview, note,
    origBlob: blob, origBlobType: type,
    async open() {
      const img = await decodeBlob(blob);
      return { img, close: () => img.close() };
    },
    release() { freeCanvas(preview); },
  };
}

function canvasSource(canvas, { origType, dpi, note }) {
  const preview = makePreview(canvas, canvas.width, canvas.height);
  return {
    width: canvas.width, height: canvas.height, dpi: niceDpi(dpi), origType, lossy: false, preview, note,
    async open() { return { img: canvas, close() {} }; },
    release() { freeCanvas(preview); freeCanvas(canvas); },
  };
}

export async function openImage(file) {
  const type = /png$/i.test(file.type) || /\.png$/i.test(file.name) ? 'png' : 'jpeg';
  return blobSource(file, type);
}

// ---------- PDF ----------

export async function openPdf(file) {
  const pdfjs = await loadPdfjs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new UserError('קובץ PDF מוגן בסיסמה אינו נתמך.');
    throw new UserError('לא ניתן לפתוח את קובץ ה-PDF. ייתכן שהוא פגום.');
  }
  return { doc, bytes, numPages: doc.numPages, lib: null };
}

export async function closePdf(pdf) {
  try { await pdf.doc.destroy(); } catch {}
}

export async function pdfPageSource(pdf, pageNo) {
  const page = await pdf.doc.getPage(pageNo);
  try {
    const s = await extractSingleImage(pdf, page, pageNo);
    if (s) return s;
  } catch (e) {
    console.warn('Embedded image extraction failed, rendering instead', e);
  }
  return renderPage(page);
}

// Scanner PDFs are usually one raster image per page: take that image at its
// native resolution instead of re-rendering the page.
async function extractSingleImage(pdf, page, pageNo) {
  const { OPS, Util } = await loadPdfjs();
  if (page.rotate % 360 !== 0) return null;
  const list = await page.getOperatorList();
  const imageOps = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask, OPS.paintJpegXObject,
  ].filter((v) => v !== undefined));
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let hit = null;
  let count = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = Util.transform(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (imageOps.has(fn)) {
      count++;
      if (fn === OPS.paintImageXObject) hit = { id: args[0], w: args[1], h: args[2], ctm };
    }
  }
  if (count !== 1 || !hit) return null;
  const [a, b, c, d] = hit.ctm;
  // Only an upright, unflipped placement maps image pixels 1:1 to what the page shows.
  if (a <= 0 || d <= 0 || Math.abs(b) > 1e-6 * a || Math.abs(c) > 1e-6 * d) return null;
  const dpi = (hit.w / (a / 72) + hit.h / (d / 72)) / 2;
  const note = 'תמונה מוטמעת ברזולוציה המקורית';

  const jpeg = await rawJpegOfPage(pdf, pageNo, hit.w, hit.h);
  if (jpeg) {
    const src = await blobSource(new Blob([jpeg], { type: 'image/jpeg' }), 'jpeg', { origType: 'pdf', dpi, note });
    if (src.width === hit.w && src.height === hit.h) return src;
    src.release();
  }

  const objs = hit.id.startsWith('g_') ? page.commonObjs : page.objs;
  const data = await new Promise((resolve) => objs.get(hit.id, resolve));
  if (!data || data.width !== hit.w || data.height !== hit.h) return null;
  const canvas = newCanvas(data.width, data.height);
  const ctx = canvas.getContext('2d');
  if (data.bitmap) {
    ctx.drawImage(data.bitmap, 0, 0);
  } else if (data.data) {
    ctx.putImageData(toImageData(data), 0, 0);
  } else {
    return null;
  }
  return canvasSource(canvas, { origType: 'pdf', dpi, note });
}

function toImageData({ width, height, kind, data }) {
  const out = new ImageData(width, height);
  const o = out.data;
  const n = width * height;
  if (kind === 3) {
    o.set(data.subarray(0, n * 4));
  } else if (kind === 2) {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      o[i * 4] = data[j]; o[i * 4 + 1] = data[j + 1]; o[i * 4 + 2] = data[j + 2]; o[i * 4 + 3] = 255;
    }
  } else if (kind === 1) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const p = (y * width + x) * 4;
        o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255;
      }
    }
  } else {
    throw new Error('unknown image kind ' + kind);
  }
  return out;
}

// The page's only image XObject, if it is a plain baseline JPEG (DCTDecode):
// returns its bytes untouched, so we decode the scanner's original file.
async function rawJpegOfPage(pdf, pageNo, w, h) {
  const lib = await loadPdfLib();
  const { PDFName, PDFDict, PDFArray, PDFNumber } = lib;
  if (!pdf.lib) {
    pdf.lib = await lib.PDFDocument.load(pdf.bytes, { ignoreEncryption: true, updateMetadata: false });
  }
  const ctx = pdf.lib.context;
  const res = pdf.lib.getPage(pageNo - 1).node.Resources();
  const xobjs = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjs) return null;
  const images = [];
  for (const [, ref] of xobjs.entries()) {
    const stream = ctx.lookup(ref);
    const subtype = stream?.dict?.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Form')) return null;
    if (subtype === PDFName.of('Image')) images.push(stream);
  }
  if (images.length !== 1) return null;
  const s = images[0];
  const dict = s.dict;
  const num = (k) => ctx.lookupMaybe(dict.get(PDFName.of(k)), PDFNumber)?.asNumber();
  if (num('Width') !== w || num('Height') !== h || (num('BitsPerComponent') ?? 8) !== 8) return null;
  for (const k of ['Decode', 'SMask', 'Mask', 'DecodeParms', 'ImageMask']) {
    if (dict.get(PDFName.of(k))) return null;
  }
  let filter = ctx.lookup(dict.get(PDFName.of('Filter')));
  if (filter instanceof PDFArray) filter = filter.size() === 1 ? ctx.lookup(filter.get(0)) : null;
  if (filter !== PDFName.of('DCTDecode')) return null;
  let cs = ctx.lookup(dict.get(PDFName.of('ColorSpace')));
  if (cs instanceof PDFArray) {
    if (ctx.lookup(cs.get(0)) !== PDFName.of('ICCBased')) return null;
    const n = ctx.lookup(cs.get(1))?.dict?.get(PDFName.of('N'));
    if (!n || ![1, 3].includes(ctx.lookup(n).asNumber())) return null;
  } else if (cs !== PDFName.of('DeviceRGB') && cs !== PDFName.of('DeviceGray')) {
    return null;
  }
  const bytes = s.contents;
  if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return bytes;
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  let dpi = MIN_RENDER_DPI;
  const pxAt = (d) => (base.width * d / 72) * (base.height * d / 72);
  if (pxAt(dpi) > MAX_RENDER_PIXELS) dpi = Math.sqrt(MAX_RENDER_PIXELS / pxAt(1));
  dpi = Math.min(dpi, MAX_CANVAS_SIDE * 72 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale: dpi / 72 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (e) {
    freeCanvas(canvas);
    throw new UserError('רינדור עמוד ה-PDF נכשל. ייתכן שהעמוד גדול מדי לזיכרון המכשיר.');
  }
  const note = dpi >= MIN_RENDER_DPI ? `רינדור ${Math.round(dpi)} DPI` : `רינדור ${Math.round(dpi)} DPI (עמוד גדול במיוחד)`;
  return canvasSource(canvas, { origType: 'pdf', dpi, note });
}

// ---------- export ----------

export function outputKind(source, format) {
  if (format === 'jpg') return 'jpg';
  if (format === 'pdf') return 'pdf';
  return { jpeg: 'jpg', png: 'png', pdf: 'pdf' }[source.origType];
}

// ---------- per-crop edits (rotation in 90° steps, brightness / contrast / vivid) ----------

export const NO_EDIT = Object.freeze({ rot: 0, bright: 0, contrast: 0, vivid: 0 });

export const isPlain = (e) => !e || (!(e.rot % 360) && !e.bright && !e.contrast && !e.vivid);
const hasTone = (e) => !!(e && (e.bright || e.contrast || e.vivid));

// Output size of a w×h crop after rotation.
export function rotatedSize(w, h, rot = 0) {
  return (rot / 90) % 2 ? { w: h, h: w } : { w, h };
}

// Exact integer matrix mapping crop pixel (u, v) to output pixel: a pure pixel
// permutation, so rotating never resamples.
export function rotationMatrix(w, h, rot = 0) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [0, 1, -1, 0, h, 0];
    case 180: return [-1, 0, 0, -1, w, h];
    case 270: return [0, -1, 1, 0, 0, w];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

// Same math as the CSS filters brightness() contrast() saturate(), in that order.
// Slider values are percentages around 0.
export function adjustPixels(data, e) {
  const b = 1 + e.bright / 100;
  const k = 1 + e.contrast / 100;
  const s = 1 + e.vivid / 100;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const v1 = Math.min(1, (v / 255) * b);
    lut[v] = Math.round(Math.min(1, Math.max(0, (v1 - 0.5) * k + 0.5)) * 255);
  }
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const sat = s !== 1;
  for (let i = 0; i < data.length; i += 4) {
    const r = lut[data[i]], g = lut[data[i + 1]], bl = lut[data[i + 2]];
    if (sat) {
      data[i] = m[0] * r + m[1] * g + m[2] * bl;
      data[i + 1] = m[3] * r + m[4] * g + m[5] * bl;
      data[i + 2] = m[6] * r + m[7] * g + m[8] * bl;
    } else {
      data[i] = r; data[i + 1] = g; data[i + 2] = bl;
    }
  }
  return data;
}

async function encodeRegion(img, r, type, dpi, edit = NO_EDIT) {
  const out = rotatedSize(r.w, r.h, edit.rot);
  const c = newCanvas(out.w, out.h);
  const ctx = c.getContext('2d', { alpha: type === 'png', willReadFrequently: hasTone(edit) });
  ctx.imageSmoothingEnabled = false;
  if (type === 'jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.w, out.h);
  }
  ctx.setTransform(...rotationMatrix(r.w, r.h, edit.rot));
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (hasTone(edit)) {
    // In strips, to keep memory flat on large crops.
    const strip = Math.max(1, Math.floor(4e6 / out.w));
    for (let y = 0; y < out.h; y += strip) {
      const h = Math.min(strip, out.h - y);
      const id = ctx.getImageData(0, y, out.w, h);
      adjustPixels(id.data, edit);
      ctx.putImageData(id, 0, y);
    }
  }
  const blob = await canvasToBlob(c, `image/${type}`, 1);
  freeCanvas(c);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return type === 'jpeg' ? stampJpegDpi(bytes, dpi) : stampPngDpi(bytes, dpi);
}

async function cropBytes(source, img, r, type) {
  const whole = r.x === 0 && r.y === 0 && r.w === source.width && r.h === source.height;
  if (whole && isPlain(r.edit) && source.origBlob && source.origBlobType === type) {
    return new Uint8Array(await source.origBlob.arrayBuffer());
  }
  return encodeRegion(img, r, type, source.dpi, r.edit || NO_EDIT);
}

async function singleImagePdf(bytes, isJpeg, w, h, dpi) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  doc.setProducer('Scrop');
  doc.setCreator('Scrop');
  const image = isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const pw = (w * 72) / dpi;
  const ph = (h * 72) / dpi;
  const page = doc.addPage([pw, ph]);
  page.drawImage(image, { x: 0, y: 0, width: pw, height: ph });
  return doc.save();
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

// Crops `rects` (integer source pixels, optional `edit`) one at a time; returns [{name, blob, w, h}].
export async function exportCrops(source, rects, format, firstNo, onProgress) {
  const kind = outputKind(source, format);
  const files = [];
  const opened = await source.open();
  try {
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const no = firstNo + i;
      onProgress?.(no);
      const out = rotatedSize(r.w, r.h, r.edit?.rot);
      let bytes;
      if (kind === 'pdf') {
        const type = source.lossy ? 'jpeg' : 'png';
        const img = await cropBytes(source, opened.img, r, type);
        bytes = await singleImagePdf(img, type === 'jpeg', out.w, out.h, source.dpi);
      } else {
        bytes = await cropBytes(source, opened.img, r, kind === 'jpg' ? 'jpeg' : 'png');
      }
      files.push({ name: `scrop_${no}.${kind}`, blob: new Blob([bytes], { type: MIME[kind] }), w: out.w, h: out.h });
    }
  } finally {
    opened.close();
  }
  return files;
}

export async function zipFiles(files) {
  const { zipSync } = await loadFflate();
  const entries = {};
  for (const f of files) entries[f.name] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }];
  return new Blob([zipSync(entries)], { type: 'application/zip' });
}
