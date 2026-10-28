'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = { device: 'current', mode: 'vector', delay: 0 };
let tab;

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('page').textContent = tab && tab.title ? tab.title : '';
  const saved = await chrome.storage.local.get(DEFAULTS);
  $('device').value = saved.device;
  $('delay').value = String(saved.delay);
  document.querySelector(`input[name=mode][value=${saved.mode}]`).checked = true;
  // Show how the last capture went (useful if the popup was closed meanwhile).
  const { last } = await chrome.storage.session.get('last');
  if (last && tab && last.tabId === tab.id && Date.now() - last.at < 60000) show(last.ok ? 'ok' : 'err', last.message);
})();

function options() {
  return {
    device: $('device').value,
    delay: Number($('delay').value),
    mode: document.querySelector('input[name=mode]:checked').value,
  };
}

function show(kind, text) {
  $('status').className = 'status ' + kind;
  $('status').textContent = text;
}

async function start(after) {
  const opts = options();
  await chrome.storage.local.set(opts);
  $('save').disabled = $('edit').disabled = true;
  show('busy', 'Capturing… This takes a few seconds. You can close this window; the PDF will still be saved.');
  const res = await chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, options: { ...opts, after } });
  $('save').disabled = $('edit').disabled = false;
  if (res && res.ok) show('ok', after === 'editor' ? 'Opened in the PDF Editor.' : `Saved to your Downloads folder: ${res.fileName}`);
  else show('err', (res && res.error) || 'Something went wrong.');
}

$('save').addEventListener('click', () => start('download'));
$('edit').addEventListener('click', () => start('editor'));
