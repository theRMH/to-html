
const express = require('express');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const cheerio = require('cheerio');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const downloadsRoot = path.resolve(__dirname, 'mirrors');

fs.mkdirSync(downloadsRoot, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/mirrors', express.static(downloadsRoot));

const httpClient = axios.create({
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteArchiver/1.0)' },
    maxRedirects: 10,
});

// ── Crawl: find all internal links on the page ──────────────────────────────

app.post('/api/crawl', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Please provide a valid URL.' });
    }

    let base;
    try { base = new URL(url); } catch {
        return res.status(400).json({ error: 'URL is not a valid absolute URI.' });
    }
    if (!['http:', 'https:'].includes(base.protocol)) {
        return res.status(400).json({ error: 'Only http/https URLs are supported.' });
    }

    try {
        const { data: html } = await httpClient.get(url, { responseType: 'text' });
        const $ = cheerio.load(html);
        const pages = new Map();

        const normalize = href => {
            try {
                const u = new URL(href, base.href);
                if (u.origin !== base.origin) return null;
                u.hash = '';
                return u.href;
            } catch { return null; }
        };

        pages.set(normalize(url), base.pathname || '/');

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;
            const abs = normalize(href);
            if (!abs || pages.has(abs)) return;
            const label = $(el).text().trim().slice(0, 60) || new URL(abs).pathname;
            pages.set(abs, label);
        });

        const result = [...pages.entries()].slice(0, 60).map(([href, label]) => ({ href, label }));
        res.json({ pages: result });
    } catch (err) {
        res.status(500).json({ error: `Could not fetch page: ${err.message}` });
    }
});

// ── Asset helpers ────────────────────────────────────────────────────────────

function assetDiskPath(absoluteUrl, jobDir) {
    const parsed = new URL(absoluteUrl);
    let p = parsed.pathname;
    if (p.endsWith('/') || p === '') p += 'index.html';
    p = p.replace(/^\//, '');
    return path.join(jobDir, 'assets', parsed.hostname, p);
}

// Server-side extensions that produce HTML output but can't run locally
const SERVER_EXTS = new Set(['.php', '.asp', '.aspx', '.jsp', '.cfm', '.cgi', '.py', '.rb']);

// Extensions stripped when computing a canonical URL for page matching
// Includes .html so already-rewritten local links still match their canonical key
const CANONICAL_STRIP_EXTS = new Set([...SERVER_EXTS, '.html']);

// Derive where a page's HTML will be saved
function pageHtmlPath(pageUrl, jobDir) {
    const base = new URL(pageUrl);
    let savePath = base.pathname;
    if (savePath.endsWith('/') || savePath === '') {
        savePath += 'index.html';
    } else {
        const ext = path.extname(savePath).toLowerCase();
        if (SERVER_EXTS.has(ext)) {
            // Replace server-side extension with .html so the browser renders it
            savePath = savePath.slice(0, -ext.length) + '.html';
        } else if (!ext) {
            savePath += '/index.html';
        }
    }
    savePath = savePath.replace(/^\//, '') || 'index.html';
    return { savePath, htmlOut: path.join(jobDir, savePath) };
}

async function downloadAsset(absoluteUrl, jobDir, log, skips) {
    const destPath = assetDiskPath(absoluteUrl, jobDir);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const r = await httpClient.get(absoluteUrl, { responseType: 'arraybuffer' });
    fs.writeFileSync(destPath, Buffer.from(r.data));
    log(`  asset: ${absoluteUrl}`);
    return { destPath, contentType: r.headers['content-type'] || '' };
}

async function processCss(cssText, cssUrl, cssDiskPath, jobDir, log, skips) {
    const cssBase = new URL(cssUrl);
    const cssDir = path.dirname(cssDiskPath);
    const urlRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
    const seen = new Map();
    let match;
    while ((match = urlRegex.exec(cssText)) !== null) {
        const ref = match[1].trim();
        if (ref.startsWith('data:') || ref.startsWith('#') || seen.has(ref)) continue;
        try { seen.set(ref, new URL(ref, cssBase.href).href); } catch { /* skip */ }
    }
    for (const [ref, abs] of seen) {
        try {
            const { destPath } = await downloadAsset(abs, jobDir, log, skips);
            const rel = path.relative(cssDir, destPath).split(path.sep).join('/');
            cssText = cssText.split(ref).join(rel);
        } catch (err) {
            skips.push({ url: abs, reason: err.message, context: `referenced in ${cssUrl}` });
        }
    }
    return cssText;
}

// ── Mirror a single page ─────────────────────────────────────────────────────

async function mirrorPage(pageUrl, jobDir, log, skips) {
    const base = new URL(pageUrl);
    log(`Fetching ${pageUrl}`);

    const { data: htmlText } = await httpClient.get(pageUrl, { responseType: 'text' });
    const $ = cheerio.load(htmlText);

    // Remove SRI integrity checks — hashes won't match local copies and block scripts/styles
    $('script[integrity], link[integrity]').each((_, el) => {
        $(el).removeAttr('integrity').removeAttr('crossorigin');
    });

    // Resolve save path FIRST so relative paths are computed from the correct directory
    const { savePath, htmlOut } = pageHtmlPath(pageUrl, jobDir);
    const htmlDir = path.dirname(htmlOut);

    const selectors = [
        { sel: 'link[href]', attr: 'href' },
        { sel: 'script[src]', attr: 'src' },
        { sel: 'img[src]', attr: 'src' },
        { sel: 'source[src]', attr: 'src' },
        { sel: 'video[src]', attr: 'src' },
        { sel: 'audio[src]', attr: 'src' },
    ];

    const downloaded = new Map();

    for (const { sel, attr } of selectors) {
        for (const el of $(sel).toArray()) {
            const ref = $(el).attr(attr);
            if (!ref || ref.startsWith('data:')) continue;
            let abs;
            try { abs = new URL(ref, base.href).href; } catch { continue; }

            if (!downloaded.has(abs)) {
                try {
                    const { destPath, contentType } = await downloadAsset(abs, jobDir, log, skips);
                    downloaded.set(abs, destPath);
                    if (contentType.includes('css') || abs.endsWith('.css')) {
                        try {
                            let css = fs.readFileSync(destPath, 'utf8');
                            css = await processCss(css, abs, destPath, jobDir, log, skips);
                            fs.writeFileSync(destPath, css);
                        } catch { /* skip */ }
                    }
                } catch (err) {
                    skips.push({ url: abs, reason: err.message, context: `asset on ${pageUrl}` });
                    continue;
                }
            }

            // FIX: compute relative path from the HTML file's directory, not jobDir
            const rel = path.relative(htmlDir, downloaded.get(abs)).split(path.sep).join('/');
            $(el).attr(attr, rel);
        }
    }

    $('base').remove();

    fs.mkdirSync(htmlDir, { recursive: true });
    fs.writeFileSync(htmlOut, $.html());
    log(`Saved ${savePath}`);

    return savePath;
}

// ── Rewrite cross-page <a href> links after all pages are downloaded ──────────

// Canonical key: origin + pathname (server-side + .html ext stripped, no trailing slash) + search query
function canonicalUrl(href, base) {
    const u = new URL(href, base);
    let p = u.pathname.replace(/\/$/, '');
    const ext = path.extname(p).toLowerCase();
    if (CANONICAL_STRIP_EXTS.has(ext)) p = p.slice(0, -ext.length);
    return u.origin + p + u.search;
}

async function rewritePageLinks(downloadedPages, siteOrigin, jobDir, log) {
    // Build canonical URL → disk path for every downloaded page
    const urlToHtmlPath = new Map();
    for (const { url, savePath } of downloadedPages) {
        const diskPath = path.join(jobDir, savePath);
        urlToHtmlPath.set(canonicalUrl(url, url), diskPath);
        // Also map common homepage aliases: /index, /index.php, /index.html → homepage
        const u = new URL(url);
        if (u.pathname === '/' || u.pathname === '') {
            urlToHtmlPath.set(u.origin + '/index', diskPath);
            urlToHtmlPath.set(u.origin + '/index.php', diskPath);
            urlToHtmlPath.set(u.origin + '/index.html', diskPath);
        }
    }

    // Pass 1: collect link-text → disk path from pages that have real hrefs.
    // Some PHP sites render the homepage nav as href="#" + JS, while other pages
    // use real hrefs. This map lets us patch those # links by matching their text.
    const textToPath = new Map();
    for (const { url, savePath } of downloadedPages) {
        try {
            const html = fs.readFileSync(path.join(jobDir, savePath), 'utf8');
            const $ = cheerio.load(html);
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href === '#' || href.startsWith('javascript:') ||
                    href.startsWith('mailto:') || href.startsWith('tel:')) return;
                let absUrl;
                try { absUrl = new URL(href, url); } catch { return; }
                if (absUrl.origin !== siteOrigin) return;
                const key = canonicalUrl(absUrl.href, absUrl.href);
                if (!urlToHtmlPath.has(key)) return;
                const text = $(el).text().trim().toLowerCase().replace(/\s+/g, ' ');
                if (text && text.length < 60 && !textToPath.has(text)) {
                    textToPath.set(text, urlToHtmlPath.get(key));
                }
            });
        } catch { /* skip */ }
    }

    log(`textToPath has ${textToPath.size} entries: ${[...textToPath.keys()].slice(0,10).join(', ')}`);

    // Pass 2: rewrite links in every downloaded page
    for (const { url, savePath } of downloadedPages) {
        const diskPath = path.join(jobDir, savePath);
        const htmlDir = path.dirname(diskPath);

        try {
            const html = fs.readFileSync(diskPath, 'utf8');
            const $ = cheerio.load(html);
            let changed = false;

            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

                // # and javascript: links — try to patch via link text
                if (href === '#' || href.startsWith('javascript:')) {
                    const text = $(el).text().trim().toLowerCase().replace(/\s+/g, ' ');
                    if (text && textToPath.has(text)) {
                        const rel = path.relative(htmlDir, textToPath.get(text)).split(path.sep).join('/');
                        $(el).attr('href', rel);
                        changed = true;
                    }
                    return;
                }

                let absUrl;
                try { absUrl = new URL(href, url); } catch { return; }

                // Leave external links untouched
                if (absUrl.origin !== siteOrigin) return;

                const fragment = absUrl.hash || '';
                const key = canonicalUrl(absUrl.href, absUrl.href);

                if (urlToHtmlPath.has(key)) {
                    // Page was downloaded — point to local file
                    const targetDisk = urlToHtmlPath.get(key);
                    let rel = path.relative(htmlDir, targetDisk).split(path.sep).join('/');
                    if (fragment) rel += fragment;
                    $(el).attr('href', rel);
                } else {
                    // Same-site page not downloaded — neutralize so it doesn't hit the live site
                    $(el).attr('href', '#');
                }
                changed = true;
            });

            if (changed) {
                fs.writeFileSync(diskPath, $.html());
                log(`  links rewritten: ${savePath}`);
            }
        } catch { /* skip */ }
    }
}

// ── Download selected pages ───────────────────────────────────────────────────

app.post('/api/download', async (req, res) => {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Provide at least one URL to download.' });
    }

    for (const url of urls) {
        try {
            const u = new URL(url);
            if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        } catch {
            return res.status(400).json({ error: `Invalid URL: ${url}` });
        }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
    const log = msg => send('log', { message: msg });

    const firstHost = new URL(urls[0]).hostname.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
    const folderName = `${dateStr} ${timeStr} - ${firstHost}`;
    const jobDir = path.join(downloadsRoot, folderName);
    fs.mkdirSync(jobDir, { recursive: true });

    const results = [];
    const allSkips = [];
    const downloadedPages = []; // { url, savePath } for successful downloads

    for (const url of urls) {
        log(`── Starting: ${url}`);
        const pageSkips = [];
        try {
            const savedPath = await mirrorPage(url, jobDir, log, pageSkips);
            const relative = path.relative(downloadsRoot, jobDir).split(path.sep).join('/');
            const siteUrl = `/mirrors/${relative}/${savedPath}`;
            results.push({ url, success: true, siteUrl });
            downloadedPages.push({ url, savePath: savedPath });
            log(`✓ Done: ${url}`);
        } catch (err) {
            results.push({ url, success: false, error: err.message });
            log(`✗ Failed: ${url} — ${err.message}`);
        }
        allSkips.push(...pageSkips.map(s => ({ ...s, page: url })));
    }

    // Rewrite all same-site <a href> links: downloaded pages → local path, others → #
    if (downloadedPages.length > 0) {
        log('── Rewriting page links…');
        const siteOrigin = new URL(urls[0]).origin;
        // Deduplicate by savePath — same file may appear twice if crawl returned
        // the homepage as both "/" and "/index.php"; double-processing reverts links.
        const seen = new Set();
        const uniquePages = downloadedPages.filter(p => {
            if (seen.has(p.savePath)) return false;
            seen.add(p.savePath);
            return true;
        });
        await rewritePageLinks(uniquePages, siteOrigin, jobDir, log);
    }

    send('done', { results, skips: allSkips });
    res.end();
});

app.listen(port, () => {
    console.log(`URL-to-HTML web app running on http://localhost:${port}`);
});
