// End-to-end check: loads generated A4 scans in Chromium (Pixel 7 emulation),
// sets 4 crops via the numeric fields, saves as ZIP and verifies every output
// file's pixel dimensions and that its content matches the selected coordinates.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { unzipSync } from 'fflate';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { makeSamples, makePdfs, makeTilted, PHOTOS, TILTED, W, pixel, tiltedPixel } from './make-samples.mjs';
import { serve } from './serve.mjs';
import { rotatedSize, rotationMatrix, adjustPixels, NO_EDIT } from '../public/engine.js';

// Playwright is resolved via require so a globally installed copy (NODE_PATH) also works.
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '.out');
const PORT = 8765;

// ---------- pixel helpers ----------

const decodeJpeg = (buf) => jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });

// Mean absolute RGB difference between an output image and the source region shifted by (dx, dy).
function meanDiff(img, src, r, dx = 0, dy = 0) {
  let sum = 0, n = 0;
  for (let y = 2; y < r.h - 2; y += 3) {
    for (let x = 2; x < r.w - 2; x += 3) {
      const o = (y * img.width + x) * 4;
      const s = ((r.y + y + dy) * src.width + (r.x + x + dx)) * 4;
      for (let c = 0; c < 3; c++) { sum += Math.abs(img.data[o + c] - src.data[s + c]); n++; }
    }
  }
  return sum / n;
}

// Lossy outputs: aligned diff must be small and far below a 1-pixel shift in any direction.
function assertAligned(img, src, r, label) {
  const d0 = meanDiff(img, src, r);
  const shifted = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => meanDiff(img, src, r, dx, dy));
  assert.ok(d0 < 2.5, `${label}: aligned diff ${d0.toFixed(2)} too large`);
  for (const d of shifted) assert.ok(d > d0 * 3, `${label}: shift diff ${d.toFixed(2)} vs aligned ${d0.toFixed(2)}`);
  return d0;
}

function assertExactRGB(rgbAt, r, label) {
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const got = rgbAt(x, y);
      const want = pixel(r.x + x, r.y + y);
      if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
        assert.fail(`${label}: pixel (${x},${y}) = ${got} expected ${want}`);
      }
    }
  }
}

function jfifDpi(b) {
  return b[13] === 1 ? (b[14] << 8) | b[15] : 0;
}

async function pdfImage(buf) {
  const doc = await PDFDocument.load(buf);
  const page = doc.getPage(0);
  const xo = page.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const [[, ref]] = xo.entries();
  const s = doc.context.lookup(ref);
  const num = (k) => s.dict.get(PDFName.of(k)).asNumber();
  return {
    pages: doc.getPageCount(),
    size: page.getSize(),
    w: num('Width'), h: num('Height'),
    filter: s.dict.get(PDFName.of('Filter')).toString(),
    contents: s.contents,
  };
}

// ---------- browser driving ----------

async function open(page, file) {
  await page.goto(`http://localhost:${PORT}/`);
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForFunction(() => document.getElementById('busy').hidden);
}

// Removes the automatically detected crops so a test can set exact ones.
async function clearCrops(page) {
  while (await page.locator('.chip').count()) {
    await page.locator('.chip').first().click();
    await page.click('#btnDelete');
  }
}

async function saveZip(page, name) {
  await page.waitForSelector('#results[open]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnZip')]);
  const zipPath = path.join(OUT, `${name}.zip`);
  await download.saveAs(zipPath);
  await page.click('#btnClose');
  return unzipSync(fs.readFileSync(zipPath));
}

// Crops the app currently holds, in source pixels, read from the numeric fields.
async function readCrops(page) {
  const out = [];
  const n = await page.locator('.chip').count();
  for (let i = 0; i < n; i++) {
    await page.locator('.chip').nth(i).click();
    const v = async (k) => Number(await page.inputValue(`#fields input[data-k="${k}"][data-u="px"]`));
    out.push({ x: await v('x'), y: await v('y'), w: await v('w'), h: await v('h'),
      angle: await page.evaluate(() => Number(document.querySelector('#adjust input[data-adj="angle"]').value)) });
  }
  return out;
}

async function run(page, file, rectsByPage, format) {
  await open(page, file);
  const info = await page.textContent('#srcInfo');
  for (const [pageNo, rects] of rectsByPage) {
    if (pageNo > 1) {
      await page.selectOption('#pageSelect', String(pageNo));
      await page.waitForFunction(() => document.getElementById('busy').hidden);
    }
    await clearCrops(page);
    for (const r of rects) {
      await page.click('#btnAdd');
      const set = async (k, v) => page.fill(`#fields input[data-k="${k}"][data-u="px"]`, String(v));
      await set('w', 2); await set('h', 2);
      await set('x', r.x); await set('y', r.y); await set('w', r.w); await set('h', r.h);
      if (r.edit) {
        if (!(await page.$eval('#adjust', (d) => d.open))) await page.click('#adjust summary');
        for (let k = 0; k < (r.edit.rot || 0) / 90; k++) await page.click('#rotR');
        for (const key of ['angle', 'bright', 'contrast', 'vivid']) {
          if (r.edit[key]) await page.fill(`#adjust input[data-adj="${key}"]`, String(r.edit[key]));
        }
      }
      await page.locator('#btnAdd').focus();
      const out = await page.textContent('#selOut');
      const o = rotatedSize(r.w, r.h, r.edit?.rot);
      assert.equal(out, `פלט: ${o.w}×${o.h} px`);
    }
  }
  await page.click(`.seg input[value="${format}"] + span`);
  await page.click('#btnSave');
  return { info, files: await saveZip(page, `${path.basename(file)}-${format}`) };
}

// ---------- main ----------

fs.rmSync(OUT, { recursive: true, force: true });
const bufs = makeSamples(OUT);
await makePdfs(OUT, bufs);
makeTilted(OUT);
const srcJpeg = decodeJpeg(bufs.jpgBuf);
const server = await serve(path.join(here, '..', 'public'), PORT);
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const single = [[1, PHOTOS]];
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n  ${e.message}`);
  }
}

await test('PNG → PNG: pixel-exact crops, 300 DPI stamped', async () => {
  const { files } = await run(page, path.join(OUT, 'scan.png'), single, 'source');
  assert.deepEqual(Object.keys(files).sort(), ['scrop_1.png', 'scrop_2.png', 'scrop_3.png', 'scrop_4.png']);
  PHOTOS.forEach((r, i) => {
    const buf = Buffer.from(files[`scrop_${i + 1}.png`]);
    const img = PNG.sync.read(buf);
    assert.equal(`${img.width}x${img.height}`, `${r.w}x${r.h}`);
    assertExactRGB((x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2]]; }, r, `crop ${i + 1}`);
    const phys = buf.indexOf('pHYs');
    assert.ok(phys > 0 && Math.round(buf.readUInt32BE(phys + 4) * 0.0254) === 300, 'pHYs 300 DPI');
  });
});

await test('JPG → JPG: exact dimensions, aligned to the selected coordinates', async () => {
  const { files } = await run(page, path.join(OUT, 'scan.jpg'), single, 'source');
  PHOTOS.forEach((r, i) => {
    const buf = files[`scrop_${i + 1}.jpg`];
    const img = decodeJpeg(buf);
    assert.equal(`${img.width}x${img.height}`, `${r.w}x${r.h}`);
    assert.equal(jfifDpi(buf), 300);
    const d = assertAligned(img, srcJpeg, r, `crop ${i + 1}`);
    console.log(`    crop ${i + 1}: ${r.w}x${r.h}, mean diff vs source ${d.toFixed(2)}`);
  });
});

await test('PNG → JPG format option', async () => {
  const { files } = await run(page, path.join(OUT, 'scan.png'), single, 'jpg');
  PHOTOS.forEach((r, i) => {
    const img = decodeJpeg(files[`scrop_${i + 1}.jpg`]);
    assert.equal(`${img.width}x${img.height}`, `${r.w}x${r.h}`);
  });
});

await test('PDF (embedded JPEG) → PDF: native image used, page = crop size, JPEG embedded', async () => {
  const { info, files } = await run(page, path.join(OUT, 'scan-jpeg.pdf'), single, 'source');
  assert.match(info, /2480×3508 px · 300 DPI · תמונה מוטמעת/);
  for (const [i, r] of PHOTOS.entries()) {
    const im = await pdfImage(files[`scrop_${i + 1}.pdf`]);
    assert.equal(im.pages, 1);
    assert.equal(`${im.w}x${im.h}`, `${r.w}x${r.h}`);
    assert.equal(im.filter, '/DCTDecode');
    assert.ok(Math.abs(im.size.width - r.w * 72 / 300) < 0.01 && Math.abs(im.size.height - r.h * 72 / 300) < 0.01, 'page size');
    assertAligned(decodeJpeg(im.contents), srcJpeg, r, `crop ${i + 1}`);
  }
});

await test('PDF (embedded PNG) → PDF: pixel-exact, lossless embedding', async () => {
  const { info, files } = await run(page, path.join(OUT, 'scan-png.pdf'), single, 'source');
  assert.match(info, /2480×3508 px · 300 DPI · תמונה מוטמעת/);
  for (const [i, r] of PHOTOS.entries()) {
    const im = await pdfImage(files[`scrop_${i + 1}.pdf`]);
    assert.equal(`${im.w}x${im.h}`, `${r.w}x${r.h}`);
    assert.equal(im.filter, '/FlateDecode');
    const raw = zlib.inflateSync(Buffer.from(im.contents));
    assert.equal(raw.length, r.w * r.h * 3);
    assertExactRGB((x, y) => { const o = (y * r.w + x) * 3; return [raw[o], raw[o + 1], raw[o + 2]]; }, r, `crop ${i + 1}`);
  }
});

await test('Vector PDF, 2 pages → rendered at 300 DPI, crops from both pages numbered in order', async () => {
  const p2 = [{ x: 0, y: 0, w: 2480, h: 3508 }, { x: 10, y: 20, w: 333, h: 444 }];
  const { info, files } = await run(page, path.join(OUT, 'scan-vector.pdf'), [[1, PHOTOS], [2, p2]], 'source');
  assert.match(info, /2480×3508 px · 300 DPI · רינדור 300 DPI/);
  const all = [...PHOTOS, ...p2];
  assert.equal(Object.keys(files).length, 6);
  for (const [i, r] of all.entries()) {
    const im = await pdfImage(files[`scrop_${i + 1}.pdf`]);
    assert.equal(`${im.w}x${im.h}`, `${r.w}x${r.h}`);
    assert.equal(im.filter, '/FlateDecode');
    if (i === 1) {
      // Photo 2 is green: its center pixel must be exactly the fill colour.
      const raw = zlib.inflateSync(Buffer.from(im.contents));
      const o = ((r.h >> 1) * r.w + (r.w >> 1)) * 3;
      assert.deepEqual([...raw.subarray(o, o + 3)], [51, 204, 51]);
    }
  }
});

await test('Rotate + brightness/contrast/vivid: exact pixels after the edit (PNG)', async () => {
  // Formula sanity: brightness +20% on mid-grey, contrast +50% around the midpoint, vivid 0 keeps grey.
  assert.deepEqual([...adjustPixels(new Uint8ClampedArray([100, 100, 100, 255]), { bright: 20, contrast: 0, vivid: 0 })], [120, 120, 120, 255]);
  assert.deepEqual([...adjustPixels(new Uint8ClampedArray([191, 64, 128, 255]), { bright: 0, contrast: 50, vivid: 0 })], [223, 32, 128, 255]);
  assert.deepEqual([...adjustPixels(new Uint8ClampedArray([90, 90, 90, 255]), { bright: 0, contrast: 0, vivid: 80 })], [90, 90, 90, 255]);
  const edits = [
    { rot: 90 },
    { bright: 20, contrast: 10, vivid: 30 },
    { rot: 180, vivid: -100 },
    { rot: 270, bright: -15, contrast: 25 },
  ];
  const rects = PHOTOS.map((r, i) => ({ ...r, edit: edits[i] }));
  const { files } = await run(page, path.join(OUT, 'scan.png'), [[1, rects]], 'source');
  rects.forEach((r, i) => {
    const e = { ...NO_EDIT, ...r.edit };
    const img = PNG.sync.read(Buffer.from(files[`scrop_${i + 1}.png`]));
    const o = rotatedSize(r.w, r.h, e.rot);
    assert.equal(`${img.width}x${img.height}`, `${o.w}x${o.h}`);
    const [a, b, c, d, ex, f] = rotationMatrix(r.w, r.h, e.rot);
    const px = new Uint8ClampedArray(4);
    for (let v = 0; v < r.h; v++) {
      for (let u = 0; u < r.w; u++) {
        px.set([...pixel(r.x + u, r.y + v), 255]);
        adjustPixels(px, e);
        const X = a * u + c * v + ex - (a < 0 || c < 0 ? 1 : 0);
        const Y = b * u + d * v + f - (b < 0 || d < 0 ? 1 : 0);
        const p = (Y * img.width + X) * 4;
        const got = [img.data[p], img.data[p + 1], img.data[p + 2]];
        if (got[0] !== px[0] || got[1] !== px[1] || got[2] !== px[2]) {
          assert.fail(`crop ${i + 1}: (${u},${v})→(${X},${Y}) = ${got} expected ${[...px.subarray(0, 3)]}`);
        }
      }
    }
  });
});

await test('Free straightening: output = frame content turned upright, frame size kept', async () => {
  // A frame inside photo 2, tilted 7.5° clockwise around its center.
  const r = { x: 1500, y: 600, w: 600, h: 400, edit: { angle: 7.5 } };
  const { files } = await run(page, path.join(OUT, 'scan.png'), [[1, [r]]], 'source');
  const img = PNG.sync.read(Buffer.from(files['scrop_1.png']));
  assert.equal(`${img.width}x${img.height}`, '600x400');
  // Output pixel (u, v) must show source point center + R(angle)·(u - w/2, v - h/2).
  const err = (deg) => {
    const t = (deg * Math.PI) / 180;
    let sum = 0, n = 0;
    for (let v = 20; v < r.h - 20; v += 17) {
      for (let u = 20; u < r.w - 20; u += 17) {
        const du = u + 0.5 - r.w / 2, dv = v + 0.5 - r.h / 2;
        const sx = Math.floor(r.x + r.w / 2 + du * Math.cos(t) - dv * Math.sin(t));
        const sy = Math.floor(r.y + r.h / 2 + du * Math.sin(t) + dv * Math.cos(t));
        const want = pixel(sx, sy);
        const o = (v * img.width + u) * 4;
        for (let c = 0; c < 3; c++) { sum += Math.abs(img.data[o + c] - want[c]); n++; }
      }
    }
    return sum / n;
  };
  const good = err(7.5);
  console.log(`    mean error at +7.5°: ${good.toFixed(2)}, at -7.5°: ${err(-7.5).toFixed(2)}, at 0°: ${err(0).toFixed(2)}`);
  assert.ok(good < 8, `straightened content off: ${good}`);
  assert.ok(err(-7.5) > good * 4 && err(0) > good * 4, 'rotation direction/amount');
});

await test('Auto-detect: finds the 4 straight photos of the scan', async () => {
  await open(page, path.join(OUT, 'scan.png'));
  assert.match(await page.textContent('#detectText'), /זוהו 4 תמונות/);
  const found = await readCrops(page);
  for (const p of PHOTOS) {
    const f = found.find((r) => Math.abs(r.x - p.x) < 20 && Math.abs(r.y - p.y) < 20);
    assert.ok(f, `photo at ${p.x},${p.y} not found in ${JSON.stringify(found)}`);
    assert.equal(f.angle, 0);
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(f[k] - p[k]) <= 6, `${k}: ${f[k]} vs ${p[k]}`);
  }
});

await test('Auto-detect crooked photos: frames straightened, save all at once', async () => {
  await open(page, path.join(OUT, 'scan-tilted.png'));
  assert.match(await page.textContent('#detectText'), /זוהו 4 תמונות/);
  const found = await readCrops(page);
  for (const p of TILTED) {
    const f = found.find((r) => Math.hypot(r.x + r.w / 2 - p.cx, r.y + r.h / 2 - p.cy) < 15);
    assert.ok(f, `photo at ${p.cx},${p.cy} not found in ${JSON.stringify(found)}`);
    assert.ok(Math.abs(f.angle - p.deg) <= 0.3, `angle ${f.angle} vs ${p.deg}`);
    assert.ok(Math.abs(f.w - p.w) <= 10 && Math.abs(f.h - p.h) <= 10, `size ${f.w}x${f.h} vs ${p.w}x${p.h}`);
  }
  // One tap: "save all" in the detection bar.
  await page.click('#detectSave');
  const files = await saveZip(page, 'tilted-auto');
  assert.equal(Object.keys(files).length, 4);
  for (const [name, buf] of Object.entries(files)) {
    const img = PNG.sync.read(Buffer.from(buf));
    // Straightened output: the outer rows/columns are photo, not scanner bed.
    let bed = 0, n = 0;
    const edge = (x, y) => {
      const o = (y * img.width + x) * 4;
      const want = tiltedPixel(-10, -10);
      if (Math.abs(img.data[o] - want[0]) + Math.abs(img.data[o + 1] - want[1]) + Math.abs(img.data[o + 2] - want[2]) < 12) bed++;
      n++;
    };
    for (let x = 0; x < img.width; x += 3) { edge(x, 1); edge(x, img.height - 2); }
    for (let y = 0; y < img.height; y += 3) { edge(1, y); edge(img.width - 2, y); }
    assert.ok(bed / n < 0.02, `${name}: ${(100 * bed / n).toFixed(1)}% of the border is scanner bed`);
  }
});

await test('After detection a crop is selected; ✕ on the frame deletes it', async () => {
  await open(page, path.join(OUT, 'scan.png'));
  assert.equal(await page.locator('.chip').count(), 4);
  assert.ok(await page.isVisible('#fields'), 'edit fields visible for the selected crop');
  assert.ok(await page.isVisible('#adjust summary'), 'rotate/straighten section reachable');
  await page.click('.crop.sel .del');
  assert.equal(await page.locator('.chip').count(), 3);
  assert.equal(await page.locator('.crop').count(), 3);
  // Undo brings it back.
  await page.click('#toast button');
  assert.equal(await page.locator('.crop').count(), 4);
  await page.click('.crop.sel .del');
  assert.equal(await page.locator('.crop').count(), 3);
  // Nothing selected now → hint tells the user to tap a frame.
  // Tap on empty scanner bed → nothing selected → hint tells the user to tap a frame.
  const st = await page.locator('#stage').boundingBox();
  await page.mouse.click(st.x + 6, st.y + st.height - 6);
  assert.equal(await page.locator('.crop.sel').count(), 0);
  assert.ok(await page.isVisible('#pickHint'), 'hint visible');
  assert.ok(!(await page.isVisible('#fields')));
});

await test('No page errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
console.log(failed ? `\n${failed} test(s) failed` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
