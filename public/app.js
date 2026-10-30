import {
  openImage, openPdf, closePdf, pdfPageSource, exportCrops, zipFiles, outputKind, UserError,
  NO_EDIT, isPlain, rotatedSize, drawCrop, adjustPixels,
} from './engine.js';
import { detectPhotos } from './detect.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#7367f0', '#e8467c', '#20a86b', '#f39c12', '#1e88e5', '#9c27b0', '#00acc1', '#e53935'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot'];
const MAX_ANGLE = 45;
const MIN_SIDE = 2;

const state = {
  name: '',
  pdf: null,
  page: 1,
  source: null,
  rects: new Map(), // page -> [{id, x, y, w, h}]
  pageViews: new Map(), // page -> {canvas, w, h}: small display copy, for the review screen
  selected: null,
  view: { s: 1, tx: 0, ty: 0 },
  files: [],
};
let nextId = 1;

$('appVersion').textContent = `v${window.SCROP_VERSION}`;

const stage = $('stage');
const overlay = $('overlay');
const preview = $('preview');

// ---------- helpers ----------

// Optional action = {label, run}: shows a button in the toast (e.g. undo).
function toast(msg, ms = 3500, action = null) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { t.classList.remove('show'); action.run(); };
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

function fail(e) {
  console.error(e);
  busy(null);
  if (e instanceof UserError) toast(e.message, 6000);
  else if (e?.name === 'AbortError') return;
  else if (e instanceof RangeError || /memory/i.test(e?.message)) toast('אין מספיק זיכרון במכשיר לעיבוד הקובץ.', 6000);
  else toast('אירעה שגיאה: ' + (e?.message || e), 6000);
}

const pageRects = (p = state.page) => {
  if (!state.rects.has(p)) state.rects.set(p, []);
  return state.rects.get(p);
};

// Crops are numbered across all pages in page order, matching the saved file names.
function labelOf(rect) {
  let n = 0;
  for (const p of [...state.rects.keys()].sort((a, b) => a - b)) {
    const list = state.rects.get(p);
    const i = list.indexOf(rect);
    if (i >= 0) return n + i + 1;
    n += list.length;
  }
  return 0;
}

const colorOf = (n) => COLORS[(n - 1) % COLORS.length];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------- file loading ----------

async function loadFile(file) {
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImg = /^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/i.test(file.name);
  if (!isPdf && !isImg) {
    toast('סוג קובץ לא נתמך. אפשר לבחור PDF, ‏JPG או PNG.');
    return;
  }
  busy('טוען את הקובץ…');
  try {
    await resetDoc();
    state.name = file.name;
    if (isPdf) {
      state.pdf = await openPdf(file);
      const sel = $('pageSelect');
      sel.innerHTML = '';
      for (let i = 1; i <= state.pdf.numPages; i++) sel.add(new Option(`${i} / ${state.pdf.numPages}`, i));
      $('pageWrap').hidden = state.pdf.numPages < 2;
      await showPage(1);
    } else {
      setSource(await openImage(file));
      await detectIfEmpty();
    }
    showEditor();
  } catch (e) {
    fail(e);
    await resetDoc();
  } finally {
    busy(null);
  }
}

async function resetDoc() {
  showDetectBar(null);
  state.source?.release();
  state.source = null;
  if (state.pdf) await closePdf(state.pdf);
  state.pdf = null;
  state.rects = new Map();
  for (const v of state.pageViews.values()) v.canvas.width = 0;
  state.pageViews = new Map();
  state.selected = null;
  state.page = 1;
}

async function showPage(n) {
  busy('טוען עמוד…');
  try {
    state.source?.release();
    state.source = null;
    state.page = n;
    state.selected = null;
    setSource(await pdfPageSource(state.pdf, n));
    await detectIfEmpty();
  } finally {
    busy(null);
  }
}

// ---------- automatic photo detection ----------

async function detectIfEmpty() {
  if (pageRects().length) { showDetectBar(null); return; }
  await runDetect();
}

async function runDetect() {
  const src = state.source;
  if (!src) return;
  busy('מזהה תמונות…');
  await new Promise((r) => setTimeout(r, 30)); // let the busy overlay paint
  let found = [];
  try {
    found = detectPhotos(src.preview, src.width, src.height);
  } catch (e) {
    console.warn('detection failed', e);
  }
  busy(null);
  if (state.source !== src) return;
  const list = pageRects();
  list.length = 0;
  for (const f of found) {
    const r = { id: nextId++, x: f.x, y: f.y, w: f.w, h: f.h, edit: { ...NO_EDIT, angle: f.angle } };
    constrain(r);
    list.push(r);
  }
  // Select the first photo so its edit tools are right there in the panel.
  state.selected = list[0] || null;
  showDetectBar(found.length);
  render();
}

function showDetectBar(n) {
  const bar = $('detectBar');
  bar.hidden = n === null;
  if (n === null) return;
  $('detectText').textContent = n === 0
    ? 'לא זוהו תמונות בסריקה. אפשר להוסיף חיתוך ידנית.'
    : `${n === 1 ? 'זוהתה תמונה אחת' : `זוהו ${n} תמונות`}. אפשר לתקן או ליישר מסגרת, או לשמור הכל עכשיו.`;
  $('detectSave').hidden = n === 0;
}

// Display copy of a page, kept after leaving it so the review screen can show its crops.
function keepPageView(src) {
  const k = Math.min(1, 1600 / Math.max(src.preview.width, src.preview.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.preview.width * k);
  c.height = Math.round(src.preview.height * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.preview, 0, 0, c.width, c.height);
  const old = state.pageViews.get(state.page);
  if (old) old.canvas.width = 0;
  state.pageViews.set(state.page, { canvas: c, w: src.width, h: src.height });
}

function setSource(src) {
  state.source = src;
  keepPageView(src);
  preview.width = src.preview.width;
  preview.height = src.preview.height;
  preview.getContext('2d').drawImage(src.preview, 0, 0);
  preview.style.width = src.preview.width + 'px';
  preview.style.height = src.preview.height + 'px';
  $('srcFmt').textContent = outputKind(src, 'source').toUpperCase();
  const info = $('srcInfo');
  info.innerHTML = '<span dir="ltr"></span> · <span dir="ltr"></span><span></span>';
  info.children[0].textContent = `${src.width}×${src.height} px`;
  info.children[1].textContent = `${src.dpi} DPI`;
  info.children[2].textContent = src.note ? ' · ' + src.note : '';
  requestAnimationFrame(() => { fit(); render(); });
}

function showEditor() {
  $('home').hidden = true;
  $('editor').hidden = false;
  $('btnNew').hidden = false;
  document.body.classList.add('editing');
  if (history.state?.editor !== true) history.pushState({ editor: true }, '');
  requestAnimationFrame(() => { fit(); render(); });
}

async function showHome() {
  await resetDoc();
  $('review').hidden = true;
  $('editor').hidden = true;
  $('home').hidden = false;
  $('btnNew').hidden = true;
  document.body.classList.remove('editing');
  $('fileInput').value = '';
}

const hasCrops = () => [...state.rects.values()].some((l) => l.length);

// ---------- view (fit / zoom / pan) ----------

function fit() {
  const src = state.source;
  if (!src) return;
  const { clientWidth: W, clientHeight: H } = stage;
  const s = Math.min(W / src.width, H / src.height) * 0.94;
  state.view = { s, tx: (W - src.width * s) / 2, ty: (H - src.height * s) / 2, fit: s, fitted: true };
}

function zoomAt(cx, cy, factor) {
  const v = state.view;
  const s = clamp(v.s * factor, v.fit * 0.5, Math.max(8, v.fit * 2));
  const k = s / v.s;
  v.fitted = false;
  v.tx = cx - (cx - v.tx) * k;
  v.ty = cy - (cy - v.ty) * k;
  v.s = s;
}

// ---------- rendering ----------

const rectEls = new Map();

function render() {
  const src = state.source;
  if (!src) return;
  const { s, tx, ty } = state.view;
  const k = s * src.width / preview.width;
  preview.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;

  const list = pageRects();
  const alive = new Set();
  for (const r of list) {
    alive.add(r.id);
    let el = rectEls.get(r.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'crop';
      el.dataset.id = r.id;
      el.innerHTML = '<span class="num"></span>' + HANDLES.map((h) => `<i data-h="${h}" class="h h-${h}"></i>`).join('')
        + '<i data-del class="del" title="מחק חיתוך"></i>';
      overlay.append(el);
      rectEls.set(r.id, el);
    }
    const n = labelOf(r);
    el.style.left = r.x * s + tx + 'px';
    el.style.top = r.y * s + ty + 'px';
    el.style.width = r.w * s + 'px';
    el.style.height = r.h * s + 'px';
    el.style.transform = r.edit.angle ? `rotate(${r.edit.angle}deg)` : '';
    el.style.setProperty('--c', colorOf(n));
    el.classList.toggle('sel', r === state.selected);
    el.firstChild.textContent = n;
  }
  for (const [id, el] of rectEls) {
    if (!alive.has(id)) { el.remove(); rectEls.delete(id); }
  }
  renderPanel();
}

function renderPanel() {
  const list = pageRects();
  const chips = $('chips');
  chips.innerHTML = '';
  for (const r of list) {
    const n = labelOf(r);
    const b = document.createElement('button');
    b.className = 'chip' + (r === state.selected ? ' sel' : '');
    b.style.setProperty('--c', colorOf(n));
    const o = rotatedSize(r.w, r.h, r.edit.rot);
    b.innerHTML = `<b>${n}</b><span dir="ltr">${o.w}×${o.h}</span>${isPlain(r.edit) ? '' : '<span class="tag">✎</span>'}`;
    b.onclick = () => select(r);
    chips.append(b);
  }
  chips.hidden = !list.length;

  const r = state.selected;
  $('fields').hidden = !r;
  $('pickHint').hidden = !!r || !list.length;
  if (r) {
    const n = labelOf(r);
    const badge = $('selBadge');
    badge.textContent = n;
    badge.style.setProperty('--c', colorOf(n));
    $('selOut').innerHTML = 'פלט: <span dir="ltr"></span>';
    const o = rotatedSize(r.w, r.h, r.edit.rot);
    $('selOut').lastChild.textContent = `${o.w}×${o.h} px`;
    const mm = 25.4 / state.source.dpi;
    for (const inp of $('fields').querySelectorAll('input')) {
      if (inp === document.activeElement) continue;
      const v = r[inp.dataset.k];
      inp.value = inp.dataset.u === 'px' ? v : (v * mm).toFixed(1);
    }
    for (const inp of $('adjust').querySelectorAll('input[type=range]')) {
      inp.value = r.edit[inp.dataset.adj];
      inp.nextElementSibling.textContent = signed(r.edit[inp.dataset.adj]) + (inp.dataset.adj === 'angle' ? '°' : '');
    }
    if ($('adjust').open) drawThumb();
  }
  const total = [...state.rects.values()].reduce((a, l) => a + l.length, 0);
  $('btnCrop').disabled = !total;
  $('btnCrop').textContent = total ? `חתוך (${total}) ←` : 'חתוך ←';
}

const signed = (v) => (v > 0 ? '+' : '') + v;

// Live preview of the selected crop with its rotation and adjustments,
// drawn from the display copy with the same pixel math used on export.
// Draws crop `r` as it will be saved (rotation, straightening, adjustments) into `c`,
// from a display copy of its page; fits within maxW×maxH.
function paintCrop(c, view, r, maxW, maxH) {
  const o = rotatedSize(r.w, r.h, r.edit.rot);
  const k = Math.min(maxW / o.w, maxH / o.h);
  c.width = Math.max(1, Math.round(o.w * k));
  c.height = Math.max(1, Math.round(o.h * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  drawCrop(ctx, view.canvas, r, r.edit, view.w, view.h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (r.edit.bright || r.edit.contrast || r.edit.vivid) {
    const id = ctx.getImageData(0, 0, c.width, c.height);
    adjustPixels(id.data, r.edit);
    ctx.putImageData(id, 0, 0);
  }
}

function drawThumb() {
  const r = state.selected;
  const src = state.source;
  if (!r || !src) return;
  paintCrop($('thumb'), { canvas: src.preview, w: src.width, h: src.height }, r, 320, 240);
}

function editSelected(change) {
  const r = state.selected;
  if (!r) return;
  change(r.edit);
  renderPanel();
}

function select(r) {
  state.selected = r;
  render();
}

// ---------- crop rectangles ----------

function addRect() {
  const src = state.source;
  if (!src) return;
  const { s, tx, ty } = state.view;
  // Visible part of the image, in source pixels.
  const vx0 = clamp(-tx / s, 0, src.width);
  const vy0 = clamp(-ty / s, 0, src.height);
  const vx1 = clamp((stage.clientWidth - tx) / s, 0, src.width);
  const vy1 = clamp((stage.clientHeight - ty) / s, 0, src.height);
  const w = Math.max(MIN_SIDE, Math.round((vx1 - vx0) * 0.4));
  const h = Math.max(MIN_SIDE, Math.round((vy1 - vy0) * 0.3));
  const step = (pageRects().length % 5) * 0.05;
  const r = {
    id: nextId++,
    x: Math.round(clamp(vx0 + (vx1 - vx0) * (0.3 + step) - w / 2, 0, src.width - w)),
    y: Math.round(clamp(vy0 + (vy1 - vy0) * (0.2 + step), 0, src.height - h)),
    w, h,
    edit: { ...NO_EDIT },
  };
  pageRects().push(r);
  select(r);
}

// ---------- review: the cropped photos, rotatable, before saving ----------

function allCrops() {
  return [...state.rects.keys()].sort((a, b) => a - b)
    .flatMap((p) => state.rects.get(p).map((r) => ({ p, r })));
}

function showReview() {
  if (!hasCrops()) return;
  history.pushState({ review: true }, '');
  openReview();
}

function openReview() {
  showDetectBar(null);
  $('editor').hidden = true;
  $('review').hidden = false;
  renderReview();
}

function closeReview() {
  $('review').hidden = true;
  $('editor').hidden = false;
  render();
}

function renderReview() {
  const grid = $('reviewGrid');
  grid.innerHTML = '';
  const crops = allCrops();
  for (const { p, r } of crops) {
    const n = labelOf(r);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--c', colorOf(n));
    card.innerHTML = `
      <div class="card-img"><canvas></canvas><b class="num"></b>
        <button class="card-del" aria-label="הסר את תמונה ${n}">✕</button></div>
      <div class="card-row" dir="ltr">
        <button class="secondary icon" data-rot="-90" aria-label="סובב את תמונה ${n} שמאלה">↺</button>
        <span class="dims"></span>
        <button class="secondary icon" data-rot="90" aria-label="סובב את תמונה ${n} ימינה">↻</button>
      </div>`;
    card.querySelector('.num').textContent = n;
    const paint = () => {
      const view = state.pageViews.get(p);
      if (view) paintCrop(card.querySelector('canvas'), view, r, 480, 480);
      const o = rotatedSize(r.w, r.h, r.edit.rot);
      card.querySelector('.dims').textContent = `${o.w}×${o.h}`;
    };
    for (const b of card.querySelectorAll('[data-rot]')) {
      b.onclick = () => {
        r.edit.rot = (r.edit.rot + Number(b.dataset.rot) + 360) % 360;
        paint();
      };
    }
    card.querySelector('.card-del').onclick = () => {
      removeCrop(p, r);
      if (hasCrops()) renderReview(); else history.back();
    };
    grid.append(card);
    paint();
  }
  $('btnSave').textContent = `שמור הכל (${crops.length})`;
}

// Removes a crop, with an undo in the toast.
function removeCrop(page, r) {
  const list = pageRects(page);
  const i = list.indexOf(r);
  if (i < 0) return;
  list.splice(i, 1);
  if (state.selected === r) state.selected = page === state.page ? list[Math.min(i, list.length - 1)] || null : null;
  toast('החיתוך נמחק', 5000, {
    label: 'בטל',
    run: () => {
      const l = pageRects(page);
      l.splice(Math.min(i, l.length), 0, r);
      if (!$('review').hidden) renderReview();
      else if (page === state.page) { state.selected = r; render(); }
    },
  });
}

function deleteSelected() {
  if (!state.selected) return;
  removeCrop(state.page, state.selected);
  render();
}

function constrain(r) {
  const { width: W, height: H } = state.source;
  r.w = clamp(Math.round(r.w), MIN_SIDE, W);
  r.h = clamp(Math.round(r.h), MIN_SIDE, H);
  if (r.edit.angle) {
    // A tilted frame may poke past the scan edge; only keep its center on the scan.
    r.x = clamp(Math.round(r.x), -Math.floor(r.w / 2), W - Math.ceil(r.w / 2));
    r.y = clamp(Math.round(r.y), -Math.floor(r.h / 2), H - Math.ceil(r.h / 2));
  } else {
    r.x = clamp(Math.round(r.x), 0, W - r.w);
    r.y = clamp(Math.round(r.y), 0, H - r.h);
  }
}

function onFieldInput(e) {
  const inp = e.target;
  const r = state.selected;
  if (!r || inp.value === '') return;
  let v = Number(inp.value);
  if (!Number.isFinite(v)) return;
  if (inp.dataset.u === 'mm') v = v / 25.4 * state.source.dpi;
  const { width: W, height: H } = state.source;
  const k = inp.dataset.k;
  if (k === 'x') r.x = clamp(Math.round(v), 0, W - MIN_SIDE);
  if (k === 'y') r.y = clamp(Math.round(v), 0, H - MIN_SIDE);
  if (k === 'w') r.w = clamp(Math.round(v), MIN_SIDE, W - r.x);
  if (k === 'h') r.h = clamp(Math.round(v), MIN_SIDE, H - r.y);
  constrain(r);
  render();
}

// ---------- gestures ----------

const pointers = new Map();
let gesture = null;

function local(e) {
  const b = stage.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

function startPan() {
  const [p] = pointers.values();
  gesture = { type: 'pan', start: { ...p }, t0: { tx: state.view.tx, ty: state.view.ty }, moved: false };
}

function startPinch() {
  const [a, b] = pointers.values();
  const v = state.view;
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  gesture = {
    type: 'pinch',
    d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    s0: v.s,
    // Image point under the fingers' midpoint stays under it.
    ix: (c.x - v.tx) / v.s,
    iy: (c.y - v.ty) / v.s,
  };
}

stage.addEventListener('pointerdown', (e) => {
  if (!state.source || e.target.closest('#detectBar')) return;
  if (e.target.closest('[data-del]') && pointers.size === 0) {
    deleteSelected();
    return;
  }
  stage.setPointerCapture(e.pointerId);
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) { startPinch(); render(); return; }
  if (pointers.size > 2) return;

  const handle = e.target.closest('[data-h]');
  const box = e.target.closest('.crop');
  const r = box && pageRects().find((x) => x.id === Number(box.dataset.id));
  if (r && handle && r === state.selected && handle.dataset.h === 'rot') {
    gesture = { type: 'angle', r };
  } else if (r && handle && r === state.selected) {
    gesture = { type: 'resize', r, h: handle.dataset.h, start: p, r0: { ...r } };
  } else if (r) {
    state.selected = r;
    gesture = { type: 'move', r, start: p, r0: { ...r } };
    render();
  } else {
    startPan();
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  const p = local(e);
  pointers.set(e.pointerId, p);
  const v = state.view;
  const { width: W, height: H } = state.source;

  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = pointers.values();
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    v.fitted = false;
    v.s = clamp(gesture.s0 * d / gesture.d0, v.fit * 0.5, Math.max(8, v.fit * 2));
    v.tx = c.x - gesture.ix * v.s;
    v.ty = c.y - gesture.iy * v.s;
  } else if (gesture.type === 'pan') {
    const dx = p.x - gesture.start.x;
    const dy = p.y - gesture.start.y;
    if (Math.hypot(dx, dy) > 6) { gesture.moved = true; v.fitted = false; }
    v.tx = gesture.t0.tx + dx;
    v.ty = gesture.t0.ty + dy;
  } else if (gesture.type === 'angle') {
    const r = gesture.r;
    const cx = (r.x + r.w / 2) * v.s + v.tx;
    const cy = (r.y + r.h / 2) * v.s + v.ty;
    let a = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
    if (a > 180) a -= 360;
    a = Math.round(clamp(a, -MAX_ANGLE, MAX_ANGLE) * 10) / 10;
    r.edit.angle = Math.abs(a) < 0.3 ? 0 : a; // snap back to straight
    constrain(r);
  } else {
    const dx = (p.x - gesture.start.x) / v.s;
    const dy = (p.y - gesture.start.y) / v.s;
    const { r, r0 } = gesture;
    const t = (r.edit.angle || 0) * Math.PI / 180;
    if (gesture.type === 'move') {
      r.x = r0.x + dx;
      r.y = r0.y + dy;
      constrain(r);
    } else if (!t) {
      const h = gesture.h;
      let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
      if (h.includes('w')) x0 = clamp(Math.round(r0.x + dx), 0, x1 - MIN_SIDE);
      if (h.includes('e')) x1 = clamp(Math.round(x1 + dx), x0 + MIN_SIDE, W);
      if (h.includes('n')) y0 = clamp(Math.round(r0.y + dy), 0, y1 - MIN_SIDE);
      if (h.includes('s')) y1 = clamp(Math.round(y1 + dy), y0 + MIN_SIDE, H);
      Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    } else {
      // Resize in the tilted frame's own axes, keeping the opposite edge in place.
      const cos = Math.cos(t), sin = Math.sin(t);
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      let L = -r0.w / 2, R = r0.w / 2, T = -r0.h / 2, B = r0.h / 2;
      const h = gesture.h;
      if (h.includes('w')) L = Math.min(L + lx, R - MIN_SIDE);
      if (h.includes('e')) R = Math.max(R + lx, L + MIN_SIDE);
      if (h.includes('n')) T = Math.min(T + ly, B - MIN_SIDE);
      if (h.includes('s')) B = Math.max(B + ly, T + MIN_SIDE);
      const mx = (L + R) / 2, my = (T + B) / 2;
      const cx = r0.x + r0.w / 2 + mx * cos - my * sin;
      const cy = r0.y + r0.h / 2 + mx * sin + my * cos;
      r.w = Math.round(R - L);
      r.h = Math.round(B - T);
      r.x = cx - r.w / 2;
      r.y = cy - r.h / 2;
      constrain(r);
    }
  }
  render();
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size === 1) { startPan(); gesture.moved = true; return; }
  if (pointers.size === 0) {
    if (gesture?.type === 'pan' && !gesture.moved && e.type === 'pointerup' && state.selected) {
      state.selected = null; // tap on empty area
      render();
    }
    gesture = null;
  }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('wheel', (e) => {
  if (!state.source) return;
  e.preventDefault();
  const p = local(e);
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  render();
}, { passive: false });

stage.addEventListener('dblclick', () => { fit(); render(); });

let lastSize = null;
new ResizeObserver(() => {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (!state.source || !W || !H) return;
  const v = state.view;
  if (v.fitted) {
    fit();
  } else if (lastSize) {
    // Keep the image point at the stage center where it was.
    v.tx += (W - lastSize.W) / 2;
    v.ty += (H - lastSize.H) / 2;
    v.fit = Math.min(W / state.source.width, H / state.source.height) * 0.94;
  }
  lastSize = { W, H };
  render();
}).observe(stage);

// ---------- saving ----------

async function saveAll() {
  const format = document.querySelector('input[name=fmt]:checked').value;
  const pages = [...state.rects.keys()].filter((p) => state.rects.get(p).length).sort((a, b) => a - b);
  const total = pages.reduce((a, p) => a + state.rects.get(p).length, 0);
  if (!total) return;
  const files = [];
  try {
    let no = 1;
    for (const p of pages) {
      const rects = state.rects.get(p).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, edit: { ...r.edit } }));
      let src = state.source;
      const temp = state.pdf && p !== state.page;
      if (temp) {
        busy(`טוען עמוד ${p}…`);
        src = await pdfPageSource(state.pdf, p);
      }
      try {
        files.push(...await exportCrops(src, rects, format, no,
          (n) => busy(`שומר ${n} מתוך ${total}…`)));
      } finally {
        if (temp) src.release();
      }
      no += rects.length;
    }
  } catch (e) {
    fail(e);
    return;
  } finally {
    busy(null);
  }
  state.files = files;
  showDetectBar(null);
  showResults();
}

function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}

function showResults() {
  const ul = $('resultList');
  ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'file';
    b.innerHTML = `<b dir="ltr"></b><span dir="ltr"></span><span class="dl">הורד</span>`;
    b.children[0].textContent = f.name;
    b.children[1].textContent = `${f.w}×${f.h} px · ${fmtSize(f.blob.size)}`;
    b.onclick = () => download(f.blob, f.name);
    li.append(b);
    ul.append(li);
  }
  $('btnShare').hidden = !canShareFiles(state.files);
  $('results').showModal();
}

function canShareFiles(files) {
  try {
    return !!navigator.canShare?.({ files: files.map(toFile) });
  } catch {
    return false;
  }
}

const toFile = (f) => new File([f.blob], f.name, { type: f.blob.type });

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadEach() {
  // Spaced out so Chrome treats them as separate downloads (it asks once to allow multiple files).
  for (const f of state.files) {
    download(f.blob, f.name);
    await wait(450);
  }
  toast('הקבצים נשמרו בתיקיית ההורדות.');
}

async function downloadZip() {
  busy('יוצר ZIP…');
  try {
    download(await zipFiles(state.files), 'scrop.zip');
  } catch (e) {
    fail(e);
  } finally {
    busy(null);
  }
}

async function shareFiles() {
  try {
    await navigator.share({ files: state.files.map(toFile), title: 'Scrop' });
  } catch (e) {
    if (e?.name !== 'AbortError') toast('השיתוף נכשל. אפשר לשמור כ-ZIP או להוריד כל קובץ בנפרד.');
  }
}

// ---------- settings sheet (swipe down to hide, up to show) ----------

const panel = $('panel');

function setCollapsed(on) {
  if (panel.classList.contains('collapsed') === on) return;
  panel.classList.toggle('collapsed', on);
  $('grip').setAttribute('aria-expanded', String(!on));
}

$('grip').addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));

let swipe = null;
panel.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { swipe = null; return; }
  const t = e.touches[0];
  // Swipe-down only from the top of the panel's scroll, so normal scrolling still works.
  swipe = { x: t.clientX, y: t.clientY, top: panel.scrollTop <= 0, slider: !!e.target.closest('input[type=range]') };
}, { passive: true });
panel.addEventListener('touchend', (e) => {
  if (!swipe || swipe.slider) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (Math.abs(dy) < 40 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
  if (dy > 0 && swipe.top) setCollapsed(true);
  else if (dy < 0) setCollapsed(false);
  swipe = null;
});

// ---------- wiring ----------

$('fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('btnAdd').addEventListener('click', addRect);
$('btnDetect').addEventListener('click', () => {
  if (pageRects().length && !confirm('להחליף את החיתוכים בעמוד הזה בזיהוי אוטומטי?')) return;
  runDetect();
});
$('detectSave').addEventListener('click', () => showReview());
$('btnCrop').addEventListener('click', () => showReview());
$('btnBack').addEventListener('click', () => history.back());
$('detectClose').addEventListener('click', () => showDetectBar(null));
$('btnDelete').addEventListener('click', deleteSelected);
$('rotL').addEventListener('click', () => editSelected((e) => { e.rot = (e.rot + 270) % 360; }));
$('rotR').addEventListener('click', () => editSelected((e) => { e.rot = (e.rot + 90) % 360; }));
$('adjust').addEventListener('toggle', () => $('adjust').open && drawThumb());
for (const inp of $('adjust').querySelectorAll('input[type=range]')) {
  inp.addEventListener('input', () => editSelected((e) => { e[inp.dataset.adj] = Number(inp.value); }));
  if (inp.dataset.adj === 'angle') inp.addEventListener('input', () => { constrain(state.selected); render(); });
}
$('btnResetAdj').addEventListener('click', () => {
  editSelected((e) => Object.assign(e, NO_EDIT));
  constrain(state.selected);
  render();
});
$('btnAllAdj').addEventListener('click', () => {
  const src = state.selected?.edit;
  if (!src) return;
  // Each photo keeps its own straightening angle.
  for (const list of state.rects.values()) for (const r of list) r.edit = { ...src, angle: r.edit.angle };
  render();
  toast('ההגדרות הוחלו על כל החיתוכים.');
});
$('btnSave').addEventListener('click', saveAll);
$('btnZip').addEventListener('click', downloadZip);
$('btnShare').addEventListener('click', shareFiles);
$('btnEach').addEventListener('click', downloadEach);
$('btnClose').addEventListener('click', () => $('results').close());
$('pageSelect').addEventListener('change', (e) => showPage(Number(e.target.value)).catch(fail));
for (const inp of $('fields').querySelectorAll('input')) {
  inp.addEventListener('input', onFieldInput);
  inp.addEventListener('blur', renderPanel);
}

let leaving = false;
$('btnNew').addEventListener('click', () => {
  if (hasCrops() && !confirm('לפתוח קובץ חדש? החיתוכים הנוכחיים יימחקו.')) return;
  leaving = true;
  history.go($('review').hidden ? -1 : -2);
});

// Screens follow history: home ← editor ← review, so Android's back button walks back.
window.addEventListener('popstate', () => {
  const st = history.state || {};
  if (st.review) {
    if (hasCrops()) openReview(); else history.back();
    return;
  }
  if (!$('review').hidden) closeReview();
  if (st.editor || $('editor').hidden) return;
  if (!leaving && hasCrops() && !confirm('לצאת? החיתוכים הנוכחיים יימחקו.')) {
    history.pushState({ editor: true }, '');
    return;
  }
  leaving = false;
  showHome();
});

// Files shared into the app (Android share sheet) are parked by the service worker.
async function takeSharedFile() {
  if (!new URLSearchParams(location.search).has('share')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('scrop-share');
    const res = await cache.match('shared-file');
    if (!res) return;
    await cache.delete('shared-file');
    const name = decodeURIComponent(res.headers.get('x-name') || 'shared');
    const blob = await res.blob();
    await loadFile(new File([blob], name, { type: res.headers.get('content-type') || blob.type }));
  } catch (e) {
    fail(e);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
takeSharedFile();

