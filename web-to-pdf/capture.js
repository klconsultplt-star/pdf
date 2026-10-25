/* Capture a web page as a PDF that looks the way it does on screen.
 *
 * Printing a page normally (Ctrl+P / "Save as PDF") re-lays it out for paper:
 * print styles kick in, the width shrinks and the content is cut into A4
 * sheets, which drops and misaligns things. Instead this:
 *
 *   1. loads the page in Chromium at a real screen width,
 *   2. keeps the screen styles,
 *   3. scrolls through it so lazy-loaded images and sections load,
 *   4. pins anything sized to the window height (e.g. 100vh banners) and
 *      fixed bars to where they are on screen,
 *   5. saves it as ONE tall page exactly as wide as the screen, so nothing
 *      is split or reflowed.
 *
 * "vector" mode keeps text selectable and links clickable. "image" mode is a
 * fallback: a full-page screenshot placed in a PDF, pixel-identical to the
 * screen but with no selectable text.
 *
 * Command line:
 *   node capture.js <url> [out.pdf] [--width 1440] [--mode vector|image] [--delay 2000]
 */
'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');

const DEVICES = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 768, height: 1024, isMobile: true, hasTouch: true },
  mobile: {
    width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const MAX_HEIGHT_PX = 60000;     // stop scrolling "infinite" pages here
const PDF_MAX_POINTS = 14400;    // 200 inches: the largest page Adobe Reader opens
const PX_TO_PT = 0.75;           // CSS px are 1/96 inch, PDF points 1/72 inch
const SLICE_PX = 4000;           // screenshot in slices to stay under GPU size limits

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch().catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) (await browserPromise).close();
  browserPromise = null;
}

// ---------- Blocking the private network ----------
// When the tool is reachable by other people, they must not be able to make
// it fetch addresses inside your network (router pages, cloud metadata, …).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const dnsCache = new Map();
async function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateIp(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!dnsCache.has(host)) {
    dnsCache.set(host, dns.lookup(host, { all: true })
      .then((addrs) => addrs.some((a) => isPrivateIp(a.address)))
      .catch(() => false));
    setTimeout(() => dnsCache.delete(host), 60000).unref();
  }
  return dnsCache.get(host);
}

function checkUrl(raw) {
  let url;
  raw = String(raw).trim();
  // "example.com" -> https://example.com; "localhost:8080" -> http://localhost:8080.
  // A scheme is a word followed by ":" that isn't a port number.
  if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(raw);
    raw = (local ? 'http://' : 'https://') + raw;
  }
  try { url = new URL(raw); } catch {
    throw new UserError('That does not look like a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UserError('Only http:// and https:// addresses can be captured.');
  return url;
}

class UserError extends Error {}

// ---------- Capture ----------
async function capture(rawUrl, options = {}) {
  const {
    device = 'desktop', width: customWidth, mode = 'vector', delay = 0,
    allowPrivate = true, onProgress = () => {}, timeout = 45000,
  } = options;
  const url = checkUrl(rawUrl);
  if (!allowPrivate && await isPrivateHost(url.hostname)) {
    throw new UserError('Addresses on the local or private network are blocked on this server.');
  }

  const preset = { ...(DEVICES[device] || DEVICES.desktop) };
  if (customWidth) preset.width = Math.max(320, Math.min(3840, Math.round(customWidth)));
  const { width, height, ...rest } = preset;

  const browser = await getBrowser();
  const context = await browser.newContext({
    ...rest,
    viewport: { width, height },
    deviceScaleFactor: mode === 'image' ? Math.max(2, rest.deviceScaleFactor || 1) : (rest.deviceScaleFactor || 1),
    colorScheme: 'light',
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === '1',
  });
  try {
    if (!allowPrivate) {
      await context.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (/^https?:$/.test(u.protocol) && await isPrivateHost(u.hostname)) return route.abort('blockedbyclient');
        return route.continue();
      });
    }
    const page = await context.newPage();
    await page.emulateMedia({ media: 'screen' });

    onProgress('Loading the page…');
    const response = await page.goto(url.href, { waitUntil: 'load', timeout });
    if (response && response.status() >= 400) {
      throw new UserError(`The site answered with an error (HTTP ${response.status()}).`);
    }
    await settle(page, 8000);

    onProgress('Scrolling through the page to load everything…');
    await loadEverything(page, height);

    if (delay > 0) {
      onProgress('Waiting for animations to finish…');
      await page.waitForTimeout(Math.min(delay, 30000));
    }

    const title = (await page.title().catch(() => '')) || url.hostname;
    onProgress('Creating the PDF…');
    const pdf = mode === 'image'
      ? await imagePdf(page, width)
      : await vectorPdf(page, width, height);
    return { pdf, title, finalUrl: page.url() };
  } finally {
    await context.close().catch(() => {});
  }
}

// Wait until the network has been quiet for a moment (or give up after `ms`).
async function settle(page, ms) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

async function loadEverything(page, viewportHeight) {
  // Ask lazy images to load right away.
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
    document.querySelectorAll('iframe[loading="lazy"]').forEach((f) => { f.loading = 'eager'; });
  });
  // Scroll down a screen at a time; many sites only load content as it comes into view.
  let y = 0;
  for (let i = 0; i < 200; i++) {
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    if (y >= total || y >= MAX_HEIGHT_PX) break;
    y += Math.round(viewportHeight * 0.8);
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(150);
  }
  await settle(page, 5000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  // Wait for web fonts and images (up to 10 s).
  await page.evaluate(() => Promise.race([
    Promise.all([
      document.fonts ? document.fonts.ready : null,
      ...[...document.images].filter((img) => !img.complete).map((img) => new Promise((r) => { img.onload = img.onerror = r; })),
    ]),
    new Promise((r) => setTimeout(r, 10000)),
  ]));
}

// Freeze things that would change when the page becomes one tall sheet.
async function freezeLayout(page, width, height) {
  // Elements sized from the window height (100vh banners, full-screen sections)
  // would stretch to the full page height. Find them by changing the window
  // height and seeing what changes size, then pin them at their screen size.
  await page.evaluate(() => {
    window.__w2pEls = [...document.querySelectorAll('body *')];
    window.__w2pBefore = window.__w2pEls.map((el) => el.getBoundingClientRect().height);
  });
  await page.setViewportSize({ width, height: height + 333 });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__w2pChanged = window.__w2pEls.map((el, i) => Math.abs(el.getBoundingClientRect().height - window.__w2pBefore[i]) > 1);
  });
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const els = window.__w2pEls;
    els.forEach((el, i) => {
      if (!window.__w2pChanged[i] || !el.isConnected) return;
      const h = el.getBoundingClientRect().height + 'px';
      el.style.setProperty('box-sizing', 'border-box', 'important'); // the measured height includes padding and border
      el.style.setProperty('height', h, 'important');
      el.style.setProperty('min-height', h, 'important');
      el.style.setProperty('max-height', h, 'important');
    });
    // Fixed bars and banners: keep them where they are on the first screen,
    // instead of letting them jump to the top or bottom of the long page.
    for (const el of els) {
      if (!el.isConnected || getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('width', r.width + 'px', 'important');
      el.style.setProperty('height', r.height + 'px', 'important');
      el.style.setProperty('right', 'auto', 'important');
      el.style.setProperty('bottom', 'auto', 'important');
      el.style.setProperty('top', r.top + 'px', 'important');
      el.style.setProperty('left', r.left + 'px', 'important');
      el.style.setProperty('margin', '0', 'important');
      // Its new containing block may be offset; correct by the difference.
      const n = el.getBoundingClientRect();
      el.style.setProperty('top', (2 * r.top - n.top) + 'px', 'important');
      el.style.setProperty('left', (2 * r.left - n.left) + 'px', 'important');
    }
    // Keep background colors and images when "printing".
    const style = document.createElement('style');
    // Also clip anything sticking out sideways, as the screen does: otherwise
    // Chrome shrinks the whole page to fit it and everything moves.
    style.textContent = '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
      'html,body{overflow-x:clip!important}';
    document.head.appendChild(style);
    delete window.__w2pEls; delete window.__w2pBefore; delete window.__w2pChanged;
  });
}

async function pageHeight(page) {
  return page.evaluate(() => Math.ceil(Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
    document.documentElement.getBoundingClientRect().height,
  )));
}

// Scale down very long pages so the PDF page stays within 200 inches.
function fitScale(heightPx) {
  return Math.min(1, PDF_MAX_POINTS / (heightPx * PX_TO_PT));
}

async function vectorPdf(page, width, height) {
  await freezeLayout(page, width, height);
  const fullHeight = Math.min(await pageHeight(page), MAX_HEIGHT_PX);
  const scale = Math.max(0.1, fitScale(fullHeight));
  return page.pdf({
    width: Math.floor(width * scale) + 'px',
    height: Math.ceil(fullHeight * scale) + 2 + 'px',
    scale,
    printBackground: true,
    preferCSSPageSize: false,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    pageRanges: '1',
  });
}

// Full-page screenshot placed on one PDF page of the same size. The
// screenshot is taken in slices (very tall images break in some renderers)
// and stacked with pdf-lib, which copies the JPEG data in unchanged.
async function imagePdf(page, width) {
  const fullHeight = Math.min(await pageHeight(page), MAX_HEIGHT_PX);
  const scale = fitScale(fullHeight) * PX_TO_PT; // PDF points per CSS pixel
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([width * scale, fullHeight * scale]);
  for (let y = 0; y < fullHeight; y += SLICE_PX) {
    const h = Math.min(SLICE_PX, fullHeight - y);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true, clip: { x: 0, y, width, height: h } });
    const img = await doc.embedJpg(jpg);
    pdfPage.drawImage(img, { x: 0, y: (fullHeight - y - h) * scale, width: width * scale, height: h * scale });
  }
  return Buffer.from(await doc.save());
}

module.exports = { capture, closeBrowser, UserError, DEVICES };

// ---------- Command line ----------
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf('--' + name);
    if (i < 0) return def;
    const [v] = args.splice(i, 2).slice(1);
    return v;
  };
  const mode = opt('mode', 'vector');
  const device = opt('device', 'desktop');
  const width = opt('width');
  const delay = Number(opt('delay', 0));
  const [url, out = 'page.pdf'] = args;
  if (!url) {
    console.log('Usage: node capture.js <url> [out.pdf] [--device desktop|laptop|tablet|mobile] [--width px] [--mode vector|image] [--delay ms]');
    process.exit(1);
  }
  capture(url, { mode, device, width: width && Number(width), delay, onProgress: (m) => console.log(m) })
    .then(({ pdf }) => { require('node:fs').writeFileSync(out, pdf); console.log('Saved ' + out); })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(closeBrowser);
}
