/* Web to PDF browser extension: background worker.
 *
 * Captures the tab you're looking at as a PDF that matches the screen,
 * using Chrome's own PDF engine through the debugger API (Chrome shows a
 * short "started debugging this browser" bar while it works). The steps
 * are the same as the Web to PDF server app:
 *
 *   1. use the screen styles, not the print styles,
 *   2. scroll through the page so lazy content loads,
 *   3. pin window-height sections and fixed bars at their on-screen size,
 *   4. save one tall page exactly as wide as the window.
 *
 * Afterwards the page is put back exactly as it was (styles and scroll).
 */
'use strict';

importScripts('editor/vendor/pdf-lib.min.js');

const PRESETS = {
  current: null, // the window as it is now
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  // Narrow windows: sites built for phones and tablets switch to that layout.
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
};
const DEFAULTS = { device: 'current', mode: 'vector', delay: 0 };
const MAX_HEIGHT_PX = 60000;   // stop scrolling "infinite" pages here
const PDF_MAX_POINTS = 14400;  // 200 inches: the largest page Adobe Reader opens
const SLICE_PX = 4000;         // screenshot slices for picture mode
const busyTabs = new Set();
const PROTECTED = "This page can't be captured. Browser pages (settings, new tab, extension store) are protected.";

// ---------- Entry points ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save', title: 'Save page as PDF (exact)', contexts: ['page', 'frame', 'selection', 'link', 'image'] });
  chrome.contextMenus.create({ id: 'edit', title: 'Save page as PDF and open in PDF Editor', contexts: ['page', 'frame', 'selection', 'link', 'image'] });
});

chrome.contextMenus.onClicked.addListener(async (item, tab) => {
  const saved = await chrome.storage.local.get(DEFAULTS);
  run(tab, { ...saved, after: item.menuItemId === 'edit' ? 'editor' : 'download' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'capture') {
    chrome.tabs.get(msg.tabId)
      .then((tab) => run(tab, msg.options || {}))
      .then((r) => reply({ ok: true, ...r }), (err) => reply({ ok: false, error: err.message }));
    return true; // answer later
  }
});

// ---------- One capture ----------
async function run(tab, options) {
  const opts = { ...DEFAULTS, ...options };
  if (busyTabs.has(tab.id)) throw new Error('This tab is already being captured.');
  // tab.url is only known when the extension may see it; Chrome itself refuses
  // protected pages when attaching below, so this is just an early answer.
  if (tab.url && !/^(https?|file):/.test(tab.url)) {
    await showResult(tab.id, false, PROTECTED);
    throw new Error(PROTECTED);
  }
  busyTabs.add(tab.id);
  await setBadge(tab.id, '…', '#2563eb');
  const target = { tabId: tab.id };
  try {
    await chrome.debugger.attach(target, '1.3').catch((e) => {
      if (/attached/i.test(e.message)) throw new Error('Close the developer tools (F12) on this tab and try again.');
      if (/chrome:\/\/|chrome-extension|Cannot access|webstore|edge:\/\//i.test(e.message)) throw new Error(PROTECTED);
      throw new Error('Could not access this page: ' + e.message);
    });
    let pdf, title;
    try {
      ({ pdf, title } = await capture(target, opts));
    } finally {
      await chrome.debugger.detach(target).catch(() => {});
    }
    const fileName = fileNameFor(title);
    if (opts.after === 'editor') await openInEditor(pdf, fileName);
    else await download(pdf, fileName);
    await showResult(tab.id, true, `Saved ${fileName}`);
    return { fileName, bytes: pdf.length };
  } catch (err) {
    await showResult(tab.id, false, err.message);
    throw err;
  } finally {
    busyTabs.delete(tab.id);
  }
}

async function showResult(tabId, ok, message) {
  await chrome.storage.session.set({ last: { ok, message, tabId, at: Date.now() } }).catch(() => {});
  await setBadge(tabId, ok ? '✓' : '!', ok ? '#16a34a' : '#dc2626');
  setTimeout(() => setBadge(tabId, '', '#000'), ok ? 4000 : 15000);
}

async function setBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch { /* tab closed */ }
}

// ---------- Talking to the page ----------
const cdp = (target, method, params = {}) => chrome.debugger.sendCommand(target, method, params);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a function inside the page and return its (JSON) result.
async function inPage(target, fn, ...args) {
  const res = await cdp(target, 'Runtime.evaluate', {
    expression: `(${fn})(...${JSON.stringify(args)})`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error('The page refused the capture script: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

async function capture(target, opts) {
  const info = await inPage(target, () => ({
    width: document.documentElement.clientWidth || innerWidth, height: innerHeight,
    x: scrollX, y: scrollY, title: document.title || location.hostname,
    protocol: location.protocol,
  }));
  if (!/^(https?|file):$/.test(info.protocol)) throw new Error(PROTECTED);
  const preset = PRESETS[opts.device] || null;
  const width = preset ? preset.width : info.width;
  const height = preset ? preset.height : info.height;
  const setSize = (h) => cdp(target, 'Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 0, mobile: false });

  await setSize(height);
  await cdp(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
  try {
    if (preset) await sleep(500); // let the page re-layout at the new width
    await inPage(target, loadEverything, height, MAX_HEIGHT_PX);
    if (opts.delay > 0) await sleep(Math.min(30000, opts.delay));

    // Pin what is sized from the window height (found by changing it
    // briefly) and fixed bars, so the long page keeps the on-screen look.
    await inPage(target, freezeRecord);
    await setSize(height + 333);
    await sleep(300);
    await inPage(target, freezeCompare);
    await setSize(height);
    await sleep(300);
    await inPage(target, freezeApply);
    const pdf = opts.mode === 'image' ? await imagePdf(target, width) : await vectorPdf(target, width);
    return { pdf, title: info.title };
  } finally {
    await inPage(target, restorePage).catch(() => {});
    await cdp(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    await cdp(target, 'Emulation.setEmulatedMedia', { media: '' }).catch(() => {});
    // Scroll back last, once the page has its normal size again.
    await sleep(100);
    await inPage(target, (x, y) => window.scrollTo(x, y), info.x, info.y).catch(() => {});
  }
}

const fitScale = (heightPx) => Math.min(1, PDF_MAX_POINTS / (heightPx * 0.75));

async function vectorPdf(target, width) {
  const fullHeight = Math.min(await inPage(target, pageHeight), MAX_HEIGHT_PX);
  const scale = Math.max(0.1, fitScale(fullHeight));
  const { stream } = await cdp(target, 'Page.printToPDF', {
    paperWidth: (Math.floor(width * scale)) / 96,
    paperHeight: (Math.ceil(fullHeight * scale) + 2) / 96,
    scale,
    printBackground: true,
    preferCSSPageSize: false,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    pageRanges: '1',
    transferMode: 'ReturnAsStream',
  });
  return readStream(target, stream);
}

async function readStream(target, handle) {
  const parts = [];
  let total = 0;
  for (;;) {
    const { data, base64Encoded, eof } = await cdp(target, 'IO.read', { handle, size: 4 << 20 });
    const bytes = base64Encoded ? base64ToBytes(data) : new TextEncoder().encode(data);
    parts.push(bytes);
    total += bytes.length;
    if (eof) break;
  }
  await cdp(target, 'IO.close', { handle }).catch(() => {});
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Picture mode: a full-page screenshot (in slices) placed on one PDF page.
async function imagePdf(target, width) {
  const fullHeight = Math.min(await inPage(target, pageHeight), MAX_HEIGHT_PX);
  const scale = fitScale(fullHeight) * 0.75; // PDF points per CSS pixel
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([width * scale, fullHeight * scale]);
  for (let y = 0; y < fullHeight; y += SLICE_PX) {
    const h = Math.min(SLICE_PX, fullHeight - y);
    const { data } = await cdp(target, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 90, captureBeyondViewport: true, fromSurface: true,
      clip: { x: 0, y, width, height: h, scale: 2 },
    });
    const img = await doc.embedJpg(data);
    page.drawImage(img, { x: 0, y: (fullHeight - y - h) * scale, width: width * scale, height: h * scale });
  }
  return doc.save();
}

// ---------- Functions that run inside the page ----------
// (They are sent as text, so they can't use anything from this file.)

async function loadEverything(viewportHeight, maxHeight) {
  document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => { el.loading = 'eager'; });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let y = 0;
  for (let i = 0; i < 200; i++) {
    const total = document.documentElement.scrollHeight;
    if (y >= total || y >= maxHeight) break;
    y += Math.round(viewportHeight * 0.8);
    window.scrollTo(0, y);
    await wait(150);
  }
  await wait(800);
  window.scrollTo(0, 0);
  await wait(400);
  await Promise.race([
    Promise.all([
      document.fonts ? document.fonts.ready : null,
      ...[...document.images].filter((img) => !img.complete).map((img) => new Promise((r) => { img.addEventListener('load', r); img.addEventListener('error', r); })),
    ]),
    wait(10000),
  ]);
}

function freezeRecord() {
  window.__w2p = { els: [...document.querySelectorAll('body *')] };
  window.__w2p.before = window.__w2p.els.map((el) => el.getBoundingClientRect().height);
}

function freezeCompare() {
  const s = window.__w2p;
  s.changed = s.els.map((el, i) => Math.abs(el.getBoundingClientRect().height - s.before[i]) > 1);
}

function freezeApply() {
  const s = window.__w2p;
  const saved = new Map(); // element -> original style attribute, to put back afterwards
  const pin = (el, props) => {
    if (!saved.has(el)) saved.set(el, el.getAttribute('style'));
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
  };
  // Sections sized from the window height: keep their on-screen height.
  s.els.forEach((el, i) => {
    if (!s.changed[i] || !el.isConnected) return;
    const h = el.getBoundingClientRect().height + 'px';
    pin(el, { 'box-sizing': 'border-box', height: h, 'min-height': h, 'max-height': h });
  });
  // Fixed bars and banners: keep them where they are on the first screen.
  for (const el of s.els) {
    if (!el.isConnected || getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    pin(el, {
      position: 'absolute', 'box-sizing': 'border-box', width: r.width + 'px', height: r.height + 'px',
      right: 'auto', bottom: 'auto', top: r.top + 'px', left: r.left + 'px', margin: '0',
    });
    const n = el.getBoundingClientRect();
    pin(el, { top: (2 * r.top - n.top) + 'px', left: (2 * r.left - n.left) + 'px' });
  }
  // Keep backgrounds, and clip anything sticking out sideways like the screen does.
  const style = document.createElement('style');
  style.textContent = '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}html,body{overflow-x:clip!important}';
  document.head.appendChild(style);
  window.__w2p = { saved, style };
}

function pageHeight() {
  return Math.ceil(Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
    document.documentElement.getBoundingClientRect().height,
  ));
}

function restorePage() {
  const s = window.__w2p;
  if (s && s.saved) {
    for (const [el, orig] of s.saved) {
      // Chrome writes style changes back to the attribute lazily; reading it
      // first stops a pending write from leaving an empty style="" behind.
      el.getAttribute('style');
      if (orig == null) el.removeAttribute('style'); else el.setAttribute('style', orig);
    }
    s.style.remove();
  }
  delete window.__w2p;
}

// ---------- Delivering the PDF ----------
function fileNameFor(title) {
  const clean = String(title).replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, ' - ').replace(/\s+/g, ' ').replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 80);
  return (clean || 'page') + '.pdf';
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function download(pdf, fileName) {
  // Service workers can't make blob: links, so hand the file over as a data: link.
  await chrome.downloads.download({ url: 'data:application/pdf;base64,' + bytesToBase64(pdf), filename: fileName, saveAs: false });
}

// The editor page reads the PDF from this extension's own storage.
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('web-to-pdf', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pdfs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function openInEditor(pdf, fileName) {
  const key = crypto.randomUUID();
  const db = await idb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('pdfs', 'readwrite');
    tx.objectStore('pdfs').put({ pdf: new Blob([pdf], { type: 'application/pdf' }), created: Date.now() }, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  await chrome.tabs.create({ url: `editor/index.html?capture=${key}&name=${encodeURIComponent(fileName)}` });
}
