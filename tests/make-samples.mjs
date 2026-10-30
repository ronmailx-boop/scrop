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
  console.log('samples written to', dir);
}
