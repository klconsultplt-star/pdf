/* PDF Editor — runs entirely in the browser.
 *
 * pdf.js draws the original pages; pdf-lib builds the edited file on download.
 * Every edit (text, drawings, boxes, images) is kept as an "annotation" in PDF
 * coordinates (points, origin bottom-left), so what you see on screen and
 * what gets written to the file use the same numbers.
 */
(() => {
  'use strict';

  const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const THUMB_WIDTH = 130;
  const LINE_HEIGHT = 1.2;
  const HANDLE_PX = 9;
  const BLANK_SIZE = [0, 0, 612, 792]; // US Letter
  const CSS_FONTS = {
    Helvetica: 'Helvetica, Arial, sans-serif',
    TimesRoman: '"Times New Roman", Times, serif',
    Courier: '"Courier New", Courier, monospace',
    HelveticaBold: 'Helvetica, Arial, sans-serif',
  };
  const WATERMARK = { text: 'DRAFT', size: 150, opacity: 0.1, angle: 45, font: 'HelveticaBold', color: '#000000' };

  // ---------- State ----------
  const sources = [];        // { bytes, pdfjs, lib, pageCache: Map }
  const images = new Map();  // id -> { bytes, kind: 'png'|'jpg', el }
  let pages = [];            // { id, src, srcPage, rotation, view, annots: [] }
  let fileName = 'document.pdf';
  let zoom = 1;
  let tool = 'select';
  let selection = null;      // { pageId, index }
  let currentPageId = null;
  let undoStack = [];
  let redoStack = [];
  let dirty = false;
  let nextId = 1;
  let measureFonts = null;   // pdf-lib fonts used to measure text widths

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer');
  const sidebar = $('sidebar');
  const emptyState = $('emptyState');
  const colorInput = $('colorInput');
  const fontInput = $('fontInput');
  const sizeInput = $('sizeInput');
  const widthInput = $('widthInput');

  // ---------- Small helpers ----------
  const uid = () => 'p' + (nextId++);
  const rad = (deg) => (deg * Math.PI) / 180;
  const rotateVec = (x, y, deg) => {
    const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
    return [x * c - y * s, x * s + y * c];
  };
  const toLocal = (a, px, py) => rotateVec(px - a.x, py - a.y, -(a.rot || 0));
  const fromLocal = (a, lx, ly) => {
    const [dx, dy] = rotateVec(lx, ly, a.rot || 0);
    return [a.x + dx, a.y + dy];
  };
  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  };
  const pageById = (id) => pages.find((p) => p.id === id);
  const pageEl = (id) => viewer.querySelector(`.page[data-id="${id}"]`);

  let statusTimer;
  function status(msg, ms = 2500) {
    const el = $('status');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // Maps PDF points to screen pixels for a page at a given scale and rotation
  // (same math as pdf.js, which doesn't export its viewport class).
  function viewportFor(page, scale) {
    const [x1, y1, x2, y2] = page.view;
    const rot = ((page.rotation % 360) + 360) % 360;
    const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rot];
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const sideways = rot % 180 !== 0;
    const width = (sideways ? y2 - y1 : x2 - x1) * scale;
    const height = (sideways ? x2 - x1 : y2 - y1) * scale;
    const offX = (sideways ? cy - y1 : cx - x1) * scale;
    const offY = (sideways ? cx - x1 : cy - y1) * scale;
    const t = [a * scale, b * scale, c * scale, d * scale,
      offX - a * scale * cx - c * scale * cy, offY - b * scale * cx - d * scale * cy];
    const det = t[0] * t[3] - t[1] * t[2];
    return {
      width, height, scale, rotation: rot, transform: t,
      convertToViewportPoint: (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
      convertToPdfPoint: (x, y) => {
        const dx = x - t[4], dy = y - t[5];
        return [(t[3] * dx - t[2] * dy) / det, (t[0] * dy - t[1] * dx) / det];
      },
    };
  }

  // ---------- Text measuring ----------
  async function loadMeasureFonts() {
    const doc = await PDFDocument.create();
    measureFonts = {
      Helvetica: await doc.embedFont(StandardFonts.Helvetica),
      TimesRoman: await doc.embedFont(StandardFonts.TimesRoman),
      Courier: await doc.embedFont(StandardFonts.Courier),
      HelveticaBold: await doc.embedFont(StandardFonts.HelveticaBold),
    };
  }

  // The built-in PDF fonts only cover Western characters; swap out the rest.
  function cleanText(text, font) {
    let out = '';
    for (const ch of text.replace(/\t/g, '    ')) {
      if (ch === '\n') { out += ch; continue; }
      try { font.encodeText(ch); out += ch; } catch { out += '?'; }
    }
    return out;
  }

  // Recompute a text annotation's box from its text and size (keeps top-left fixed).
  function layoutText(a, keepTop = true) {
    const font = measureFonts[a.font];
    a.text = cleanText(a.text, font);
    const lines = a.text.split('\n');
    const w = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, a.size)), a.size * 0.5);
    const h = lines.length * a.size * LINE_HEIGHT;
    if (keepTop && a.h != null) {
      const [tx, ty] = fromLocal(a, 0, a.h);
      const [dx, dy] = rotateVec(0, -h, a.rot);
      a.x = tx + dx; a.y = ty + dy;
    }
    a.w = w; a.h = h;
  }

  // Baseline (local y) of line i inside a text box.
  const baselineY = (a, i) => a.h - i * a.size * LINE_HEIGHT - a.size * 0.95;

  // ---------- Undo / redo ----------
  const snapshot = () => JSON.stringify({ pages, nextId });

  function checkpoint() {
    undoStack.push(snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    dirty = true;
    updateButtons();
  }

  function restore(json) {
    const s = JSON.parse(json);
    pages = s.pages;
    nextId = Math.max(nextId, s.nextId);
    selection = null;
    renderAll();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    updateButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    updateButtons();
  }

  function updateButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
    $('saveBtn').disabled = !pages.length;
    $('watermarkBtn').disabled = !pages.length;
    $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  }

  // ---------- Loading files ----------
  async function loadSource(bytes) {
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    task.onPassword = (updatePassword, reason) => {
      const pw = window.prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF is password protected. Password:');
      if (pw == null) task.destroy(); else updatePassword(pw);
    };
    const pdfjs = await task.promise;
    const src = { bytes, pdfjs, lib: null, pageCache: new Map() };
    sources.push(src);
    const index = sources.length - 1;
    const out = [];
    for (let n = 0; n < pdfjs.numPages; n++) {
      const p = await getPdfjsPage(src, n);
      out.push({ id: uid(), src: index, srcPage: n, rotation: p.rotate % 360, view: p.view.slice(), annots: [] });
    }
    return out;
  }

  function getPdfjsPage(src, n) {
    if (!src.pageCache.has(n)) src.pageCache.set(n, src.pdfjs.getPage(n + 1));
    return src.pageCache.get(n);
  }

  async function readFile(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  async function openFile(file) {
    if (!file) return;
    if (dirty && pages.length && !confirm('Open a new file? Unsaved changes will be lost.')) return;
    status('Opening ' + file.name + '…', 10000);
    try {
      const bytes = await readFile(file);
      sources.length = 0;
      images.clear();
      const newPages = await loadSource(bytes);
      pages = newPages;
      fileName = file.name;
      undoStack = []; redoStack = []; dirty = false; selection = null;
      zoom = fitZoom();
      renderAll();
      status(`Opened ${file.name} (${pages.length} page${pages.length === 1 ? '' : 's'})`);
    } catch (err) {
      console.error(err);
      status('Could not open this file: ' + (err.message || err), 5000);
    }
  }

  async function mergeFiles(files) {
    if (!files.length) return;
    try {
      const added = [];
      for (const f of files) added.push(...(await loadSource(await readFile(f))));
      checkpoint();
      pages.push(...added);
      if (!fileName || !sources.length) fileName = files[0].name;
      renderAll();
      status(`Added ${added.length} page${added.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      status('Could not add this file: ' + (err.message || err), 5000);
    }
  }

  function newBlankDocument() {
    sources.length = 0;
    images.clear();
    pages = [{ id: uid(), src: null, srcPage: 0, rotation: 0, view: BLANK_SIZE.slice(), annots: [] }];
    fileName = 'document.pdf';
    undoStack = []; redoStack = []; dirty = false; selection = null;
    zoom = fitZoom();
    renderAll();
  }

  function fitZoom() {
    if (!pages.length) return 1;
    const v = pages[0].view;
    const w = pages[0].rotation % 180 ? v[3] - v[1] : v[2] - v[0];
    const avail = viewer.clientWidth - 48;
    return Math.max(0.25, Math.min(1.5, Math.floor((avail / w) * 20) / 20));
  }

  // ---------- Rendering ----------
  const renderObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderBase(e.target);
  }, { root: viewer, rootMargin: '600px 0px' });

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderThumb(e.target);
  }, { root: sidebar, rootMargin: '400px 0px' });

  function renderAll() {
    closeTextEditor(true);
    renderObserver.disconnect();
    thumbObserver.disconnect();
    viewer.querySelectorAll('.page').forEach((el) => el.remove());
    sidebar.innerHTML = '';
    emptyState.hidden = pages.length > 0;
    if (!pages.some((p) => p.id === currentPageId)) currentPageId = pages[0] && pages[0].id;

    pages.forEach((page, i) => {
      const vp = viewportFor(page, zoom);
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.id = page.id;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      const base = document.createElement('canvas');
      base.className = 'base';
      const overlay = document.createElement('canvas');
      overlay.className = 'overlay';
      overlay.width = Math.round(vp.width * DPR);
      overlay.height = Math.round(vp.height * DPR);
      el.append(base, overlay);
      attachPointer(overlay, page.id);
      viewer.appendChild(el);
      renderObserver.observe(el);
      drawOverlay(page.id);

      sidebar.appendChild(makeThumb(page, i));
    });
    viewer.dataset.tool = tool;
    updateButtons();
  }

  async function renderBase(el) {
    const page = pageById(el.dataset.id);
    if (!page) return;
    const key = zoom + ':' + page.rotation;
    if (el.dataset.rendered === key) return;
    el.dataset.rendered = key;
    const canvas = el.querySelector('canvas.base');
    await paintPage(page, canvas, zoom * DPR);
  }

  // Draw the original page content (or blank white) onto a canvas.
  async function paintPage(page, canvas, scale) {
    const vp = viewportFor(page, scale);
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (page.src == null) return vp;
    if (canvas._task) canvas._task.cancel();
    try {
      const p = await getPdfjsPage(sources[page.src], page.srcPage);
      const viewport = p.getViewport({ scale, rotation: page.rotation });
      const task = (canvas._task = p.render({ canvasContext: ctx, viewport }));
      await task.promise;
      if (canvas._task === task) canvas._task = null;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return null;
      console.error(err);
    }
    return vp;
  }

  function drawOverlay(pageId) {
    const page = pageById(pageId);
    const el = pageEl(pageId);
    if (!page || !el) return;
    const canvas = el.querySelector('canvas.overlay');
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const vp = viewportFor(page, zoom * DPR);
    ctx.setTransform(...vp.transform);
    page.annots.forEach((a, i) => {
      if (editing && editing.pageId === pageId && editing.index === i) return;
      drawAnnot(ctx, a);
    });
    if (drag && drag.pageId === pageId && drag.preview) drawAnnot(ctx, drag.preview);
    if (selection && selection.pageId === pageId) {
      const a = page.annots[selection.index];
      if (a) drawSelection(ctx, a);
    }
  }

  // ctx must already map PDF points to canvas pixels.
  function drawAnnot(ctx, a) {
    ctx.save();
    if (a.type === 'pen') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.01, a.points[0][1]);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.translate(a.x, a.y);
    ctx.rotate(rad(a.rot || 0));
    switch (a.type) {
      case 'text': {
        if (a.opacity != null) ctx.globalAlpha = a.opacity;
        ctx.fillStyle = a.color;
        ctx.font = `${a.font === 'HelveticaBold' ? 'bold ' : ''}${a.size}px ${CSS_FONTS[a.font]}`;
        ctx.textBaseline = 'alphabetic';
        a.text.split('\n').forEach((line, i) => {
          ctx.save();
          ctx.translate(0, baselineY(a, i));
          ctx.scale(1, -1);
          ctx.fillText(line, 0, 0);
          ctx.restore();
        });
        break;
      }
      case 'image': {
        const img = images.get(a.imageId);
        if (img && img.el.complete) {
          ctx.scale(1, -1);
          ctx.drawImage(img.el, 0, -a.h, a.w, a.h);
        } else if (img) {
          img.el.addEventListener('load', () => redrawAll(), { once: true });
        }
        break;
      }
      case 'highlight':
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = a.color;
        ctx.fillRect(0, 0, a.w, a.h);
        break;
      case 'whiteout':
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, a.w, a.h);
        break;
      case 'rect':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.lineWidth;
        ctx.strokeRect(0, 0, a.w, a.h);
        break;
    }
    ctx.restore();
  }

  function drawSelection(ctx, a) {
    const px = 1 / (zoom * DPR); // one screen pixel in PDF units
    ctx.save();
    ctx.lineWidth = 1.5 * DPR * px;
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([4 * DPR * px, 3 * DPR * px]);
    const b = bounds(a);
    ctx.translate(b.x, b.y);
    ctx.rotate(rad(b.rot));
    const pad = 3 * DPR * px;
    ctx.strokeRect(-pad, -pad, b.w + 2 * pad, b.h + 2 * pad);
    if (a.type !== 'pen') {
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      const hs = HANDLE_PX * DPR * px;
      ctx.fillRect(b.w - hs / 2, -hs / 2, hs, hs);
      ctx.strokeRect(b.w - hs / 2, -hs / 2, hs, hs);
    }
    ctx.restore();
  }

  // A rotated box describing an annotation (pen strokes use their bounding box).
  function bounds(a) {
    if (a.type !== 'pen') return { x: a.x, y: a.y, w: a.w, h: a.h, rot: a.rot || 0 };
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const r = a.lineWidth / 2;
    const x = Math.min(...xs) - r, y = Math.min(...ys) - r;
    return { x, y, w: Math.max(...xs) + r - x, h: Math.max(...ys) + r - y, rot: 0 };
  }

  function redrawAll() {
    pages.forEach((p) => drawOverlay(p.id));
  }

  // ---------- Thumbnails & page operations ----------
  function makeThumb(page, i) {
    const t = document.createElement('div');
    t.className = 'thumb' + (page.id === currentPageId ? ' current' : '');
    t.dataset.id = page.id;
    t.draggable = true;
    t.innerHTML = `<canvas></canvas><div class="num">${i + 1}</div>
      <div class="actions">
        <button data-act="rotl" title="Rotate left">⟲</button>
        <button data-act="rotr" title="Rotate right">⟳</button>
        <button data-act="blank" title="Insert blank page after">＋</button>
        <button data-act="del" title="Delete page">✕</button>
      </div>`;
    const v = viewportFor(page, 1);
    const c = t.querySelector('canvas');
    c.style.width = THUMB_WIDTH + 'px';
    c.style.height = (THUMB_WIDTH * v.height) / v.width + 'px';
    t.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act) return pageAction(act, page.id);
      currentPageId = page.id;
      sidebar.querySelectorAll('.thumb').forEach((x) => x.classList.toggle('current', x.dataset.id === page.id));
      pageEl(page.id).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    t.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-page', page.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    t.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/x-page')) return;
      e.preventDefault();
      t.classList.add('drag-over');
    });
    t.addEventListener('dragleave', () => t.classList.remove('drag-over'));
    t.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('text/x-page');
      t.classList.remove('drag-over');
      if (!from || from === page.id) return;
      e.preventDefault();
      e.stopPropagation();
      movePage(from, page.id);
    });
    thumbObserver.observe(t);
    return t;
  }

  async function renderThumb(t) {
    const page = pageById(t.dataset.id);
    if (!page) return;
    const c = t.querySelector('canvas');
    const scale = (THUMB_WIDTH * DPR) / viewportFor(page, 1).width;
    const vp = await paintPage(page, c, scale);
    if (!vp) return;
    const ctx = c.getContext('2d');
    ctx.setTransform(...vp.transform);
    page.annots.forEach((a) => drawAnnot(ctx, a));
  }

  let thumbTimer;
  function refreshThumb(pageId) {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      const t = sidebar.querySelector(`.thumb[data-id="${pageId}"]`);
      if (t) renderThumb(t);
    }, 300);
  }

  function pageAction(act, id) {
    const i = pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (act === 'del') {
      if (pages.length === 1) return status('A PDF needs at least one page');
      checkpoint();
      pages.splice(i, 1);
    } else if (act === 'rotl' || act === 'rotr') {
      checkpoint();
      pages[i].rotation = (pages[i].rotation + (act === 'rotr' ? 90 : 270)) % 360;
    } else if (act === 'blank') {
      checkpoint();
      const v = pages[i].view;
      const size = [0, 0, v[2] - v[0], v[3] - v[1]];
      pages.splice(i + 1, 0, { id: uid(), src: null, srcPage: 0, rotation: pages[i].rotation, view: size, annots: [] });
    }
    selection = null;
    renderAll();
  }

  function movePage(fromId, toId) {
    const from = pages.findIndex((p) => p.id === fromId);
    const to = pages.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0) return;
    checkpoint();
    const [p] = pages.splice(from, 1);
    pages.splice(to, 0, p);
    renderAll();
  }

  // ---------- Pointer interaction ----------
  let drag = null;     // the gesture in progress
  let editing = null;  // the text box being typed into

  function pdfPoint(e, pageId) {
    const page = pageById(pageId);
    const canvas = pageEl(pageId).querySelector('canvas.overlay');
    const r = canvas.getBoundingClientRect();
    const vp = viewportFor(page, zoom);
    return vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
  }

  function hitTest(page, x, y) {
    const tol = 4 / zoom;
    for (let i = page.annots.length - 1; i >= 0; i--) {
      const a = page.annots[i];
      if (a.type === 'pen') {
        const lim = a.lineWidth / 2 + tol;
        for (let k = 0; k < a.points.length; k++) {
          const p = a.points[k], q = a.points[k + 1] || p;
          if (distToSegment(x, y, p, q) <= lim) return i;
        }
      } else {
        const [lx, ly] = toLocal(a, x, y);
        if (lx >= -tol && ly >= -tol && lx <= a.w + tol && ly <= a.h + tol) return i;
      }
    }
    return -1;
  }

  function distToSegment(x, y, [x1, y1], [x2, y2]) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  }

  function onHandle(a, x, y) {
    if (!a || a.type === 'pen') return false;
    const [lx, ly] = toLocal(a, x, y);
    const r = (HANDLE_PX / zoom) * 0.8;
    return Math.abs(lx - a.w) <= r && Math.abs(ly) <= r;
  }

  function select(pageId, index) {
    const old = selection && selection.pageId;
    selection = index >= 0 ? { pageId, index } : null;
    if (old && old !== pageId) drawOverlay(old);
    drawOverlay(pageId);
    if (selection) {
      const a = pageById(pageId).annots[index];
      if (a.color && a.color.startsWith('#')) colorInput.value = a.color;
      if (a.type === 'text') { sizeInput.value = a.size; fontInput.value = a.font; }
      if (a.lineWidth) widthInput.value = a.lineWidth;
    }
  }

  function attachPointer(canvas, pageId) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      currentPageId = pageId;
      if (editing) { closeTextEditor(); return; }

      if (tool === 'select') {
        const sel = selection && selection.pageId === pageId ? page.annots[selection.index] : null;
        if (onHandle(sel, x, y)) {
          drag = { kind: 'resize', pageId, index: selection.index, orig: { ...sel }, saved: false };
        } else {
          const i = hitTest(page, x, y);
          select(pageId, i);
          if (i >= 0) drag = { kind: 'move', pageId, index: i, start: [x, y], orig: JSON.parse(JSON.stringify(page.annots[i])), saved: false };
        }
      } else if (tool === 'text') {
        const i = hitTest(page, x, y);
        if (i >= 0 && page.annots[i].type === 'text') openTextEditor(pageId, i);
        else openTextEditor(pageId, -1, x, y);
        e.preventDefault();
        return;
      } else if (tool === 'pen') {
        drag = { kind: 'pen', pageId, preview: { type: 'pen', points: [[x, y]], color: colorInput.value, lineWidth: +widthInput.value || 2 } };
      } else {
        drag = { kind: 'box', pageId, start: [x, y], preview: null };
      }
      if (drag) canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag || drag.pageId !== pageId) {
        if (tool === 'select') updateHoverCursor(canvas, pageId, e);
        return;
      }
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      if (drag.kind === 'move') {
        const a = page.annots[drag.index];
        const dx = x - drag.start[0], dy = y - drag.start[1];
        if (!drag.saved) { if (Math.hypot(dx, dy) < 2 / zoom) return; checkpoint(); drag.saved = true; }
        if (a.type === 'pen') a.points = drag.orig.points.map(([px, py]) => [px + dx, py + dy]);
        else { a.x = drag.orig.x + dx; a.y = drag.orig.y + dy; }
      } else if (drag.kind === 'resize') {
        if (!drag.saved) { checkpoint(); drag.saved = true; }
        resizeAnnot(page.annots[drag.index], drag.orig, x, y);
      } else if (drag.kind === 'pen') {
        const pts = drag.preview.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) >= 1.5 / zoom) pts.push([x, y]);
      } else if (drag.kind === 'box') {
        drag.preview = boxFromDrag(tool, drag.start, [x, y], page.rotation);
      }
      drawOverlay(pageId);
    });

    const finish = () => {
      if (!drag || drag.pageId !== pageId) return;
      const page = pageById(pageId);
      const d = drag;
      drag = null;
      if (d.kind === 'pen') {
        checkpoint();
        page.annots.push(d.preview);
      } else if (d.kind === 'box' && d.preview && d.preview.w > 2 && d.preview.h > 2) {
        checkpoint();
        page.annots.push(d.preview);
      }
      drawOverlay(pageId);
      if (d.saved || d.kind === 'pen' || d.kind === 'box') refreshThumb(pageId);
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    canvas.addEventListener('dblclick', (e) => {
      if (tool !== 'select') return;
      const page = pageById(pageId);
      const [x, y] = pdfPoint(e, pageId);
      const i = hitTest(page, x, y);
      if (i >= 0 && page.annots[i].type === 'text') openTextEditor(pageId, i);
    });
  }

  function updateHoverCursor(canvas, pageId, e) {
    const page = pageById(pageId);
    const [x, y] = pdfPoint(e, pageId);
    const sel = selection && selection.pageId === pageId ? page.annots[selection.index] : null;
    canvas.style.cursor = onHandle(sel, x, y) ? 'nwse-resize' : hitTest(page, x, y) >= 0 ? 'move' : '';
  }

  // Box drawn by dragging; it is aligned with the page as shown on screen.
  function boxFromDrag(kind, [x0, y0], [x1, y1], rot) {
    const [ax, ay] = rotateVec(x0, y0, -rot);
    const [bx, by] = rotateVec(x1, y1, -rot);
    const [ox, oy] = rotateVec(Math.min(ax, bx), Math.min(ay, by), rot);
    return {
      type: kind, x: ox, y: oy, w: Math.abs(bx - ax), h: Math.abs(by - ay), rot,
      color: colorInput.value, lineWidth: +widthInput.value || 2,
    };
  }

  // Drag the bottom-right handle; the top-left corner stays put.
  function resizeAnnot(a, orig, x, y) {
    const [tx, ty] = fromLocal(orig, 0, orig.h);
    let [w, negH] = rotateVec(x - tx, y - ty, -(orig.rot || 0));
    w = Math.max(w, 4);
    let h = Math.max(-negH, 4);
    if (a.type === 'image') h = (w * orig.h) / orig.w;
    if (a.type === 'text') {
      a.size = Math.max(4, Math.round(((orig.size * w) / orig.w) * 2) / 2);
      a.x = orig.x; a.y = orig.y; a.h = orig.h;
      layoutText(a);
      return;
    }
    const [dx, dy] = rotateVec(0, -h, orig.rot || 0);
    a.x = tx + dx; a.y = ty + dy; a.w = w; a.h = h;
  }

  // ---------- Text editing ----------
  function openTextEditor(pageId, index, x, y) {
    closeTextEditor();
    const page = pageById(pageId);
    const existing = index >= 0 ? page.annots[index] : null;
    const a = existing || {
      type: 'text', text: '', size: +sizeInput.value || 14, font: fontInput.value,
      color: colorInput.value, rot: page.rotation, x, y, w: 0, h: null,
    };
    // Top-left corner of the text box, in PDF points.
    const top = existing ? fromLocal(a, 0, a.h) : [x, y];
    const vp = viewportFor(page, zoom);
    const [sx, sy] = vp.convertToViewportPoint(top[0], top[1]);
    // Where the box's top-left lands on screen depends on page vs. text rotation.
    const screenRot = ((page.rotation - (a.rot || 0)) % 360 + 360) % 360;

    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.value = a.text;
    ta.spellcheck = false;
    ta.style.left = sx + 'px';
    ta.style.top = sy + 'px';
    ta.style.transformOrigin = '0 0';
    ta.style.transform = screenRot ? `rotate(${screenRot}deg)` : '';
    ta.style.fontSize = a.size * zoom + 'px';
    ta.style.fontFamily = CSS_FONTS[a.font];
    ta.style.fontWeight = a.font === 'HelveticaBold' ? 'bold' : 'normal';
    ta.style.color = a.color;
    const fit = () => {
      const lines = ta.value.split('\n');
      ta.rows = Math.max(1, lines.length);
      ta.style.height = lines.length * a.size * zoom * LINE_HEIGHT + 4 + 'px';
      const w = Math.max(...lines.map((l) => measureFonts[a.font].widthOfTextAtSize(cleanText(l, measureFonts[a.font]), a.size)));
      ta.style.width = Math.max(120, w * zoom + 24) + 'px';
    };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(false); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeTextEditor(); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => closeTextEditor());
    pageEl(pageId).appendChild(ta);
    fit();
    editing = { pageId, index, annot: a, top, el: ta };
    if (existing) drawOverlay(pageId);
    ta.focus();
    setTimeout(() => { if (editing && editing.el === ta) ta.focus(); }, 0);
  }

  function closeTextEditor(commit = true) {
    if (!editing) return;
    const ed = editing;
    editing = null;
    ed.el.remove();
    const page = pageById(ed.pageId);
    if (!page) return;
    const text = ed.el.value.replace(/\s+$/, '');
    if (commit) {
      const original = ed.index >= 0 ? page.annots[ed.index].text : '';
      if (text !== original) {
        checkpoint();
        if (!text && ed.index >= 0) {
          page.annots.splice(ed.index, 1);
          selection = null;
        } else if (text) {
          const a = ed.index >= 0 ? page.annots[ed.index] : ed.annot;
          a.text = text;
          if (ed.index < 0) {
            a.h = 0; a.x = ed.top[0]; a.y = ed.top[1]; // h=0 so the top-left stays at the click point
            page.annots.push(a);
          }
          layoutText(a);
          selection = { pageId: ed.pageId, index: ed.index >= 0 ? ed.index : page.annots.length - 1 };
        }
        refreshThumb(ed.pageId);
      }
    }
    drawOverlay(ed.pageId);
  }

  // ---------- Images ----------
  async function addImage(file) {
    if (!file) return;
    if (!pages.length) newBlankDocument();
    const bytes = await readFile(file);
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) return status('Please choose a PNG or JPG image');
    const id = 'img' + nextId++;
    const el = new Image();
    el.src = URL.createObjectURL(new Blob([bytes], { type: isPng ? 'image/png' : 'image/jpeg' }));
    await el.decode();
    images.set(id, { bytes, kind: isPng ? 'png' : 'jpg', el });

    const page = pageById(currentPageId) || pages[0];
    const v = page.view;
    const pw = v[2] - v[0], ph = v[3] - v[1];
    const scale = Math.min(1, (pw * 0.5) / el.naturalWidth, (ph * 0.5) / el.naturalHeight);
    const w = el.naturalWidth * scale, h = el.naturalHeight * scale;
    // Center it on the page, upright as the page is displayed.
    const cx = v[0] + pw / 2, cy = v[1] + ph / 2;
    const [ox, oy] = rotateVec(-w / 2, -h / 2, page.rotation);
    checkpoint();
    page.annots.push({ type: 'image', imageId: id, x: cx + ox, y: cy + oy, w, h, rot: page.rotation });
    setTool('select');
    select(page.id, page.annots.length - 1);
    refreshThumb(page.id);
  }

  // ---------- Property changes apply to the selected item ----------
  function applyProp(fn) {
    if (!selection) return;
    const a = pageById(selection.pageId).annots[selection.index];
    if (!a) return;
    checkpoint();
    fn(a);
    drawOverlay(selection.pageId);
    refreshThumb(selection.pageId);
  }

  colorInput.addEventListener('change', () => applyProp((a) => { if (a.color) a.color = colorInput.value; }));
  sizeInput.addEventListener('change', () => applyProp((a) => { if (a.type === 'text') { a.size = Math.max(4, +sizeInput.value || 14); layoutText(a); } }));
  fontInput.addEventListener('change', () => applyProp((a) => { if (a.type === 'text') { a.font = fontInput.value; layoutText(a); } }));
  widthInput.addEventListener('change', () => applyProp((a) => { if ('lineWidth' in a) a.lineWidth = Math.max(0.5, +widthInput.value || 2); }));

  // One click: put a faint diagonal "DRAFT" across the middle of every page.
  // Clicking again when every page already has one removes them.
  function toggleWatermark() {
    if (!pages.length) return;
    closeTextEditor();
    const has = (p) => p.annots.some((a) => a.watermark);
    checkpoint();
    selection = null;
    if (pages.every(has)) {
      pages.forEach((p) => { p.annots = p.annots.filter((a) => !a.watermark); });
      renderAll();
      return status('Watermark removed');
    }
    for (const page of pages) {
      if (has(page)) continue;
      const a = {
        type: 'text', watermark: true, text: WATERMARK.text, size: WATERMARK.size, font: WATERMARK.font,
        color: WATERMARK.color, opacity: WATERMARK.opacity, rot: page.rotation + WATERMARK.angle, x: 0, y: 0,
      };
      layoutText(a, false);
      // Center the rotated text box on the page.
      const v = page.view;
      const [dx, dy] = rotateVec(a.w / 2, a.h / 2, a.rot);
      a.x = (v[0] + v[2]) / 2 - dx;
      a.y = (v[1] + v[3]) / 2 - dy;
      page.annots.unshift(a); // underneath other edits, so it doesn't get in the way of selecting them
    }
    renderAll();
    status('Watermark added to every page');
  }

  function deleteSelection() {
    if (!selection) return;
    checkpoint();
    pageById(selection.pageId).annots.splice(selection.index, 1);
    const id = selection.pageId;
    selection = null;
    drawOverlay(id);
    refreshThumb(id);
  }

  function nudgeSelection(dx, dy) {
    applyProp((a) => {
      if (a.type === 'pen') a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
      else { a.x += dx; a.y += dy; }
    });
  }

  // ---------- Saving ----------
  async function buildPdf() {
    closeTextEditor();
    const out = await PDFDocument.create();
    // Copy each source's pages in one go so shared fonts/images are copied once.
    const copied = new Map(); // "src:page" -> PDFPage
    for (let s = 0; s < sources.length; s++) {
      const wanted = [...new Set(pages.filter((p) => p.src === s).map((p) => p.srcPage))];
      if (!wanted.length) continue;
      const src = sources[s];
      if (!src.lib) src.lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
      const result = await out.copyPages(src.lib, wanted);
      wanted.forEach((n, k) => copied.set(s + ':' + n, result[k]));
    }

    const fonts = {};
    const getFont = async (name) => (fonts[name] ||= await out.embedFont(StandardFonts[name]));
    const embedded = {};
    const getImage = async (id) => {
      if (!embedded[id]) {
        const img = images.get(id);
        embedded[id] = img.kind === 'png' ? await out.embedPng(img.bytes) : await out.embedJpg(img.bytes);
      }
      return embedded[id];
    };

    for (const page of pages) {
      let p;
      if (page.src == null) {
        p = out.addPage([page.view[2] - page.view[0], page.view[3] - page.view[1]]);
      } else {
        p = out.addPage(copied.get(page.src + ':' + page.srcPage));
      }
      p.setRotation(degrees(page.rotation));

      for (const a of page.annots) {
        const color = a.color ? rgb(...hexToRgb(a.color)) : undefined;
        const rotate = degrees(a.rot || 0);
        if (a.type === 'text') {
          const font = await getFont(a.font);
          a.text.split('\n').forEach((line, i) => {
            if (!line) return;
            const [x, y] = fromLocal(a, 0, baselineY(a, i));
            p.drawText(line, { x, y, size: a.size, font, color, rotate, opacity: a.opacity ?? 1 });
          });
        } else if (a.type === 'pen') {
          const pts = a.points.length === 1 ? [a.points[0], [a.points[0][0] + 0.01, a.points[0][1]]] : a.points;
          for (let k = 0; k < pts.length - 1; k++) {
            p.drawLine({
              start: { x: pts[k][0], y: pts[k][1] }, end: { x: pts[k + 1][0], y: pts[k + 1][1] },
              thickness: a.lineWidth, color, lineCap: LineCapStyle.Round,
            });
          }
        } else if (a.type === 'image') {
          p.drawImage(await getImage(a.imageId), { x: a.x, y: a.y, width: a.w, height: a.h, rotate });
        } else if (a.type === 'highlight') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, color, opacity: 0.35, blendMode: BlendMode.Multiply });
        } else if (a.type === 'whiteout') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, color: rgb(1, 1, 1) });
        } else if (a.type === 'rect') {
          p.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate, borderColor: color, borderWidth: a.lineWidth });
        }
      }
    }
    return out.save();
  }

  async function save() {
    if (!pages.length) return;
    status('Building PDF…', 30000);
    try {
      const bytes = await buildPdf();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      dirty = false;
      status('Downloaded ' + a.download);
    } catch (err) {
      console.error(err);
      status('Could not save: ' + (err.message || err), 6000);
    }
  }

  // ---------- Tools, zoom, keyboard ----------
  function setTool(name) {
    closeTextEditor();
    tool = name;
    viewer.dataset.tool = name;
    document.querySelectorAll('#tools .tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    if (name !== 'select' && selection) { const id = selection.pageId; selection = null; drawOverlay(id); }
  }

  function setZoom(z) {
    const anchor = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
    zoom = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100));
    renderAll();
    viewer.scrollTop = anchor * viewer.scrollHeight;
  }

  document.querySelectorAll('#tools .tool[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('openInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('openInput2').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
  $('mergeInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!pages.length) openFile(files.shift()).then(() => mergeFiles(files));
    else mergeFiles(files);
  });
  $('imageInput').addEventListener('change', (e) => { addImage(e.target.files[0]); e.target.value = ''; });
  $('newBlankBtn').addEventListener('click', newBlankDocument);
  $('watermarkBtn').addEventListener('click', toggleWatermark);
  $('saveBtn').addEventListener('click', save);
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.25));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.25));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (arrows[e.key] && selection) {
      e.preventDefault();
      // Arrow keys follow the screen, so undo the page rotation.
      const rot = pageById(selection.pageId).rotation;
      nudgeSelection(...rotateVec(...arrows[e.key], rot));
      return;
    }
    const keys = { v: 'select', t: 'text', p: 'pen', h: 'highlight', r: 'rect', w: 'whiteout' };
    if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
    if (e.key === 'Escape' && selection) { const id = selection.pageId; selection = null; drawOverlay(id); }
  });

  // Drop a PDF to open it (or add it to the open document), or an image to insert it.
  viewer.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    viewer.classList.add('dragging');
  });
  viewer.addEventListener('dragleave', (e) => { if (e.target === viewer) viewer.classList.remove('dragging'); });
  viewer.addEventListener('drop', (e) => {
    viewer.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter((f) => /^image\/(png|jpeg)$/.test(f.type));
    if (pdfs.length && !pages.length) openFile(pdfs.shift()).then(() => mergeFiles(pdfs));
    else if (pdfs.length) mergeFiles(pdfs);
    imgs.forEach((f) => addImage(f));
  });

  // Track which page is in view so new images land there.
  viewer.addEventListener('scroll', () => {
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    for (const el of viewer.querySelectorAll('.page')) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) {
        if (currentPageId !== el.dataset.id) {
          currentPageId = el.dataset.id;
          sidebar.querySelectorAll('.thumb').forEach((x) => x.classList.toggle('current', x.dataset.id === currentPageId));
        }
        break;
      }
    }
  }, { passive: true });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  loadMeasureFonts();
  updateButtons();

  // Exposed for automated tests.
  window.pdfEditor = { buildPdf, getState: () => ({ pages, zoom, tool, selection }) };
})();
