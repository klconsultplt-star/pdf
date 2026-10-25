# Web to PDF

Save any web page as a PDF that looks **exactly like it does on screen**: same layout, colors, fonts and images, as one long page. Nothing is re-flowed, cut into A4 sheets or dropped.

Paste an address, choose a screen size, and download the PDF or open it straight in the [PDF Editor](../README.md) to add a watermark, notes or highlights.

## Why not just "Print → Save as PDF"?

Printing re-lays the page out for paper: the site's print styles hide menus and sections, the width shrinks to A4, and content is chopped into sheets. That's where content goes missing and alignment breaks.

Web to PDF captures the screen version instead:

1. Opens the page in a real Chrome browser at the screen width you choose.
2. Keeps the on-screen styles; the site's print styles are ignored.
3. Scrolls through the whole page so images and sections that load on scroll are loaded.
4. Locks parts sized to the window (such as full-screen banners) and fixed bars (menus, cookie notices) at their on-screen size and position.
5. Saves it all as **one tall page exactly as wide as the screen**.

## Setup (once)

You need [Node.js](https://nodejs.org) 18 or newer.

```
cd web-to-pdf
npm install
npm run setup      # downloads the Chrome browser it uses (about 150 MB)
```

## Use it

```
npm start
```

Then open <http://localhost:3000> in your browser.

| Option | What it does |
| --- | --- |
| **Screen** | Width the page is shown at: Desktop 1440 px, Laptop 1280 px, Tablet 768 px, Phone 390 px. Sites change their layout by width, so pick the one you want to keep. |
| **Wait before capturing** | Extra time for slow animations or content that pops in late. |
| **PDF type: Exact layout, selectable text** (recommended) | Text can be selected and searched, links stay clickable, sharp at any zoom. |
| **PDF type: Picture of the page** | A screenshot of the page in a PDF: always a pixel-perfect copy of the screen, but text can't be selected. Use it if the first type doesn't look right for a particular site. |

After capturing you get a preview, **Download PDF**, and **Open in PDF Editor**.

### From the command line

```
node capture.js https://example.com page.pdf
node capture.js https://example.com page.pdf --device mobile --mode image --delay 3000
```

## Limitations

- **Pages behind a login** show the logged-out version, since the browser it uses isn't signed in.
- **Pop-ups and cookie notices** are captured if they're on screen, because the PDF shows the page as a visitor sees it.
- **Very long pages:** scrolling stops at 60,000 px (pages with endless scrolling never end). Pages taller than 200 inches are scaled down slightly to fit, because that's the largest page size Adobe Reader can open.
- **Scrolling panels inside a page** (for example a chat window or a table with its own scrollbar) show only the part that's visible.
- **Videos and animations** show the frame that's visible when captured.
- Some sites block automated browsers or show a CAPTCHA; those can't be captured.

## Sharing it with others (running on a server)

By default it only accepts connections from this computer. To let others use it, start it with:

```
HOST=0.0.0.0 PORT=3000 npm start
```

Then:

- Addresses on your private network (`localhost`, `192.168.x.x`, …) are blocked automatically, so visitors can't use it to look inside your network. Set `ALLOW_PRIVATE=1` only if you trust everyone who can reach it.
- It has no password. Put it behind your own login, or a reverse proxy with authentication, before exposing it to the internet.
- `MAX_JOBS` (default 2) limits how many pages are captured at the same time.

## Files

- `capture.js`: opens, prepares and saves the page (also the command-line tool).
- `server.js`: the web server; also serves the PDF Editor at `/editor/`.
- `public/index.html`: the web page you use.
