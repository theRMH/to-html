const skipsSection = document.getElementById('skips-section');
const skipsList = document.getElementById('skips-list');
const discoverForm = document.getElementById('discover-form');
const pageSelection = document.getElementById('page-selection');
const pageList = document.getElementById('page-list');
const selectAllCheckbox = document.getElementById('select-all');
const downloadBtn = document.getElementById('download-btn');
const statusMessage = document.getElementById('status-message');
const resultsSection = document.getElementById('results-section');
const resultsList = document.getElementById('results-list');
const logOutput = document.getElementById('log-output');

const MAX_LOG_LINES = 15;
let logLines = [];

function appendLog(msg) {
    logLines.push(msg);
    if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES);
    logOutput.textContent = logLines.join('\n');
}

function clearLog() {
    logLines = [];
    logOutput.textContent = '';
}

// ── Step 1: Discover pages ───────────────────────────────────────────────────

discoverForm.addEventListener('submit', async e => {
    e.preventDefault();
    const url = discoverForm.url.value.trim();
    const btn = discoverForm.querySelector('button');

    pageSelection.hidden = true;
    resultsSection.hidden = true;
    pageList.innerHTML = '';
    resultsList.innerHTML = '';
    clearLog();
    statusMessage.textContent = 'Scanning for pages…';
    btn.disabled = true;

    try {
        const res = await fetch('/api/crawl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (!res.ok) {
            statusMessage.textContent = data.error || `Error ${res.status}`;
            return;
        }

        statusMessage.textContent = `Found ${data.pages.length} page(s). Select which to download.`;

        data.pages.forEach(({ href, label }) => {
            const row = document.createElement('label');
            row.className = 'page-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = href;
            cb.checked = true;
            const text = document.createElement('span');
            text.textContent = `${label}  `;
            const small = document.createElement('small');
            small.textContent = href;
            row.append(cb, text, small);
            pageList.appendChild(row);
        });

        selectAllCheckbox.checked = true;
        pageSelection.hidden = false;
    } catch (err) {
        statusMessage.textContent = `Request failed: ${err.message}`;
    } finally {
        btn.disabled = false;
    }
});

// Select all toggle
selectAllCheckbox.addEventListener('change', () => {
    pageList.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
    });
});

// ── Step 2: Download selected ─────────────────────────────────────────────────

downloadBtn.addEventListener('click', async () => {
    const selected = [...pageList.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
    if (selected.length === 0) {
        statusMessage.textContent = 'Select at least one page.';
        return;
    }

    resultsSection.hidden = true;
    resultsList.innerHTML = '';
    skipsSection.hidden = true;
    skipsList.innerHTML = '';
    clearLog();
    statusMessage.textContent = `Downloading ${selected.length} page(s)…`;
    downloadBtn.disabled = true;

    try {
        const response = await fetch('/api/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: selected })
        });

        if (!response.ok) {
            const data = await response.json();
            statusMessage.textContent = data.error || `Error ${response.status}`;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                let event;
                try { event = JSON.parse(line.slice(6)); } catch { continue; }

                if (event.type === 'log') {
                    appendLog(event.message);
                } else if (event.type === 'done') {
                    const succeeded = event.results.filter(r => r.success);
                    const failed = event.results.filter(r => !r.success);
                    const skips = event.skips || [];
                    statusMessage.textContent =
                        `Done. ${succeeded.length} succeeded, ${failed.length} failed, ${skips.length} asset(s) skipped.`;

                    if (succeeded.length > 0) {
                        resultsSection.hidden = false;
                        succeeded.forEach(r => {
                            const li = document.createElement('li');
                            li.innerHTML = `<a href="${r.siteUrl}" target="_blank" rel="noreferrer">${r.url}</a>`;
                            resultsList.appendChild(li);
                        });

                        // Show sitemap and robots.txt links
                        if (event.sitemapUrl || event.robotsUrl) {
                            const sep = document.createElement('li');
                            sep.style.cssText = 'list-style:none;margin-top:.75em;padding-top:.75em;border-top:1px solid #ddd;font-size:.85em;color:#555';
                            sep.textContent = 'Generated files:';
                            resultsList.appendChild(sep);
                        }
                        if (event.sitemapUrl) {
                            const li = document.createElement('li');
                            li.innerHTML = `<a href="${event.sitemapUrl}" target="_blank" rel="noreferrer">sitemap.xml</a>`;
                            resultsList.appendChild(li);
                        }
                        if (event.robotsUrl) {
                            const li = document.createElement('li');
                            li.innerHTML = `<a href="${event.robotsUrl}" target="_blank" rel="noreferrer">robots.txt</a>`;
                            resultsList.appendChild(li);
                        }
                    }

                    if (failed.length > 0) {
                        failed.forEach(r => appendLog(`✗ ${r.url}: ${r.error}`));
                    }

                    if (skips.length > 0) {
                        skipsSection.hidden = false;
                        skips.forEach(s => {
                            const row = document.createElement('div');
                            row.className = 'skip-row';
                            row.innerHTML =
                                `<span class="skip-url">${s.url}</span>` +
                                `<span class="skip-reason">${s.reason}</span>` +
                                `<span class="skip-context">${s.context}</span>`;
                            skipsList.appendChild(row);
                        });
                    }
                } else if (event.type === 'error') {
                    statusMessage.textContent = `Error: ${event.message}`;
                }
            }
        }
    } catch (err) {
        statusMessage.textContent = `Request failed: ${err.message}`;
    } finally {
        downloadBtn.disabled = false;
    }
});
