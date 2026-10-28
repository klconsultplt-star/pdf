/* Signatures: draw, type or upload one, keep it for next time, and hand it
 * to the editor as a PNG (transparent background, trimmed to the ink).
 *
 *   const png = await PdfSignature.choose();   // data: URL, or null if cancelled
 */
(() => {
  'use strict';

  const STORE_KEY = 'pdfEditor.signatures';
  const MAX_SAVED = 8;
  const INKS = { black: '#111111', blue: '#1a3d9c' };
  const SCRIPT_FONTS = [
    { label: 'Script', css: '"Segoe Script", "Snell Roundhand", "Brush Script MT", cursive' },
    { label: 'Handwriting', css: '"Lucida Handwriting", "Bradley Hand", "Apple Chancery", cursive' },
    { label: 'Formal', css: '"Brush Script MT", "Edwardian Script ITC", "Zapfino", "Segoe Script", cursive' },
  ];

  // ---------- Saved signatures (this browser only) ----------
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
  }
  function storeSaved(list) {
    // Drop the oldest if the browser runs out of room.
    for (let l = list.slice(0, MAX_SAVED); l.length; l = l.slice(0, -1)) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(l)); return true; } catch {}
    }
    try { localStorage.removeItem(STORE_KEY); } catch {}
    return false;
  }

  // ---------- Canvas helpers ----------
  // Crop to the visible ink plus a little margin.
  function trim(canvas, pad = 6) {
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null; // nothing drawn
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // Make paper white transparent so only the ink shows on the page.
  function removeWhite(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const keep = Math.max(0, Math.min(1, (235 - lum) / 75)); // fully clear above 235, fully kept below 160
      d[i + 3] = Math.round(d[i + 3] * keep);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ---------- The dialog ----------
  let dialog;
  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'sign-dialog';
    dialog.innerHTML = `
      <form method="dialog">
        <h2>Add a signature</h2>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-tab="saved">Saved</button>
          <button type="button" role="tab" data-tab="draw">Draw</button>
          <button type="button" role="tab" data-tab="type">Type</button>
          <button type="button" role="tab" data-tab="upload">Upload</button>
        </div>
        <section data-panel="saved">
          <p class="muted">Click a signature to use it.</p>
          <div class="saved-list"></div>
        </section>
        <section data-panel="draw">
          <canvas class="pad" width="1120" height="360" aria-label="Draw your signature here"></canvas>
          <div class="row"><span class="muted">Sign with your mouse, finger or pen.</span><button type="button" class="link" data-act="clear">Clear</button></div>
        </section>
        <section data-panel="type">
          <input type="text" class="typed" maxlength="60" placeholder="Type your name" aria-label="Your name">
          <div class="styles"></div>
        </section>
        <section data-panel="upload">
          <input type="file" class="upload" accept="image/png,image/jpeg" aria-label="Signature image">
          <label class="check"><input type="checkbox" class="nowhite" checked> Remove white background</label>
          <canvas class="upload-preview" hidden></canvas>
        </section>
        <div class="row ink-row">
          <span class="muted">Ink</span>
          <label class="check"><input type="radio" name="ink" value="black" checked> Black</label>
          <label class="check"><input type="radio" name="ink" value="blue"> Blue</label>
        </div>
        <label class="check save-row"><input type="checkbox" class="remember" checked> Save this signature for next time</label>
        <p class="error" aria-live="polite"></p>
        <div class="dialog-buttons">
          <button type="button" data-act="cancel">Cancel</button>
          <button type="button" class="primary" data-act="use">Place signature</button>
        </div>
      </form>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  function choose() {
    if (!dialog) build();
    const $ = (sel) => dialog.querySelector(sel);
    const saved = loadSaved();
    let tab = saved.length ? 'saved' : 'draw';
    let styleIndex = 0;
    let upload = null; // canvas of the uploaded picture
    const pad = $('.pad');
    const padCtx = pad.getContext('2d');
    padCtx.clearRect(0, 0, pad.width, pad.height);
    let drawn = false;
    $('.typed').value = '';
    $('.upload').value = '';
    $('.upload-preview').hidden = true;
    $('.error').textContent = '';
    const ink = () => INKS[dialog.querySelector('input[name=ink]:checked').value];

    return new Promise((resolve) => {
      const cleanup = [];
      const on = (el, ev, fn) => { el.addEventListener(ev, fn); cleanup.push(() => el.removeEventListener(ev, fn)); };
      const finish = (result) => {
        cleanup.forEach((f) => f());
        dialog.close();
        resolve(result);
      };

      // Tabs
      const showTab = (name) => {
        tab = name;
        dialog.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
        dialog.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
        $('[data-tab=saved]').hidden = !saved.length;
        const making = name !== 'saved';
        $('.ink-row').hidden = !(name === 'draw' || name === 'type');
        $('.save-row').hidden = !making;
        $('[data-act=use]').hidden = !making;
        $('.error').textContent = '';
        if (name === 'type') { renderStyles(); setTimeout(() => $('.typed').focus(), 0); }
      };
      dialog.querySelectorAll('[data-tab]').forEach((b) => on(b, 'click', () => showTab(b.dataset.tab)));

      // Saved list
      const renderSaved = () => {
        const list = $('.saved-list');
        list.innerHTML = '';
        saved.forEach((s, i) => {
          const item = document.createElement('div');
          item.className = 'saved-item';
          item.innerHTML = `<button type="button" class="use" title="Use this signature"><img alt="Saved signature ${i + 1}"></button>
            <button type="button" class="del" title="Delete this saved signature" aria-label="Delete">✕</button>`;
          item.querySelector('img').src = s.url;
          item.querySelector('.use').addEventListener('click', () => finish(s.url));
          item.querySelector('.del').addEventListener('click', () => {
            saved.splice(i, 1);
            storeSaved(saved);
            if (!saved.length) showTab('draw'); else renderSaved();
          });
          list.appendChild(item);
        });
      };
      renderSaved();

      // Drawing pad (smooth strokes through the midpoints)
      let pts = null;
      const pos = (e) => {
        const r = pad.getBoundingClientRect();
        return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height];
      };
      on(pad, 'pointerdown', (e) => {
        pad.setPointerCapture(e.pointerId);
        pts = [pos(e)];
        padCtx.fillStyle = ink();
        padCtx.beginPath();
        padCtx.arc(pts[0][0], pts[0][1], 2.6, 0, Math.PI * 2);
        padCtx.fill();
        drawn = true;
        e.preventDefault();
      });
      on(pad, 'pointermove', (e) => {
        if (!pts) return;
        const p = pos(e);
        pts.push(p);
        if (pts.length < 3) return;
        const [a, b, c] = pts.slice(-3);
        padCtx.strokeStyle = ink();
        padCtx.lineWidth = 5.2;
        padCtx.lineCap = 'round';
        padCtx.lineJoin = 'round';
        padCtx.beginPath();
        padCtx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        padCtx.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
        padCtx.stroke();
      });
      const endStroke = () => { pts = null; };
      on(pad, 'pointerup', endStroke);
      on(pad, 'pointercancel', endStroke);
      on($('[data-act=clear]'), 'click', () => { padCtx.clearRect(0, 0, pad.width, pad.height); drawn = false; });

      // Typed name in a handwriting font
      const renderTyped = (fontCss, text, color) => {
        const c = document.createElement('canvas');
        c.width = 1600; c.height = 320;
        const x = c.getContext('2d');
        x.font = `120px ${fontCss}`;
        x.fillStyle = color;
        x.textBaseline = 'middle';
        x.fillText(text, 20, 160, 1560);
        return c;
      };
      const renderStyles = () => {
        const box = $('.styles');
        box.innerHTML = '';
        const text = $('.typed').value.trim() || 'Your Name';
        SCRIPT_FONTS.forEach((f, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'style' + (i === styleIndex ? ' selected' : '');
          b.setAttribute('aria-pressed', i === styleIndex);
          b.title = f.label;
          b.style.fontFamily = f.css;
          b.style.color = ink();
          b.textContent = text;
          b.addEventListener('click', () => { styleIndex = i; renderStyles(); });
          box.appendChild(b);
        });
      };
      on($('.typed'), 'input', renderStyles);
      dialog.querySelectorAll('input[name=ink]').forEach((r) => on(r, 'change', () => { if (tab === 'type') renderStyles(); }));

      // Uploaded picture
      const showUpload = async () => {
        const file = $('.upload').files[0];
        if (!file) return;
        const img = new Image();
        img.src = URL.createObjectURL(file);
        try { await img.decode(); } catch { $('.error').textContent = 'That file is not a picture this browser can read.'; return; }
        const scale = Math.min(1, 1200 / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        if ($('.nowhite').checked) removeWhite(c);
        upload = c;
        const prev = $('.upload-preview');
        prev.width = c.width; prev.height = c.height;
        prev.getContext('2d').drawImage(c, 0, 0);
        prev.hidden = false;
      };
      on($('.upload'), 'change', showUpload);
      on($('.nowhite'), 'change', showUpload);

      // Buttons
      on($('[data-act=cancel]'), 'click', () => finish(null));
      on(dialog, 'cancel', (e) => { e.preventDefault(); finish(null); }); // Esc key
      on($('[data-act=use]'), 'click', () => {
        let canvas = null;
        if (tab === 'draw') {
          if (!drawn) { $('.error').textContent = 'Draw your signature in the box first.'; return; }
          canvas = trim(pad);
        } else if (tab === 'type') {
          const text = $('.typed').value.trim();
          if (!text) { $('.error').textContent = 'Type your name first.'; return; }
          canvas = trim(renderTyped(SCRIPT_FONTS[styleIndex].css, text, ink()));
        } else if (tab === 'upload') {
          if (!upload) { $('.error').textContent = 'Choose a picture of your signature first.'; return; }
          canvas = trim(upload);
        }
        if (!canvas) { $('.error').textContent = 'The signature is empty.'; return; }
        const url = canvas.toDataURL('image/png');
        if ($('.remember').checked && !saved.some((s) => s.url === url)) {
          saved.unshift({ url, created: Date.now() });
          storeSaved(saved);
        }
        finish(url);
      });

      showTab(tab);
      dialog.showModal();
    });
  }

  window.PdfSignature = { choose };
})();
