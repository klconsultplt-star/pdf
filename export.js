/* Export the PDF's text to Word (.docx), Excel (.xlsx) and CSV.
 *
 * PDFs store text as positioned fragments, not as paragraphs or tables, so
 * this rebuilds the layout: fragments on the same baseline become a line,
 * large horizontal gaps split a line into cells, and cells that start at the
 * same x position on a page share a column. This works well for ordinary
 * text and simple tables; scanned PDFs (pictures of text) contain no text,
 * so the app doesn't offer export for them.
 */
(() => {
  'use strict';

  const COLUMN_SNAP = 10; // points: cell starts this close share a column

  // ---------- Reading text from a PDF ----------

  // Returns [{ rows: [[cell, …], …], lines: [{ text, size }] }] per page.
  // `skip(pageIndex, x, y, text)` can drop text at PDF point (x, y), e.g. under a whiteout box.
  async function extractPages(pdfBytes, skip) {
    const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const [a, b, c, d, e, f] = it.transform;
        const len = Math.hypot(a, b) || 1;
        // Middle of the fragment in PDF space, used for the whiteout check.
        const mx = e + (a / len) * it.width / 2, my = f + (b / len) * it.width / 2;
        if (skip && skip(n - 1, mx, my, it.str)) continue;
        // Position as displayed (y grows downward), so rotated pages read correctly.
        const m = mul(vp.transform, it.transform);
        const size = Math.hypot(m[2], m[3]);
        if (Math.abs(m[1]) > Math.abs(m[0]) * 0.2) continue; // skip vertical/diagonal text
        items.push({ str: it.str, x: m[4], y: m[5], w: it.width * Math.hypot(m[0], m[1]) / len, size: size || 10 });
      }
      out.push(layoutPage(items));
    }
    doc.destroy();
    return out;
  }

  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];

  function layoutPage(items) {
    // 1. Group fragments into lines by baseline.
    items.sort((p, q) => p.y - q.y || p.x - q.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.y - it.y) < Math.min(l.size, it.size) * 0.5);
      if (line) { line.items.push(it); line.size = Math.max(line.size, it.size); }
      else lines.push({ y: it.y, size: it.size, items: [it] });
    }
    lines.sort((p, q) => p.y - q.y);

    // 2. Split each line into cells at wide gaps; join close fragments.
    for (const line of lines) {
      line.items.sort((p, q) => p.x - q.x);
      line.cells = [];
      let cell = null;
      for (const it of line.items) {
        const gap = cell ? it.x - cell.end : Infinity;
        if (cell && gap < line.size * 1.2) {
          const needsSpace = gap > line.size * 0.15 && !/\s$/.test(cell.text) && !/^\s/.test(it.str);
          cell.text += (needsSpace ? ' ' : '') + it.str;
          cell.end = Math.max(cell.end, it.x + it.w);
        } else {
          cell = { x: it.x, end: it.x + it.w, text: it.str };
          line.cells.push(cell);
        }
      }
      line.cells.forEach((c) => (c.text = c.text.replace(/\s+/g, ' ').trim()));
    }

    // 3. Line up columns: cells starting at about the same x share a column.
    const starts = lines.flatMap((l) => l.cells.map((c) => c.x)).sort((p, q) => p - q);
    const anchors = [];
    for (const x of starts) if (!anchors.length || x - anchors[anchors.length - 1].last > COLUMN_SNAP) anchors.push({ x, last: x }); else anchors[anchors.length - 1].last = x;
    const colOf = (x) => {
      let best = 0;
      anchors.forEach((a, i) => { if (x >= a.x - 0.01) best = i; });
      return best;
    };
    const rows = lines.map((l) => {
      const row = [];
      for (const c of l.cells) {
        let col = colOf(c.x);
        while (row[col] != null) col++;
        row[col] = c.text;
      }
      for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
      return row;
    });

    return {
      rows,
      lines: lines.map((l) => ({ text: l.cells.map((c) => c.text).join('\t'), size: l.size })),
    };
  }

  // ---------- CSV ----------
  function toCsv(pages) {
    const esc = (v) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
    const out = [];
    pages.forEach((p, i) => {
      if (i > 0) out.push('');
      p.rows.forEach((r) => out.push(r.map(esc).join(',')));
    });
    // BOM so Excel opens accented characters correctly.
    return new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  }

  // ---------- Excel (.xlsx) ----------
  const xml = (s) => String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // Plain numbers become numeric cells; codes like "007" stay text.
  function asNumber(v) {
    const t = v.replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(t) || /^-?0\d/.test(t) || t.length > 15) return null;
    return t;
  }

  function toXlsx(pages) {
    const sheets = pages.map((p) => {
      const width = Math.max(1, ...p.rows.map((r) => r.length));
      const colWidths = Array.from({ length: width }, (_, c) =>
        Math.min(60, Math.max(8, ...p.rows.map((r) => (r[c] || '').length + 2))));
      const rowsXml = p.rows.map((r, ri) => {
        const cells = r.map((v, ci) => {
          if (!v) return '';
          const ref = colName(ci) + (ri + 1);
          const num = asNumber(v);
          return num != null
            ? `<c r="${ref}"><v>${num}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
        `<sheetData>${rowsXml}</sheetData></worksheet>`;
    });

    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((_, i) => `<sheet name="Page ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        '</Relationships>',
    };
    sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = s));
    return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- Word (.docx) ----------
  function toDocx(pages) {
    const para = (line, pageBreak) => {
      const size = Math.max(8, Math.min(72, Math.round(line.size * 2))); // half-points
      const runs = line.text.split('\t').map((t, i) =>
        (i ? '<w:r><w:tab/></w:r>' : '') +
        `<w:r><w:rPr><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`).join('');
      return `<w:p><w:pPr>${pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="60"/></w:pPr>${runs}</w:p>`;
    };
    let body = '';
    pages.forEach((p, i) => {
      if (!p.lines.length) body += para({ text: '', size: 11 }, i > 0);
      p.lines.forEach((l, k) => (body += para(l, i > 0 && k === 0)));
    });
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
      'word/document.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        body +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
        '</w:body></w:document>',
    };
    return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // ---------- Minimal zip writer (no compression; Word and Excel accept it) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const nameBytes = enc.encode(name);
      const data = typeof content === 'string' ? enc.encode(content) : content;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, dosTime, true);
      cen.setUint16(14, dosDate, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true);
    end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
  }

  window.PdfExport = { extractPages, toCsv, toXlsx, toDocx, zip };
})();
