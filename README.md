# Website to Static HTML

Converts any publicly reachable PHP/WordPress/dynamic website into a fully browsable static HTML snapshot. Intended for replacing a live dynamic site with a fast-loading, SEO-friendly static version.

## Requirements

- Node.js 18+
- `npm install` (installs `express`, `axios`, `cheerio`)

## Start

```
npm install
node server.js
```

Open `http://localhost:3000/` in your browser.

## How It Works

### Step 1 — Discover pages
Enter the site URL and click **Discover Pages**. The app fetches the homepage, finds all internal links, and shows you a list of pages on the site.

### Step 2 — Select pages
Choose which pages to download. You do not have to download all of them.

### Step 3 — Download
Click **Download Selected**. The app downloads each selected page and all its assets (CSS, JS, images, fonts). Real-time progress is shown in the log.

### Step 4 — Review results
- **Downloaded pages** are shown with links to open them locally.
- **Skipped/failed assets** are listed separately so you know exactly what didn't make it.

## What the App Does to the HTML

- Downloads all CSS, JS, images, fonts and saves them locally under `mirrors/<folder>/assets/`
- Rewrites all asset URLs in HTML and CSS to relative local paths
- Rewrites `<a href>` links between downloaded pages to local relative paths
- Neutralises links to pages that were **not** downloaded (sets them to `#`) so no link points back to the live website

## Output Folder

Mirrors are saved under:
```
mirrors/<YYYY-MM-DD HH-MM-SS> - <hostname>/
```

Each page is saved as a `.html` file at the root of the folder (e.g. `about-us.html`, `contact-us.html`). The homepage is always `index.html`.

## Known Limitations

- Pages that require authentication or login cannot be downloaded
- Content loaded dynamically via JavaScript after page load (AJAX, infinite scroll) will not be captured
- WebSocket-dependent features will not work in the static version
- Some assets may 404 on the live server itself — these are reported in the Skipped list and are not caused by this tool

## Skipped Assets — What's Normal

| Asset | Why | Impact |
|---|---|---|
| `xmlrpc.php` | WordPress backend API, intentionally blocked (403) | None |
| `fonts.googleapis.com/` (bare URL) | Not a real asset URL | None — actual font files are separate |
| Any asset returning 404 | Missing on the live server too | Same as live site |
