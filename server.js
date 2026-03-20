
const express = require('express');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const cheerio = require('cheerio');
const axios = require('axios');
const CleanCSS = require('clean-css');
const { minify: terserMinify } = require('terser');

const app = express();
const port = process.env.PORT || 3000;
const downloadsRoot = path.resolve(__dirname, 'mirrors');

fs.mkdirSync(downloadsRoot, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/mirrors', express.static(downloadsRoot));

const httpClient = axios.create({
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteArchiver/1.0)' },
    maxRedirects: 10,
});

// ── Crawl: find all internal links on the page ──────────────────────────────

app.post('/api/crawl', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string')
        return res.status(400).json({ error: 'Please provide a valid URL.' });

    let base;
    try { base = new URL(url); } catch {
        return res.status(400).json({ error: 'URL is not a valid absolute URI.' });
    }
    if (!['http:', 'https:'].includes(base.protocol))
        return res.status(400).json({ error: 'Only http/https URLs are supported.' });

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

// Server-side extensions that produce HTML but can't run locally
const SERVER_EXTS = new Set(['.php', '.asp', '.aspx', '.jsp', '.cfm', '.cgi', '.py', '.rb']);

// Extensions stripped when computing canonical URL for page matching
const CANONICAL_STRIP_EXTS = new Set([...SERVER_EXTS, '.html']);

// Derive the flat disk path for a page's HTML
// /about-us/ → about-us.html   /services/web/ → services/web.html   / → index.html
function pageHtmlPath(pageUrl, jobDir) {
    const base = new URL(pageUrl);
    let savePath = base.pathname;

    // Strip trailing slash (except root)
    if (savePath !== '/' && savePath.endsWith('/'))
        savePath = savePath.slice(0, -1);

    if (savePath === '/' || savePath === '') {
        savePath = 'index.html';
    } else {
        const ext = path.extname(savePath).toLowerCase();
        if (SERVER_EXTS.has(ext)) {
            savePath = savePath.slice(0, -ext.length) + '.html';
        } else if (!ext) {
            savePath += '.html';
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

async function processCssAndMinify(cssText, cssUrl, cssDiskPath, jobDir, log, skips) {
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

    // Minify if not already minified
    if (!cssUrl.includes('.min.') && !cssUrl.includes('-min.')) {
        try {
            const result = new CleanCSS({ level: 2 }).minify(cssText);
            if (result.styles) cssText = result.styles;
        } catch { /* keep original on error */ }
    }
    return cssText;
}

// ── Strip WordPress junk ─────────────────────────────────────────────────────

function cleanWordPressJunk($) {
    // Remove inline scripts containing WP-specific dynamic values
    $('script').each((_, el) => {
        const content = $(el).html() || '';
        const src = $(el).attr('src') || '';
        if (
            content.includes('_wpemojiSettings') ||
            content.includes('admin-ajax.php') ||
            content.includes('"ajaxUrl"') ||
            content.includes("'ajaxUrl'") ||
            content.includes('ajax_var') ||
            content.includes('penci_data') ||
            content.includes('wp.i18n') ||
            content.includes('wp.hooks') ||
            content.includes('wpcf7') ||        // CF7 API root variable
            src.includes('comment-reply') ||
            src.includes('wp-emoji') ||
            src.includes('html5.js') ||
            src.includes('contact-form-7')      // CF7 script (useless without PHP backend)
        ) $(el).remove();
    });

    // Remove WP inline style blocks
    $(
        '#wp-emoji-styles-inline-css,' +
        '#wp-block-library-theme-inline-css,' +
        '#classic-theme-styles-inline-css,' +
        '#global-styles-inline-css,' +
        '#rs-plugin-settings-inline-css,' +
        '#wp-block-library-inline-css'
    ).remove();

    // Remove empty <style> blocks (WP outputs whitespace-only style tags)
    $('style').each((_, el) => {
        if (!($(el).html() || '').trim()) $(el).remove();
    });

    // Remove CF7 stylesheet — no point loading it with the form replaced
    $('link[href*="contact-form-7"]').remove();

    // Remove WP <link> tags that serve no purpose on a static site
    $('link[rel="pingback"]').remove();
    $('link[rel="EditURI"]').remove();
    $('link[rel="wlwmanifest"]').remove();
    $('link[rel="shortlink"]').remove();
    $('link[rel="profile"]').remove();
    $('link[rel="https://api.w.org/"]').remove();
    $('link[type="application/json+oembed"]').remove();
    $('link[type="text/xml+oembed"]').remove();
    $('link[rel="alternate"][type="application/rss+xml"]').remove();
    $('link[rel="alternate"][type="application/atom+xml"]').remove();
    $('link[rel="alternate"][type="application/json"]').remove();
    $('link[rel="dns-prefetch"]').remove();
    $('link[rel="preconnect"]').remove();

    // Remove meta tags that expose server info or are obsolete
    $('meta[name="generator"]').remove();
    $('meta[http-equiv="X-UA-Compatible"]').remove();
}

// ── Neutralize broken dynamic features ──────────────────────────────────────

function neutralizeDynamicFeatures($) {
    // Remove search forms — no PHP backend to query
    $('form[role="search"], form#searchform, form.search-form').remove();

    // Replace Contact Form 7 with a static mailto message
    $('div.wpcf7').each((_, el) => {
        // Try to find a mailto: link or email address near the form
        const emailMatch = ($.html(el) || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        const emailHtml = emailMatch
            ? `<a href="mailto:${emailMatch[0]}">${emailMatch[0]}</a>`
            : 'email us directly';
        $(el).replaceWith(
            `<p style="padding:1em;background:#f5f5f5;border-radius:6px;margin:1em 0">` +
            `To get in touch, please ${emailHtml}.</p>`
        );
    });

    // Remove comment forms — no database backend
    $('#respond, .comment-respond, #commentform').remove();

    // Remove AJAX-dependent widgets
    $('[class*="penci-like"], [class*="post-like"], [class*="ajax-like"]').remove();
    $('[class*="rateyo"], [class*="recipe-rating"], [class*="penci-rating"]').remove();
    $('[class*="penci-ajax-more"], .ajax-load-more, .loadmore-btn').remove();

    // Remove wp-admin / wp-login nav links
    $('a[href*="wp-admin"], a[href*="wp-login"]').closest('li').remove();
}

// ── Fix lazy-loaded images: data-src → src ───────────────────────────────────

function fixLazyImages($) {
    $('img[data-src], img[data-lazy-src], img[data-original]').each((_, el) => {
        const lazySrc =
            $(el).attr('data-src') ||
            $(el).attr('data-lazy-src') ||
            $(el).attr('data-original');
        if (!lazySrc) return;
        $(el).attr('src', lazySrc);
        $(el).removeAttr('data-src').removeAttr('data-lazy-src').removeAttr('data-original');
        const cls = ($(el).attr('class') || '')
            .replace(/\b(penci-lazy|lazy|lazyload|lazyloaded)\b/g, '')
            .trim();
        if (cls) $(el).attr('class', cls);
        else $(el).removeAttr('class');
    });
}

// ── Rewrite all remaining absolute same-domain URLs ──────────────────────────

function rewriteAbsoluteUrls($, pageUrl, htmlDir, jobDir) {
    const u = new URL(pageUrl);
    const origin = u.origin;
    const hostname = u.hostname;

    // Relative path prefix from the HTML file to the assets/hostname dir
    // e.g. for index.html at root: "assets/tspasia.org/"
    // e.g. for services/contact.html one level deep: "../assets/tspasia.org/"
    const assetsRelPrefix =
        path.relative(htmlDir, path.join(jobDir, 'assets', hostname)).split(path.sep).join('/') + '/';

    const REWRITE_ATTRS = [
        'href', 'src', 'content', 'action',
        'data-src', 'data-href', 'data-lazy-src', 'data-original',
        'data-thumb', 'data-link',
    ];

    $('[href],[src],[content],[action],[data-src],[data-href],[data-lazy-src],[data-original],[data-thumb],[data-link]').each((_, el) => {
        REWRITE_ATTRS.forEach(attr => {
            let val = $(el).attr(attr);
            if (!val) return;
            // Absolute URL: https://hostname/path → root-relative /path
            if (val.startsWith(origin + '/') || val === origin) {
                $(el).attr(attr, val.slice(origin.length) || '/');
            // Protocol-relative: //hostname/path → root-relative /path
            } else if (val.startsWith('//' + hostname + '/')) {
                $(el).attr(attr, val.slice(('//' + hostname).length));
            }
        });
    });

    // Rewrite inline <script> blocks (NOT JSON-LD — those keep absolute URLs for SEO)
    $('script:not([src])').each((_, el) => {
        const type = ($(el).attr('type') || '').toLowerCase();
        if (type === 'application/ld+json') return; // keep structured data as-is

        let code = $(el).html();
        if (!code) return;
        let changed = false;

        // Absolute https://hostname/path → relative assets/hostname/path
        if (code.includes(origin + '/')) {
            code = code.split(origin + '/').join(assetsRelPrefix);
            changed = true;
        }
        // Protocol-relative //hostname/path → relative assets/hostname/path
        if (code.includes('//' + hostname + '/')) {
            code = code.split('//' + hostname + '/').join(assetsRelPrefix);
            changed = true;
        }
        if (changed) $(el).html(code);
    });

    // Rewrite absolute URLs in inline style attributes
    $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        if (style.includes(origin)) {
            $(el).attr('style', style.split(origin).join(''));
        }
    });
}

// ── Inject / fix SEO metadata ─────────────────────────────────────────────────

function fixSeoMetadata($, pageUrl, savePath) {
    const origin = new URL(pageUrl).origin;
    const rootRelative = savePath === 'index.html' ? '/' : '/' + savePath;

    // Fix or inject canonical
    const canonEl = $('link[rel="canonical"]');
    if (canonEl.length) {
        canonEl.attr('href', rootRelative);
    } else {
        $('head').append(`<link rel="canonical" href="${rootRelative}">`);
    }

    // Fix og:url
    $('meta[property="og:url"]').attr('content', origin + rootRelative);

    // Fix og:image and twitter:image — strip live domain so they become root-relative
    $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
        const content = $(el).attr('content') || '';
        if (content.startsWith(origin)) {
            $(el).attr('content', content.slice(origin.length));
        }
    });

    // Inject missing meta description
    if (!$('meta[name="description"]').length) {
        const desc = $('main p, article p, .entry-content p, .elementor-text-editor p, body p')
            .filter((_, el) => $(el).text().trim().length > 50)
            .first()
            .text()
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 155);
        if (desc) {
            $('head').append(`<meta name="description" content="${desc.replace(/"/g, '&quot;')}">`);
        }
    }

    // Inject missing meta robots
    if (!$('meta[name="robots"]').length) {
        $('head').append('<meta name="robots" content="index, follow">');
    }
}

// ── Performance tweaks ───────────────────────────────────────────────────────

function applyPerformanceTweaks($) {
    // Defer non-critical scripts in <head> — but NOT jQuery/migrate,
    // because inline scripts in the body call jQuery(function(){...}) synchronously
    const SKIP_DEFER = new Set(['jquery-core-js', 'jquery-migrate-js']);
    $('head script[src]').each((_, el) => {
        const id = $(el).attr('id') || '';
        if (!SKIP_DEFER.has(id) && !$(el).attr('defer') && !$(el).attr('async'))
            $(el).attr('defer', '');
    });

    // Add loading attribute to images (eager for first/LCP, lazy for rest)
    let isFirst = true;
    $('img').each((_, el) => {
        if (!$(el).attr('loading')) {
            $(el).attr('loading', isFirst ? 'eager' : 'lazy');
            isFirst = false;
        }
    });
}

// ── Mirror a single page ─────────────────────────────────────────────────────

async function mirrorPage(pageUrl, jobDir, log, skips) {
    const base = new URL(pageUrl);
    log(`Fetching ${pageUrl}`);

    const { data: htmlText } = await httpClient.get(pageUrl, { responseType: 'text' });

    // Strip IE conditional comments — cheerio can't see tags inside them,
    // so scripts/links within are invisible to our cleanup code
    const cleanedHtml = htmlText.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '');

    const $ = cheerio.load(cleanedHtml);

    // Remove SRI integrity — hashes won't match local copies
    $('script[integrity], link[integrity]').each((_, el) => {
        $(el).removeAttr('integrity').removeAttr('crossorigin');
    });

    const { savePath, htmlOut } = pageHtmlPath(pageUrl, jobDir);
    const htmlDir = path.dirname(htmlOut);

    // All asset selectors — including lazy-load and downloadable file types
    const selectors = [
        { sel: 'link[href]',           attr: 'href' },
        { sel: 'script[src]',          attr: 'src' },
        { sel: 'img[src]',             attr: 'src' },
        { sel: '[data-src]',           attr: 'data-src' },       // any element (img, a, div) with lazy-load
        { sel: '[data-lazy-src]',      attr: 'data-lazy-src' },
        { sel: '[data-original]',      attr: 'data-original' },
        { sel: 'source[src]',          attr: 'src' },
        { sel: 'video[src]',           attr: 'src' },
        { sel: 'video[poster]',        attr: 'poster' },
        { sel: 'audio[src]',           attr: 'src' },
        { sel: 'a[href$=".pdf"]',      attr: 'href' },
        { sel: 'a[href$=".doc"]',      attr: 'href' },
        { sel: 'a[href$=".docx"]',     attr: 'href' },
        { sel: 'a[href$=".xls"]',      attr: 'href' },
        { sel: 'a[href$=".xlsx"]',     attr: 'href' },
        { sel: 'a[href$=".ppt"]',      attr: 'href' },
        { sel: 'a[href$=".pptx"]',     attr: 'href' },
        { sel: 'a[href$=".zip"]',      attr: 'href' },
        { sel: 'a[href$=".mp4"]',      attr: 'href' },
        { sel: 'a[href$=".mp3"]',      attr: 'href' },
        { sel: '[data-thumb]',         attr: 'data-thumb' },  // RevSlider thumbnails
        { sel: '[data-link]',          attr: 'data-link' },   // RevSlider slide links (PDFs etc.)
    ];

    const downloaded = new Map();

    for (const { sel, attr } of selectors) {
        for (const el of $(sel).toArray()) {
            const ref = $(el).attr(attr);
            if (!ref || ref.startsWith('data:')) continue;

            let abs;
            try { abs = new URL(ref, base.href).href; } catch { continue; }

            // For downloadable file links and slide links: only download same-origin files
            const isDownloadableLink = sel.startsWith('a[href$=') || sel === '[data-link]';
            if (isDownloadableLink && new URL(abs).origin !== base.origin) continue;

            if (!downloaded.has(abs)) {
                try {
                    const { destPath, contentType } = await downloadAsset(abs, jobDir, log, skips);
                    downloaded.set(abs, destPath);

                    const isCss = contentType.includes('css') || /\.css(\?|$)/i.test(abs);
                    const isJs = (contentType.includes('javascript') || /\.js(\?|$)/i.test(abs)) &&
                                 !abs.includes('.min.') && !abs.includes('-min.');

                    if (isCss) {
                        try {
                            let css = fs.readFileSync(destPath, 'utf8');
                            css = await processCssAndMinify(css, abs, destPath, jobDir, log, skips);
                            fs.writeFileSync(destPath, css);
                        } catch { /* skip */ }
                    } else if (isJs) {
                        try {
                            const jsContent = fs.readFileSync(destPath, 'utf8');
                            const result = await terserMinify(jsContent, { compress: true, mangle: true });
                            if (result.code) fs.writeFileSync(destPath, result.code);
                        } catch { /* skip minification, keep original */ }
                    }
                } catch (err) {
                    skips.push({ url: abs, reason: err.message, context: `asset on ${pageUrl}` });
                    continue;
                }
            }

            const rel = path.relative(htmlDir, downloaded.get(abs)).split(path.sep).join('/');
            $(el).attr(attr, rel);
        }
    }

    // Download assets referenced in inline style url() and rewrite the attribute
    const inlineStyleItems = [];
    $('[style]').each((_, el) => {
        const style = $(el).attr('style') || '';
        const urlRegex = /url\(['"]?([^'")\s]+)['"]?\)/g;
        let match;
        while ((match = urlRegex.exec(style)) !== null) {
            const ref = match[1].trim();
            if (!ref || ref.startsWith('data:')) continue;
            let abs;
            try { abs = new URL(ref, base.href).href; } catch { continue; }
            inlineStyleItems.push({ el, original: ref, abs });
        }
    });
    for (const item of inlineStyleItems) {
        if (!downloaded.has(item.abs)) {
            try {
                const { destPath } = await downloadAsset(item.abs, jobDir, log, skips);
                downloaded.set(item.abs, destPath);
            } catch (err) {
                skips.push({ url: item.abs, reason: err.message, context: `inline style on ${pageUrl}` });
                continue;
            }
        }
        const rel = path.relative(htmlDir, downloaded.get(item.abs)).split(path.sep).join('/');
        const currentStyle = $(item.el).attr('style') || '';
        $(item.el).attr('style', currentStyle.split(item.original).join(rel));
    }

    $('base').remove();

    // ── SEO + Cleanliness Pipeline ───────────────────────────────────────────
    cleanWordPressJunk($);
    neutralizeDynamicFeatures($);
    fixLazyImages($);
    rewriteAbsoluteUrls($, pageUrl, htmlDir, jobDir);
    fixSeoMetadata($, pageUrl, savePath);
    applyPerformanceTweaks($);

    fs.mkdirSync(htmlDir, { recursive: true });
    fs.writeFileSync(htmlOut, $.html());
    log(`Saved ${savePath}`);

    return savePath;
}

// ── Rewrite cross-page <a href> links after all pages are downloaded ──────────

function canonicalUrl(href, base) {
    const u = new URL(href, base);
    let p = u.pathname.replace(/\/$/, '');
    const ext = path.extname(p).toLowerCase();
    if (CANONICAL_STRIP_EXTS.has(ext)) p = p.slice(0, -ext.length);
    return u.origin + p + u.search;
}

async function rewritePageLinks(downloadedPages, siteOrigin, jobDir, log) {
    const urlToHtmlPath = new Map();
    for (const { url, savePath } of downloadedPages) {
        const diskPath = path.join(jobDir, savePath);
        urlToHtmlPath.set(canonicalUrl(url, url), diskPath);
        const u = new URL(url);
        if (u.pathname === '/' || u.pathname === '') {
            urlToHtmlPath.set(u.origin + '/index', diskPath);
            urlToHtmlPath.set(u.origin + '/index.php', diskPath);
            urlToHtmlPath.set(u.origin + '/index.html', diskPath);
        }
    }

    // Pass 1: collect link-text → disk path from pages that have real hrefs
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
                if (text && text.length < 60 && !textToPath.has(text))
                    textToPath.set(text, urlToHtmlPath.get(key));
            });
        } catch { /* skip */ }
    }

    log(`textToPath has ${textToPath.size} entries`);

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
                if (absUrl.origin !== siteOrigin) return;

                const fragment = absUrl.hash || '';
                const key = canonicalUrl(absUrl.href, absUrl.href);

                if (urlToHtmlPath.has(key)) {
                    const targetDisk = urlToHtmlPath.get(key);
                    let rel = path.relative(htmlDir, targetDisk).split(path.sep).join('/');
                    if (fragment) rel += fragment;
                    $(el).attr('href', rel);
                } else {
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

// ── Delete junk files (feed pages, duplicate HTML mirrors in assets/) ─────────

function deleteJunkFiles(jobDir, log) {
    function walkAndClean(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            if (entry.name === 'feed' || entry.name === 'atom') {
                fs.rmSync(full, { recursive: true, force: true });
                log(`  deleted feed dir: ${path.relative(jobDir, full)}`);
            } else {
                walkAndClean(full);
            }
        }
    }
    walkAndClean(jobDir);

    // Delete index.html page mirrors inside assets/hostname/ (not under wp-content/wp-includes)
    const assetsHostDir = path.join(jobDir, 'assets');
    if (!fs.existsSync(assetsHostDir)) return;

    function deletePageMirrors(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                deletePageMirrors(full);
            } else if (entry.name === 'index.html') {
                const rel = path.relative(jobDir, full).split(path.sep).join('/');
                if (!rel.includes('wp-content') && !rel.includes('wp-includes')) {
                    fs.unlinkSync(full);
                    log(`  deleted page mirror: ${rel}`);
                }
            }
        }
    }

    for (const host of fs.readdirSync(assetsHostDir, { withFileTypes: true })) {
        if (host.isDirectory()) deletePageMirrors(path.join(assetsHostDir, host.name));
    }
}

// ── Generate sitemap.xml ─────────────────────────────────────────────────────

function generateSitemap(downloadedPages, jobDir, log) {
    const urlEntries = downloadedPages.map(({ url }) =>
        `  <url>\n    <loc>${url}</loc>\n    <changefreq>monthly</changefreq>\n  </url>`
    ).join('\n');

    const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `${urlEntries}\n` +
        `</urlset>`;

    fs.writeFileSync(path.join(jobDir, 'sitemap.xml'), xml);
    log('Generated sitemap.xml');
}

// ── Download or generate robots.txt ──────────────────────────────────────────

async function generateRobotsTxt(siteOrigin, jobDir, log) {
    let content = '';
    try {
        const r = await httpClient.get(`${siteOrigin}/robots.txt`, { responseType: 'text' });
        content = r.data || '';
        log('Downloaded robots.txt from live site');
    } catch {
        content = 'User-agent: *\nAllow: /\n';
        log('Generated robots.txt (live site had none)');
    }
    // Remove any existing Sitemap: lines (may point to old WP sitemap) and add ours
    content = content.split('\n').filter(l => !l.trim().toLowerCase().startsWith('sitemap:')).join('\n');
    content += '\nSitemap: /sitemap.xml\n';
    fs.writeFileSync(path.join(jobDir, 'robots.txt'), content.trim() + '\n');
}

// ── Download selected pages ───────────────────────────────────────────────────

app.post('/api/download', async (req, res) => {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0)
        return res.status(400).json({ error: 'Provide at least one URL to download.' });

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
    const downloadedPages = [];

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

    if (downloadedPages.length > 0) {
        log('── Rewriting page links…');
        const siteOrigin = new URL(urls[0]).origin;
        const seen = new Set();
        const uniquePages = downloadedPages.filter(p => {
            if (seen.has(p.savePath)) return false;
            seen.add(p.savePath);
            return true;
        });
        await rewritePageLinks(uniquePages, siteOrigin, jobDir, log);

        log('── Cleaning up junk files…');
        deleteJunkFiles(jobDir, log);

        log('── Generating sitemap.xml and robots.txt…');
        generateSitemap(uniquePages, jobDir, log);
        await generateRobotsTxt(siteOrigin, jobDir, log);
    }

    const relative = path.relative(downloadsRoot, jobDir).split(path.sep).join('/');
    const sitemapUrl = `/mirrors/${relative}/sitemap.xml`;
    const robotsUrl = `/mirrors/${relative}/robots.txt`;

    send('done', { results, skips: allSkips, sitemapUrl, robotsUrl });
    res.end();
});

app.listen(port, () => {
    console.log(`URL-to-HTML web app running on http://localhost:${port}`);
});
