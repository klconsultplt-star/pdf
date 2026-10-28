#!/usr/bin/env python3
"""Assemble the Web to PDF browser extension, ready to install.

Copies web-to-pdf-extension/ and the PDF Editor (index.html, app.js, …,
vendor/) into dist/web-to-pdf-extension/, adds the small bridge script that
lets the editor open captured PDFs, and zips it as
dist/web-to-pdf-extension.zip.

Run it again after changing the extension or the editor:
    python3 build-extension.py
"""
import pathlib
import shutil
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "web-to-pdf-extension"
OUT = ROOT / "dist" / "web-to-pdf-extension"
ZIP = ROOT / "dist" / "web-to-pdf-extension.zip"
EDITOR_FILES = ["index.html", "app.js", "export.js", "styles.css"]
VENDOR_FILES = ["pdf.min.js", "pdf.worker.min.js", "pdf-lib.min.js", "LICENSE-pdfjs", "LICENSE-pdf-lib.md"]

if OUT.exists():
    shutil.rmtree(OUT)
shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns("editor-bridge.js", ".*"))

editor = OUT / "editor"
(editor / "vendor").mkdir(parents=True)
for name in EDITOR_FILES:
    shutil.copy2(ROOT / name, editor / name)
for name in VENDOR_FILES:
    shutil.copy2(ROOT / "vendor" / name, editor / "vendor" / name)
shutil.copy2(SRC / "editor-bridge.js", editor / "bridge.js")

page = (editor / "index.html").read_text(encoding="utf-8")
tag = '<script src="app.js"></script>'
assert tag in page, "index.html no longer loads app.js the expected way"
(editor / "index.html").write_text(page.replace(tag, tag + '\n  <script src="bridge.js"></script>'), encoding="utf-8")

ZIP.unlink(missing_ok=True)
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(OUT.rglob("*")):
        if f.is_file():
            z.write(f, pathlib.Path("web-to-pdf-extension") / f.relative_to(OUT))

print(f"Built {OUT.relative_to(ROOT)}/ and {ZIP.relative_to(ROOT)} ({ZIP.stat().st_size / 1e6:.1f} MB)")
