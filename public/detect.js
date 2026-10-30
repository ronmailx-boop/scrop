// Automatic photo detection on a scan: finds each photo lying on the (uniform)
// scanner bed and returns a crop frame for it, tilted to match a crooked photo.
// Works on a downscaled copy; results are mapped back to source pixels.

const WORK_SIDE = 1200;       // long side of the analysis image
const MIN_AREA = 0.012;       // of the page: smaller blobs are dust / noise
const MIN_SIDE = 0.04;        // of the page's short side
const STRAIGHT = 0.4;         // degrees below which a photo counts as straight

// ---------- binary morphology (square kernels, separable running sums) ----------

function boxPass(src, w, h, r, horizontal, keepIfAny) {
  const out = new Uint8Array(w * h);
  const n = horizontal ? w : h;
  const lines = horizontal ? h : w;
  for (let l = 0; l < lines; l++) {
    const at = horizontal ? (i) => l * w + i : (i) => i * w + l;
    let sum = 0;
    for (let i = 0; i < Math.min(r, n); i++) sum += src[at(i)];
    for (let i = 0; i < n; i++) {
      if (i + r < n) sum += src[at(i + r)];
      if (i - r - 1 >= 0) sum -= src[at(i - r - 1)];
      const span = Math.min(n - 1, i + r) - Math.max(0, i - r) + 1;
      out[at(i)] = keepIfAny ? (sum > 0 ? 1 : 0) : (sum === span ? 1 : 0);
    }
  }
  return out;
}

const dilate = (m, w, h, r) => (r < 1 ? m : boxPass(boxPass(m, w, h, r, true, true), w, h, r, false, true));
const erode = (m, w, h, r) => (r < 1 ? m : boxPass(boxPass(m, w, h, r, true, false), w, h, r, false, false));

// Foreground = everything the background can't reach from the page edge (fills holes in photos).
function fillHoles(m, w, h) {
  const out = new Uint8Array(w * h).fill(1);
  const stack = [];
  const push = (i) => { if (!m[i] && out[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return out;
}

// 4-connected components: returns arrays of pixel indices.
function components(m, w, h, minPixels) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    const px = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      px.push(i);
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
      for (const j of nb) if (j >= 0 && m[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
    if (px.length >= minPixels) comps.push(px);
  }
  return comps;
}

// ---------- geometry ----------

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Minimum-area enclosing rectangle (rotating calipers over hull edges).
function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x0, y0] = hull[i];
    const [x1, y1] = hull[(i + 1) % hull.length];
    const t = Math.atan2(y1 - y0, x1 - x0);
    const c = Math.cos(t), s = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      best = { area, w: u1 - u0, h: v1 - v0, cx: um * c - vm * s, cy: um * s + vm * c, deg: (t * 180) / Math.PI };
    }
  }
  // Fold the angle into (-45°, 45°], swapping sides on each quarter turn.
  let { w, h, deg } = best;
  while (deg > 45) { deg -= 90; [w, h] = [h, w]; }
  while (deg <= -45) { deg += 90; [w, h] = [h, w]; }
  return { cx: best.cx, cy: best.cy, w, h, deg };
}

// Frame for one blob, in analysis pixels. Boundary pixels are taken at their outer corners.
function frameOf(px, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pts = [];
  for (const i of px) {
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  // Hull from each row's extreme pixels (enough for a convex hull, much cheaper).
  const rows = new Map();
  for (const i of px) {
    const x = i % w, y = (i - x) / w;
    const r = rows.get(y);
    if (!r) rows.set(y, [x, x]);
    else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
  }
  for (const [y, [a, b]] of rows) pts.push([a, y], [a, y + 1], [b + 1, y], [b + 1, y + 1]);
  const rect = minAreaRect(convexHull(pts));
  const fill = px.length / Math.max(1, rect.w * rect.h);
  if (Math.abs(rect.deg) < STRAIGHT) {
    return { cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2, w: x1 - x0 + 1, h: y1 - y0 + 1, deg: 0, fill };
  }
  return { ...rect, fill };
}

// ---------- detection ----------

// The scanner bed is the most common uniform colour in the scan: photos are textured,
// so their colours spread out, while the bed piles up in one bin. Sampling the whole
// scan (not just its edge) matters because photos often sit against the scan's edges.
function backgroundOf(data, w, h) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200000)));
  const bins = new Uint32Array(4096);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      bins[((data[o] >> 4) << 8) | ((data[o + 1] >> 4) << 4) | (data[o + 2] >> 4)]++;
    }
  }
  let peak = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
  // Refine: mean colour of samples within ±1 bin of the peak.
  const pr = peak >> 8, pg = (peak >> 4) & 15, pb = peak & 15;
  let sr = 0, sg = 0, sb = 0, n = 0;
  const near = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const o = (y * w + x) * 4;
      if (Math.abs((data[o] >> 4) - pr) <= 1 && Math.abs((data[o + 1] >> 4) - pg) <= 1 && Math.abs((data[o + 2] >> 4) - pb) <= 1) {
        sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; n++;
        near.push(o);
      }
    }
  }
  const bg = [sr / n, sg / n, sb / n];
  // Bed noise: spread of the bed samples around its colour.
  const dist = near.map((o) => Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2])))
    .sort((a, b) => a - b);
  const noise = dist[Math.floor(dist.length * 0.98)] || 0;
  return { bg, threshold: Math.min(36, Math.max(10, noise * 1.5 + 6)) };
}

// image: {data, width, height} (RGBA). Returns frames in image pixels.
export function detectInImage({ data, width: w, height: h }) {
  const { bg, threshold } = backgroundOf(data, w, h);
  let mask = new Uint8Array(w * h);
  for (let i = 0, o = 0; i < mask.length; i++, o += 4) {
    const d = Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2]));
    mask[i] = d > threshold ? 1 : 0;
  }
  // Small closing: the convex hull already ignores nicks in a photo's edge, and a wide
  // closing would fuse photos lying close together. The opening is a bit wider, to drop
  // dust and the thin dark lines a scanner lid leaves along the scan's edge.
  mask = erode(dilate(mask, w, h, 1), w, h, 1);
  const open = Math.max(2, Math.round(Math.max(w, h) * 0.002));
  mask = dilate(erode(mask, w, h, open), w, h, open);
  mask = fillHoles(mask, w, h);

  const minPixels = w * h * MIN_AREA;
  const minSide = Math.min(w, h) * MIN_SIDE;
  const frames = [];
  for (const px of components(mask, w, h, minPixels)) {
    // Photos touching each other: erode until the blob splits. A single photo is a
    // solid blob (holes are filled), so it never splits and is kept whole.
    const parts = splitBlob(px, w, minPixels);
    if (parts) frames.push(...parts);
    else frames.push(frameOf(px, w));
  }
  return frames
    .filter((f) => f.w >= minSide && f.h >= minSide && f.w < w * 0.98 && f.h < h * 0.98)
    // Reading order: rows top to bottom, then right to left (Hebrew).
    .sort((a, b) => (Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) / 2 ? b.cx - a.cx : a.cy - b.cy));
}

function splitBlob(px, w, minPixels) {
  // Work on the blob's bounding box (with a margin) to keep this cheap.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of px) {
    const x = i % w, y = (i - x) / w;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const limit = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.45));
  const pad = limit + 1;
  const bw = x1 - x0 + 1 + 2 * pad;
  const bh = y1 - y0 + 1 + 2 * pad;
  const toLocal = (i) => { const x = i % w; return ((i - x) / w - y0 + pad) * bw + (x - x0 + pad); };
  const toGlobal = (j) => { const x = j % bw; return ((j - x) / bw + y0 - pad) * w + (x + x0 - pad); };
  const m = new Uint8Array(bw * bh);
  for (const i of px) m[toLocal(i)] = 1;
  const step = Math.max(1, Math.round(limit / 12));
  for (let r = step; r <= limit; r += step) {
    const cores = components(erode(m, bw, bh, r), bw, bh, 16);
    if (!cores.length) return null;
    if (cores.length < 2) continue;
    // Grow each core back by r, inside the blob; keep the split only if it gives 2+ photo-sized parts.
    const parts = cores.map((p) => {
      const core = new Uint8Array(bw * bh);
      for (const j of p) core[j] = 1;
      const grown = dilate(core, bw, bh, r);
      const back = [];
      for (let j = 0; j < m.length; j++) if (m[j] && grown[j]) back.push(toGlobal(j));
      return back;
    }).filter((b) => b.length >= minPixels);
    if (parts.length >= 2) return parts.map((b) => frameOf(b, w));
  }
  return null;
}

// Runs on the display copy of the scan; returns crops in source pixels:
// [{x, y, w, h, angle}] with angle in degrees (clockwise).
export function detectPhotos(preview, srcW, srcH) {
  const k = Math.min(1, WORK_SIDE / Math.max(preview.width, preview.height));
  const w = Math.max(1, Math.round(preview.width * k));
  const h = Math.max(1, Math.round(preview.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(preview, 0, 0, w, h);
  const frames = detectInImage(ctx.getImageData(0, 0, w, h));
  c.width = c.height = 0;
  const sx = srcW / w;
  const sy = srcH / h;
  // Pull each edge in by ~1 analysis pixel so no scanner-bed sliver is left around the photo.
  const inset = 1;
  return frames.map((f) => {
    const fw = Math.max(2, Math.round((f.w - 2 * inset) * sx));
    const fh = Math.max(2, Math.round((f.h - 2 * inset) * sy));
    return {
      x: Math.round(f.cx * sx - fw / 2),
      y: Math.round(f.cy * sy - fh / 2),
      w: fw,
      h: fh,
      angle: Math.round(f.deg * 10) / 10,
    };
  });
}
