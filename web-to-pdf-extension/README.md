# Web to PDF: browser extension

Save the page you're looking at as a PDF that looks **exactly like it does on screen**: one long page, same layout, colors and images, with selectable text and working links. Works in **Google Chrome** and **Microsoft Edge** on Windows and Mac.

Because it captures your own tab, it also works on pages where you're logged in (webmail, dashboards, statements). Nothing is uploaded: the PDF is made on your computer.

The [PDF Editor](../README.md) is built in, so you can add a watermark, notes or highlights right after capturing.

## Install (about 1 minute)

1. Download **`web-to-pdf-extension.zip`** and unzip it into a folder you'll keep, for example `Documents\web-to-pdf-extension`. The browser loads the extension from this folder, so don't delete or move it later.
2. Open the extensions page:
   - Chrome: type `chrome://extensions` in the address bar
   - Edge: type `edge://extensions` in the address bar
3. Turn on **Developer mode** (Chrome: switch at the top right; Edge: switch on the left).
4. Click **Load unpacked** and choose the unzipped `web-to-pdf-extension` folder (the one that contains `manifest.json`).
5. Click the puzzle-piece icon in the toolbar and **pin** "Web to PDF (exact)" so its button is always visible.

## Use it

- Click the **Web to PDF** button in the toolbar (or press **Alt+Shift+P**), then **Save as PDF**. The file goes to your Downloads folder, named after the page title.
- **Save & open in PDF Editor** opens the result in the built-in editor instead.
- Or right-click anywhere on a page and choose **Save page as PDF (exact)**.

While it captures, the browser shows a bar saying *"Web to PDF started debugging this browser"* for a few seconds. That's normal: it's how the extension uses the browser's own PDF engine. Don't click **Cancel** on it. The page is put back exactly as it was afterwards.

| Option | What it does |
| --- | --- |
| **Screen width: As I see it now** | Captures at your window's current width (default). |
| **Desktop / Laptop / Tablet / Phone** | Captures as if the window were 1440 / 1280 / 768 / 390 px wide. Sites built for phones and tablets switch to that layout. |
| **Wait before capturing** | Extra time for slow animations or content that appears late. |
| **Exact layout, selectable text** (recommended) | Sharp at any zoom, text can be selected and searched, links work. |
| **Picture of the page** | A screenshot of the page in a PDF: a pixel-perfect copy, but text can't be selected. Use it if the first type doesn't look right on a particular site. |

The badge on the button shows **…** while working, **✓** when done and **!** if something went wrong (open the popup to see the message).

## Good to know

- Browser pages (settings, new tab, the extension store) can't be captured; browsers protect them.
- If the developer tools (F12) are open on the tab, close them first.
- **Very long pages:** capture stops at 60,000 px for pages that scroll endlessly. Pages taller than 200 inches are scaled down slightly to fit, because that's the largest page size Adobe Reader can open.
- **Scrolling panels inside a page** (for example a chat window or a table with its own scrollbar) show only the part that's visible.
- Firefox and Safari aren't supported: they don't let extensions use the browser's PDF engine this way.

**Why it asks for these permissions:**

| Permission | Why |
| --- | --- |
| Debugger | To use the browser's own PDF engine on the tab (only while capturing, only on the tab you choose). |
| Downloads | To save the PDF. |
| Storage | To remember your options and hand the PDF to the built-in editor. |
| Context menus | For the right-click menu item. |

## Updating

Replace the folder's contents with the new version, then click the reload icon on the extension's card in `chrome://extensions`.

## For developers

The source is in `web-to-pdf-extension/`. Run `python3 build-extension.py` at the repository root to assemble `dist/web-to-pdf-extension/` (the source plus the PDF Editor) and `dist/web-to-pdf-extension.zip`.

To share it more widely, it can be published to the Chrome Web Store (one-time US$5 developer fee) or Microsoft Edge Add-ons (free). Then people install it with one click, without Developer mode.
