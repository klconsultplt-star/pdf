/* Web to PDF: a small web server around capture.js.
 *
 *   npm start            then open http://localhost:3000
 *
 * Settings (environment variables):
 *   PORT=3000            port to listen on
 *   HOST=127.0.0.1       127.0.0.1 = only this computer can use it.
 *                        0.0.0.0   = anyone on the network (see README first).
 *   ALLOW_PRIVATE=1|0    allow capturing local/private addresses (localhost,
 *                        192.168.x.x, …). Default: allowed only when HOST is
 *                        this computer, so a shared server can't be used to
 *                        look inside your network.
 *   MAX_JOBS=2           captures running at the same time
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { capture, closeBrowser, UserError } = require('./capture');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const LOCAL_ONLY = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE ? process.env.ALLOW_PRIVATE === '1' : LOCAL_ONLY;
const MAX_JOBS = Math.max(1, Number(process.env.MAX_JOBS) || 2);
const KEEP_MINUTES = 15;

const PUBLIC_DIR = path.join(__dirname, 'public');
// The PDF editor lives one folder up in this repository; serve it at /editor/.
const EDITOR_DIR = path.resolve(__dirname, '..');
const EDITOR_FILES = new Set(['index.html', 'app.js', 'export.js', 'styles.css',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Finished PDFs are kept in memory for a while so they can be previewed,
// downloaded and opened in the editor.
const results = new Map(); // id -> { pdf, title, created }
setInterval(() => {
  const cutoff = Date.now() - KEEP_MINUTES * 60000;
  for (const [id, r] of results) if (r.created < cutoff) results.delete(id);
}, 60000).unref();

// Run at most MAX_JOBS captures at once; the rest wait their turn.
let running = 0;
const waiting = [];
function limit(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      task().then(resolve, reject).finally(() => {
        running--;
        if (waiting.length) waiting.shift()();
      });
    };
    if (running < MAX_JOBS) run(); else waiting.push(run);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  });
}

function readBody(req, max = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new UserError('Request too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// "My Page: Title?" -> "My Page - Title.pdf"
function fileNameFor(title) {
  const clean = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' - ').replace(/\s+/g, ' ').replace(/^[ .-]+|[ .-]+$/g, '').slice(0, 80);
  return (clean || 'page') + '.pdf';
}

async function handleCapture(req, res) {
  let input;
  try { input = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Bad request.' }); }
  const started = Date.now();
  try {
    const { pdf, title, finalUrl } = await limit(() => capture(String(input.url || ''), {
      device: String(input.device || 'desktop'),
      mode: input.mode === 'image' ? 'image' : 'vector',
      delay: Math.max(0, Math.min(30000, Number(input.delay) || 0)),
      allowPrivate: ALLOW_PRIVATE,
    }));
    const id = crypto.randomBytes(12).toString('hex');
    results.set(id, { pdf, title, created: Date.now() });
    json(res, 200, { id, title, fileName: fileNameFor(title), url: finalUrl, bytes: pdf.length, seconds: (Date.now() - started) / 1000 });
  } catch (err) {
    const message = err instanceof UserError ? err.message : friendlyError(err);
    if (!(err instanceof UserError)) console.error(err);
    json(res, 422, { error: message });
  }
}

function friendlyError(err) {
  const m = String(err && err.message || err);
  if (/ERR_NAME_NOT_RESOLVED|ERR_TUNNEL_CONNECTION_FAILED|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED/.test(m)) return 'That website could not be found. Check the address.';
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/.test(m)) return 'The website refused the connection.';
  if (/ERR_CERT|SSL/.test(m)) return 'The website has a security certificate problem.';
  if (/Timeout|timed out/i.test(m)) return 'The page took too long to load. Try again, or add a wait time.';
  if (/ERR_BLOCKED_BY_CLIENT/.test(m)) return 'That address is blocked on this server.';
  if (/Executable doesn't exist|browserType.launch/.test(m)) return 'The browser is not installed. Run "npm run setup" in the web-to-pdf folder.';
  return 'Could not capture this page: ' + m.split('\n')[0];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && p === '/api/capture') return handleCapture(req, res);

  const m = p.match(/^\/api\/pdf\/([0-9a-f]{24})$/);
  if (req.method === 'GET' && m) {
    const r = results.get(m[1]);
    if (!r) return send(res, 404, 'This PDF has expired. Please capture the page again.');
    const name = fileNameFor(r.title);
    const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
    return send(res, 200, r.pdf, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, max-age=900',
    });
  }

  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (p === '/editor') return send(res, 302, '', { Location: '/editor/' + url.search });
  if (p.startsWith('/editor/')) {
    const rel = p.slice('/editor/'.length) || 'index.html';
    if (!EDITOR_FILES.has(rel)) return send(res, 404, 'Not found');
    return serveFile(res, path.join(EDITOR_DIR, rel));
  }
  send(res, 404, 'Not found');
});

server.listen(PORT, HOST, () => {
  const shown = LOCAL_ONLY ? 'localhost' : HOST;
  console.log(`Web to PDF is running: http://${shown}:${PORT}`);
  if (!LOCAL_ONLY) console.log(`Reachable from other computers. Private network addresses are ${ALLOW_PRIVATE ? 'ALLOWED' : 'blocked'}.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(); closeBrowser().finally(() => process.exit(0)); });
}
