# PDF Editor

A PDF editor that runs entirely in your web browser. Files never leave your computer: there is no server and no upload.

Also in this repository, to save any web page as a PDF exactly as it looks on screen (and open it in this editor):

- **[Web to PDF browser extension](web-to-pdf-extension/README.md)** for Chrome and Edge: one click on the page you're viewing, works on logged-in pages, nothing to set up besides loading the extension. Download [`dist/web-to-pdf-extension.zip`](dist/web-to-pdf-extension.zip).
- **[Web to PDF server app](web-to-pdf/README.md)**: the same capture as a small web app (Node.js), for capturing pages by address or sharing with a team.

## How to run it

**One file (simplest):** download [`dist/pdf-editor.html`](dist/pdf-editor.html) (on GitHub, open the file and click the **Download raw file** button), save it anywhere, and double-click it. It contains the whole editor and works offline.

**Whole folder:** on GitHub click **Code → Download ZIP**, unzip it, and double-click `index.html`. `index.html` needs the files next to it (`app.js`, `export.js`, `styles.css`, `vendor/`), so don't move it out of the folder on its own.

**Online:** turn on GitHub Pages for this repository (Settings → Pages) and the editor is available at your Pages URL.

After changing the app's files, run `python3 build-single-file.py` to rebuild `dist/pdf-editor.html`.

## What it can do

| Feature | How |
| --- | --- |
| Open a PDF | **Open**, or drag a PDF onto the window |
| Add text | **Text** tool, click where it should go, type. Click away to finish. Double-click existing added text to edit it |
| Draw freehand | **Draw** tool |
| Highlight an area | **Highlight** tool, drag over the area |
| Draw a box | **Box** tool |
| Hide existing content | **Whiteout** tool covers it with a white box (then add new text on top to "replace" text) |
| Watermark | Type your text in the box next to **Watermark** (default "DRAFT", remembered for next time) and click the button: a faint diagonal watermark (bold, 150 pt, 10% opacity, 45°) goes across every page. Longer text is shrunk so it still fits the page. Click again to remove it, or change the text and click to replace it |
| Insert an image | **Image** (PNG or JPG), or drag an image onto the window |
| Move / resize / delete | **Select** tool: drag to move, drag the square handle to resize, Delete key to remove, arrow keys to nudge |
| Change color, font, size, line width | Toolbar controls. With an item selected, changes apply to it |
| Rotate, delete, insert blank pages | Hover a page thumbnail on the left |
| Reorder pages | Drag thumbnails |
| Merge PDFs | **Merge** adds another PDF's pages to the end |
| Undo / redo | Buttons, or Ctrl+Z / Ctrl+Y |
| Save | **Download** (or Ctrl+S) saves `<name>-edited.pdf` |
| Export to Word, Excel, CSV | **Export as…** saves the text as `.docx`, `.xlsx` (one sheet per page; numbers become real numbers) or `.csv`. Includes text you added; leaves out watermarks and text hidden under Whiteout. Only available for PDFs that contain text: for scanned PDFs the menu is greyed out |

Keyboard shortcuts for tools: V select, T text, P draw, H highlight, R box, W whiteout.

## Limitations

- Text that is already in the PDF can't be edited directly. Use Whiteout to cover it, then add new text on top.
- Added text uses the built-in PDF fonts (Helvetica, Times, Courier), which only cover Western European characters. Other characters are saved as `?`.
- Export to Word/Excel/CSV copies the **text** only, rebuilding lines and table columns from where the text sits on the page. Images, drawings and formatting are not carried over, and complex layouts (multi-column articles, merged table cells) may need tidying. Scanned PDFs contain pictures of text, not text, so export is turned off for them. A document with at least one page of real text counts as a text PDF.
- Password-protected PDFs can be viewed, but saving them may fail.

## How it works

- [`index.html`](index.html), [`styles.css`](styles.css), [`app.js`](app.js): the whole app, no build step.
- [`export.js`](export.js): the Word/Excel/CSV export, including a small built-in zip writer (no extra libraries).
- [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) draws the pages; [pdf-lib](https://pdf-lib.js.org/) (MIT) writes the edited PDF. Both are bundled in [`vendor/`](vendor) so the app works offline.
- Edits are stored in PDF coordinates while you work and are written into the original pages when you download, so the original content (text, vector graphics, fonts) is kept as is.
