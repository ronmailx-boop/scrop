// Generates an A4 300 DPI scan containing 4 "photos" of different sizes,
// as PNG, JPG and three PDF variants (embedded JPEG, embedded PNG, vector).
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument, rgb } from 'pdf-lib';

export const W = 2480;
export const H = 3508;
export const PHOTOS = [
  { x: 150, y: 200, w: 1000, h: 700 },
  { x: 1300, y: 250, w: 1030, h: 1400 },
  { x: 200, y: 1100, w: 900, h: 1300 },
  { x: 1250, y: 1900, w: 1101, h: 1451 },
];

export function pixel(x, y) {
  const i = PHOTOS.findIndex((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
  if (i < 0) return [255, 255, 255];
  const p = PHOTOS[i];
  if (x === p.x || y === p.y || x === p.x + p.w - 1 || y === p.y + p.h - 1) return [0, 0, 0];
  return [
    Math.round(128 + 100 * Math.sin(x / 9 + i)),
    Math.round(128 + 100 * Math.sin(y / 7 + i * 2)),
    Math.round(128 + 100 * Math.sin((x + y) / 13)),
  ];
}

// Crooked photos (center, size, clockwise angle); photos 3 and 4 almost touch (≈1 mm apart at the top).
export const TILTED = [
  { cx: 640, cy: 700, w: 1000, h: 760, deg: -6 },
  { cx: 1820, cy: 760, w: 900, h: 1200, deg: 9.5 },
  { cx: 700, cy: 2250, w: 1100, h: 1400, deg: 3 },
  { cx: 1878, cy: 2250, w: 1150, h: 1400, deg: 0 },
];

export function tiltedPixel(x, y) {
  for (const [i, p] of TILTED.entries()) {
    const t = (p.deg * Math.PI) / 180;
    const dx = x + 0.5 - p.cx, dy = y + 0.5 - p.cy;
    const u = dx * Math.cos(t) + dy * Math.sin(t);
    const v = -dx * Math.sin(t) + dy * Math.cos(t);
    if (Math.abs(u) <= p.w / 2 && Math.abs(v) <= p.h / 2) {
      // Each photo has a light sky-like top half, like real prints.
      const sky = v < 0;
      return [
        Math.round((sky ? 200 : 90) + 40 * Math.sin(u / 23 + i)),
        Math.round((sky ? 215 : 120) + 30 * Math.sin(v / 17)),
        Math.round((sky ? 235 : 60) + 15 * Math.sin((u + v) / 31)),
      ];
    }
  }
  return [250, 250, 248];
}

export function makeTilted(dir) {
  const png = new PNG({ width: W, height: H, colorType: 2 });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const [r, g, b] = tiltedPixel(x, y);
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png, { colorType: 2 });
  fs.writeFileSync(path.join(dir, 'scan-tilted.png'), buf);
  return png;
}

// Like a real phone-user scan: photos pushed into the scanner's corner (touching the
// top/left/right edges), one very light beach photo, narrow white gaps, an off-white
// noisy bed and the scanner lid's dark line along the top edge.
export const SCAN_W = 2400;
export const SCAN_H = 3437;
export const EDGE = [
  { x: 0, y: 0, w: 1180, h: 1680, kind: 'beach' },
  { x: 1215, y: 0, w: 1185, h: 1700, kind: 'dark' },
  { x: 420, y: 1960, w: 1690, h: 1180, kind: 'snow' },
];

function noise(x, y) {
  // Deterministic grain in [-1, 1].
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return (n - Math.floor(n)) * 2 - 1;
}

export function edgePixel(x, y) {
  if (y < 6 && x > 1500) return [40, 40, 45]; // lid line at the top edge
  for (const p of EDGE) {
    if (x < p.x || x >= p.x + p.w || y < p.y || y >= p.y + p.h) continue;
    const u = (x - p.x) / p.w, v = (y - p.y) / p.h, g = noise(x, y) * 10;
    if (p.kind === 'beach') {
      // Pale sky, very light sand, a darker figure in the middle.
      if (Math.abs(u - 0.45) < 0.08 && v > 0.25 && v < 0.75) return [60 + g, 70 + g, 110 + g];
      return v < 0.2 ? [205 + g, 222 + g, 238 + g] : [226 + g, 212 + g, 206 + g];
    }
    if (p.kind === 'dark') return [30 + 20 * Math.sin(u * 20) + g, 30 + g, 60 + 30 * v + g];
    return [150 + 60 * v + g, 170 + 50 * v + g, 175 + 40 * Math.sin(u * 30) + g]; // snow scene
  }
  const g = noise(x, y) * 2;
  return [247 + g, 247 + g, 245 + g];
}

export function makeEdgeScan(dir) {
  const png = new PNG({ width: SCAN_W, height: SCAN_H, colorType: 2 });
  for (let y = 0; y < SCAN_H; y++) {
    for (let x = 0; x < SCAN_W; x++) {
      const o = (y * SCAN_W + x) * 4;
      const [r, g, b] = edgePixel(x, y);
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(dir, 'scan-edge.png'), PNG.sync.write(png, { colorType: 2 }));
  return png;
}

export function makeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixel(x, y);
      const o = (y * W + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  const png = new PNG({ width: W, height: H, colorType: 2 });
  png.data = rgba;
  const pngBuf = PNG.sync.write(png, { colorType: 2 });
  fs.writeFileSync(path.join(dir, 'scan.png'), pngBuf);
  const jpgBuf = jpeg.encode({ width: W, height: H, data: rgba }, 95).data;
  fs.writeFileSync(path.join(dir, 'scan.jpg'), jpgBuf);
  return { pngBuf, jpgBuf };
}

async function pdfWith(embed) {
  const doc = await PDFDocument.create();
  const pw = W * 72 / 300;
  const ph = H * 72 / 300;
  const page = doc.addPage([pw, ph]);
  await embed(doc, page, pw, ph);
  return doc.save();
}

export async function makePdfs(dir, { pngBuf, jpgBuf }) {
  fs.writeFileSync(path.join(dir, 'scan-jpeg.pdf'), await pdfWith(async (doc, page, pw, ph) => {
    page.drawImage(await doc.embedJpg(jpgBuf), { x: 0, y: 0, width: pw, height: ph });
  }));
  fs.writeFileSync(path.join(dir, 'scan-png.pdf'), await pdfWith(async (doc, page, pw, ph) => {
    page.drawImage(await doc.embedPng(pngBuf), { x: 0, y: 0, width: pw, height: ph });
  }));
  // Vector page (no raster image): forces the 300 DPI render path. Two pages.
  const doc = await PDFDocument.create();
  for (let n = 0; n < 2; n++) {
    const page = doc.addPage([W * 72 / 300, H * 72 / 300]);
    const k = 72 / 300;
    PHOTOS.forEach((p, i) => page.drawRectangle({
      x: p.x * k, y: (H - p.y - p.h) * k, width: p.w * k, height: p.h * k,
      color: rgb([0.9, 0.2, 0.2, 0.2][i], [0.2, 0.8, 0.2, 0.3][i], [0.2, 0.2, 0.9, 0.7][i]),
    }));
  }
  fs.writeFileSync(path.join(dir, 'scan-vector.pdf'), await doc.save());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || 'tests/samples';
  const bufs = makeSamples(dir);
  await makePdfs(dir, bufs);
  makeTilted(dir);
  makeEdgeScan(dir);
  console.log('samples written to', dir);
}
