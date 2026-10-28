/* Loaded by the bundled PDF Editor: opens a PDF the extension just captured
   (editor/index.html?capture=<id>&name=<file name>). */
(async () => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const key = params.get('capture');
  if (!key || !window.pdfEditor) return;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('web-to-pdf', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('pdfs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Take the PDF out of storage (and clear any old ones left behind).
  const record = await new Promise((resolve) => {
    const tx = db.transaction('pdfs', 'readwrite');
    const store = tx.objectStore('pdfs');
    const get = store.get(key);
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => resolve(null);
    store.delete(key);
    const cutoff = Date.now() - 3600000;
    store.openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (!c.value || c.value.created < cutoff) c.delete();
      c.continue();
    };
  });
  db.close();
  history.replaceState(null, '', location.pathname); // so a reload doesn't try again
  if (!record) return;
  const name = params.get('name') || 'page.pdf';
  await window.pdfEditor.openFile(new File([record.pdf], name, { type: 'application/pdf' }));
})();
