# PDF Editor

A PDF editor that runs entirely in your web browser. Files never leave your computer: there is no server and no upload.

## How to run it

- **Easiest:** download this repository and double-click `index.html`.
- **Or** serve the folder with any static web server, for example:
  ```
  python3 -m http.server 8000
  ```
  then open <http://localhost:8000>.
- **Online:** turn on GitHub Pages for this repository (Settings → Pages → deploy from the main branch) and the editor will be available at your Pages URL.

## What it can do

| Feature | How |
| --- | --- |
| Open a PDF | **Open**, or drag a PDF onto the window |
| Add text | **Text** tool, click where it should go, type. Click away to finish. Double-click existing added text to edit it |
| Draw freehand | **Draw** tool |
| Highlight an area | **Highlight** tool, drag over the area |
| Draw a box | **Box** tool |
| Hide existing content | **Whiteout** tool covers it with a white box (then add new text on top to "replace" text) |
| Insert an image | **Image** (PNG or JPG), or drag an image onto the window |
| Move / resize / delete | **Select** tool: drag to move, drag the square handle to resize, Delete key to remove, arrow keys to nudge |
| Change color, font, size, line width | Toolbar controls. With an item selected, changes apply to it |
| Rotate, delete, insert blank pages | Hover a page thumbnail on the left |
| Reorder pages | Drag thumbnails |
| Merge PDFs | **Merge** adds another PDF's pages to the end |
| Undo / redo | Buttons, or Ctrl+Z / Ctrl+Y |
| Save | **Download** (or Ctrl+S) saves `<name>-edited.pdf` |

Keyboard shortcuts for tools: V select, T text, P draw, H highlight, R box, W whiteout.

## Limitations

- Text that is already in the PDF can't be edited directly. Use Whiteout to cover it, then add new text on top.
- Added text uses the built-in PDF fonts (Helvetica, Times, Courier), which only cover Western European characters. Other characters are saved as `?`.
- Password-protected PDFs can be viewed, but saving them may fail.

## How it works

- [`index.html`](index.html), [`styles.css`](styles.css), [`app.js`](app.js): the whole app, no build step.
- [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) draws the pages; [pdf-lib](https://pdf-lib.js.org/) (MIT) writes the edited PDF. Both are bundled in [`vendor/`](vendor) so the app works offline.
- Edits are stored in PDF coordinates while you work and are written into the original pages when you download, so the original content (text, vector graphics, fonts) is kept as is.
