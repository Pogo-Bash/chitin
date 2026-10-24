// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The devtools panel's Console and Network tabs. Everything a segment sends here is data: it is shown with textContent only.
//
// Console: every error the layers report, each labelled with the layer it came from, so a Chitin bug is told apart from the
// page's own error:
//   Chitin · engine    a wasm trap or VERIFY in LibWeb/Ganglion (always ours)
//   Chitin · glue      thrown from Chitin's own JS (worker.js, ganglion-engine.js, pagesw*.js, rtc/eme): ours
//   Chitin · carapace  this page (the host side), the segment guard, the compositor
//   Page · script      thrown with the page's own code on top of the stack: the site's, unless Chrome runs it cleanly
//   Page · sw          the same, in the page's service worker
//   Host Chrome        the host browser refused something (permissions, fullscreen, WebGL); Chrome's own GPU messages
//                      (e.g. GL_INVALID_*) only reach Chrome's DevTools console and cannot be read from here
// A page error is not proven Chrome-clean: "open in your browser" and compare.
// Network: the page's own Resource and Navigation Timing entries from the engine, plus the engine's connection totals.
(() => {
    const $ = (id) => document.getElementById(id);
    const dev = $('devtools');
    const paneVisible = (name) => !dev.classList.contains('collapsed') && !dev.querySelector(`.pane[data-pane="${name}"]`).hidden;
    let nextId = 1;
    const waiting = new Map();
    function ask(op, extra) {
        const id = nextId++;
        return new Promise((resolve) => {
            waiting.set(id, resolve);
            setTimeout(() => { if (waiting.delete(id)) resolve({ error: 'no answer from the segment (it may have stopped)' }); }, 5000);
            window.dispatchEvent(new CustomEvent('chitin-devtools', { detail: { id, op, ...extra } }));
        });
    }
    window.addEventListener('chitin-devtools-reply', (e) => {
        const r = waiting.get(e.detail.id);
        if (!r)
            return;
        waiting.delete(e.detail.id);
        let v;
        try { v = JSON.parse(e.detail.json); } catch { v = { error: 'unreadable answer' }; }
        r(v);
    });
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls)
            n.className = cls;
        if (text !== undefined)
            n.textContent = text;
        return n;
    };

    // --- Console ---------------------------------------------------------------------------------
    const log = $('console-log');
    const badge = $('console-badge');
    let filter = 'all';
    let unseen = 0;
    const CHITIN_FILE = /\/chitin\/(ganglion-engine|worker|segment|pagesw|pagesw-host|rtc|rtc-host|eme|eme-host|spiracle)\.js|\/carapace\//;
    // A trap or failed VERIFY. A ganglion.wasm frame alone is not one: page code the engine calls (a handler, a promise
    // job) has engine frames under it, and its own TypeError is still the page's.
    const ENGINE = /^\s*(Uncaught )?RuntimeError\b|\bRuntimeError: |unreachable executed|\bunreachable\b.*ganglion|memory access out of bounds|VERIFICATION FAILED|ak_verification_failed|the engine stopped|Maximum call stack size exceeded.*ganglion/s;
    function firstFrame(text) {
        const m = /\n\s+at (?:.*?\()?((?:https?|blob):[^\s)]+)/.exec('\n' + text) || /@((?:https?|blob):[^\s)]+)/.exec(text);
        return m ? m[1] : null;
    }
    // Which layer an error came from, and how sure that is.
    function classify(key, value, origin) {
        const text = String(value);
        if (origin === 'carapace')
            return { cat: 'chitin', label: 'Chitin · carapace', why: 'thrown in the host page (ours)' };
        if (key === 'engine stopped' || ENGINE.test(text))
            return { cat: 'chitin', label: 'Chitin · engine', why: 'a trap or VERIFY in the wasm engine: always a Chitin bug' };
        if (/^segment stopped$|guard|flood|strike/.test(key))
            return { cat: 'chitin', label: 'Chitin · carapace', why: 'the segment guard stopped the segment' };
        if (/fullscreen|pointer|permission|refused by the host/i.test(key + ' ' + text) && /refused|denied|NotAllowed/i.test(text))
            return { cat: 'host', label: 'Host Chrome', why: 'the host browser refused it' };
        const top = firstFrame(text);
        const sw = /service worker|page sw/i.test(key + ' ' + text);
        if (top && CHITIN_FILE.test(top))
            return { cat: 'chitin', label: sw ? 'Chitin · sw glue' : 'Chitin · glue', why: 'thrown from Chitin\'s own code (' + top.replace(/^.*\/(chitin|carapace)\//, '') + ')' };
        if (top)
            return { cat: 'page', label: sw ? 'Page · sw' : 'Page · script', why: 'the page\'s own code threw: compare in Chrome ("open in your browser")' };
        if (/network|cors|fetch|tls|relay|spiracle/i.test(key + ' ' + text))
            return { cat: 'page', label: 'Network', why: 'a request failed: compare in Chrome\'s Network tab' };
        return { cat: sw ? 'page' : 'chitin', label: sw ? 'Page · sw' : 'Chitin · segment', why: 'no stack: reported by the segment' };
    }
    const isError = (key, value) => /error|stopped|trap|fail|rejection|refused|blocked/i.test(key) || /^(FAILED|ERROR)|Error\b|engine stopped|VERIFICATION FAILED|unreachable/.test(String(value));
    function add({ kind, key, value, cls, origin }) {
        const c = cls || classify(key, value, origin);
        const li = el('li', kind);
        li.dataset.cat = c.cat;
        li.append(el('span', 'time', new Date().toLocaleTimeString([], { hour12: false })));
        li.append(el('span', 'src ' + c.cat, c.label));
        const msg = el('div', 'msg');
        const text = (key ? key + ': ' : '') + String(value);
        const nl = text.indexOf('\n');
        if (nl > 0 && text.length > 140) {
            const d = el('details');
            d.append(el('summary', null, text.slice(0, nl)), document.createTextNode(text.slice(nl)));
            msg.append(d);
        } else
            msg.textContent = text;
        if (c.why && kind !== 'cmd' && c.cat !== 'result')
            msg.append(el('div', 'hint', c.why));
        li.append(msg);
        li.hidden = !(filter === 'all' || filter === c.cat);
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
        log.append(li);
        while (log.childElementCount > 2000)
            log.firstElementChild.remove();
        if (atEnd)
            log.scrollTop = log.scrollHeight;
        if (kind === 'err' && !paneVisible('console')) {
            unseen++;
            badge.textContent = String(unseen);
            badge.hidden = false;
        }
    }
    window.addEventListener('chitin-console-note', (e) => {
        add({ kind: 'res', key: '', value: e.detail.text, cls: { cat: 'result', label: e.detail.label } });
        document.querySelector('#devtools .tabs [data-pane="console"]').click();
    });
    // The segments' status rows (carapace.js): errors become console entries; a few lifecycle rows are kept as info.
    const INFO = /^(navigated|navigating|ready|page title|frames)$/;
    window.addEventListener('chitin-status', (e) => {
        const { key, value } = e.detail;
        if (isError(key, value))
            add({ kind: /warn|refused|blocked/i.test(key) ? 'warn' : 'err', key, value });
        else if (INFO.test(key) || /^frame \d+ navigated$/.test(key))
            add({ kind: 'info', key, value, cls: { cat: 'info', label: 'Info' } });
    });
    // The host page's own errors and warnings (ours: the carapace, compositor, spiracle).
    window.addEventListener('error', (e) => add({ kind: 'err', key: 'carapace error', value: e.error && e.error.stack || e.message, origin: 'carapace' }));
    window.addEventListener('unhandledrejection', (e) => add({ kind: 'err', key: 'carapace unhandled rejection', value: e.reason && e.reason.stack || String(e.reason), origin: 'carapace' }));
    for (const level of ['error', 'warn']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            orig(...args);
            try { add({ kind: level === 'error' ? 'err' : 'warn', key: 'carapace console.' + level, value: args.map((a) => a && a.stack || (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '), origin: 'carapace' }); } catch {}
        };
    }
    document.querySelectorAll('#console-filter button').forEach((b) => b.addEventListener('click', () => {
        filter = b.dataset.f;
        document.querySelectorAll('#console-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        for (const li of log.children)
            li.hidden = !(filter === 'all' || filter === li.dataset.cat || li.classList.contains('cmd') || li.dataset.cat === 'result');
    }));
    $('console-clear').addEventListener('click', () => { log.textContent = ''; });
    const input = $('console-input');
    const history = [];
    let hpos = 0;
    $('console-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = input.value;
        if (!code.trim())
            return;
        history.push(code);
        hpos = history.length;
        input.value = '';
        add({ kind: 'cmd', key: '', value: '› ' + code, cls: { cat: 'result', label: 'you' } });
        const r = await ask('eval', { code });
        if (r.error)
            add({ kind: 'err', key: '', value: r.error, cls: { cat: 'chitin', label: 'Chitin · carapace' } });
        else
            add({ kind: r.ok ? 'res' : 'err', key: '', value: r.text, cls: r.ok ? { cat: 'result', label: 'page' } : { cat: 'page', label: 'Page · thrown' } });
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' && hpos > 0) { input.value = history[--hpos]; e.preventDefault(); }
        else if (e.key === 'ArrowDown') { hpos = Math.min(history.length, hpos + 1); input.value = history[hpos] || ''; e.preventDefault(); }
    });

    $('reset-site').addEventListener('click', () => {
        if (confirm('Reset this site? Its cookies, storage, IndexedDB, OPFS, caches and service workers in Chitin are cleared, and it loads as a first visit.'))
            window.dispatchEvent(new CustomEvent('chitin-reset-site'));
    });

    // --- Network ---------------------------------------------------------------------------------
    const tbody = document.querySelector('#net-table tbody');
    const detail = $('net-detail');
    const netFilter = $('net-filter');
    let netType = 'all';
    let entries = [];
    let selected = null;
    const TYPE = (en) => {
        const t = en.type || '';
        const ct = en.contentType || '';
        if (t === 'document' || t === 'iframe' || t === 'frame') return 'document';
        if (t === 'script' || /javascript|ecmascript/.test(ct)) return 'script';
        if (t === 'css' || t === 'link' && /css/.test(ct) || /text\/css/.test(ct)) return 'css';
        if (t === 'img' || t === 'image' || /^image\//.test(ct)) return 'img';
        if (t === 'fetch' || t === 'xmlhttprequest' || t === 'beacon') return 'fetch';
        if (t === 'video' || t === 'audio' || /^(video|audio)\//.test(ct)) return 'media';
        return 'other';
    };
    const size = (n) => !(n > 0) ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' kB' : (n / 1048576).toFixed(2) + ' MB';
    const ms = (n) => !(n >= 0) ? '—' : n < 1000 ? Math.round(n) + ' ms' : (n / 1000).toFixed(2) + ' s';
    function nameCell(url) {
        const td = el('td');
        try {
            const u = new URL(url);
            const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
            td.append(document.createTextNode(file + (u.search ? u.search.slice(0, 40) : '')), el('span', 'host', '  ' + u.host));
        } catch {
            td.textContent = url;
        }
        td.title = url;
        return td;
    }
    function render() {
        const q = netFilter.value.trim().toLowerCase();
        const shown = entries.filter((en) => (netType === 'all' || TYPE(en) === netType) && (!q || en.name.toLowerCase().includes(q)));
        const end = Math.max(1, ...entries.map((en) => en.start + en.duration));
        tbody.textContent = '';
        for (const en of shown) {
            const tr = el('tr');
            if (en.status >= 400 || en.status === 0 && en.type !== 'document' && en.transfer === 0 && en.decoded === 0)
                tr.classList.add('bad');
            if (selected && selected.name === en.name && selected.start === en.start)
                tr.classList.add('sel');
            tr.append(nameCell(en.name), el('td', null, en.status ? String(en.status) : en.transfer === 0 && en.decoded > 0 ? '(cache)' : '—'),
                el('td', null, TYPE(en)), el('td', null, en.protocol || '—'), el('td', 'num', en.transfer > 0 ? size(en.transfer) : en.decoded > 0 ? '(cache) ' + size(en.decoded) : '—'),
                el('td', 'num', ms(en.duration)));
            const wf = el('td', 'wf');
            const bar = el('div', 'bar');
            const pct = (t) => (100 * t / end).toFixed(3) + '%';
            const ttfbStart = en.start + Math.max(0, en.duration - en.download - Math.max(0, en.ttfb));
            const parts = [['wait', en.start, Math.max(0, ttfbStart - en.start)], ['ttfb', ttfbStart, Math.max(0, en.ttfb)], ['dl', en.start + en.duration - Math.max(0, en.download), Math.max(0.5, en.download)]];
            for (const [c, a, w] of parts) {
                const i = el('i', c);
                i.style.left = pct(a);
                i.style.width = `max(1px, ${pct(w)})`;
                bar.append(i);
            }
            wf.append(bar);
            tr.append(wf);
            tr.addEventListener('click', () => { selected = en; render(); showDetail(en); });
            tbody.append(tr);
        }
        const bytes = entries.reduce((a, en) => a + (en.transfer > 0 ? en.transfer : 0), 0);
        $('net-summary').textContent = `${shown.length} / ${entries.length} requests · ${size(bytes)} transferred` + (totals ? ` · engine: ${totals.connections} connections, ${totals.tlsHandshakes} TLS handshakes, ${totals.failures} failed` : '');
    }
    function showDetail(en) {
        detail.hidden = false;
        detail.textContent = '';
        detail.append(el('h3', null, en.name));
        const dl = el('dl');
        const row = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)); };
        row('status', en.status ? String(en.status) : '—');
        row('type', `${TYPE(en)} (initiator: ${en.type || '—'})`);
        row('content type', en.contentType || '—');
        row('protocol', en.protocol || '—');
        row('transferred', size(en.transfer));
        row('body (encoded / decoded)', `${size(en.encoded)} / ${size(en.decoded)}`);
        row('render blocking', en.renderBlocking || '—');
        detail.append(dl);
        detail.append(el('h3', null, 'Timing'));
        const tl = el('dl');
        const trow = (k, v) => { tl.append(el('dt', null, k), el('dd', null, v)); };
        trow('started at', ms(en.start));
        trow('DNS', ms(en.dns));
        trow('connect', ms(en.connect));
        trow('TLS', ms(en.tls));
        trow('waiting (TTFB)', ms(en.ttfb));
        trow('download', ms(en.download));
        trow('total', ms(en.duration));
        detail.append(tl);
        detail.append(el('div', 'muted', 'From the page\'s own Resource Timing (as Chrome\'s performance API reports it). Headers are not recorded yet.'));
    }
    let totals = null;
    let pageUrl = null;
    async function poll() {
        if (!paneVisible('network'))
            return;
        const r = await ask('net');
        if (r.error) {
            $('net-summary').textContent = r.error;
            return;
        }
        if (r.url !== pageUrl) {
            pageUrl = r.url;
            selected = null;
            detail.hidden = true;
        }
        entries = r.entries || [];
        totals = r.totals;
        render();
    }
    setInterval(poll, 1000);
    netFilter.addEventListener('input', render);
    document.querySelectorAll('#net-types button').forEach((b) => b.addEventListener('click', () => {
        netType = b.dataset.t;
        document.querySelectorAll('#net-types button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        render();
    }));
    dev.querySelectorAll('.tabs [role=tab]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.pane === 'console') {
            unseen = 0;
            badge.hidden = true;
        }
        if (b.dataset.pane === 'network')
            poll();
    }));
})();

// --- The context menu over the page, and the clipboard between the page and the host ----------------
// Chrome's own menu acts on the carapace, not on the page Chitin shows; this one acts on the page (through the same devtools
// channel: an expression in the page's realm). Copy goes to the host clipboard from the page's selection; paste inserts the
// host clipboard's text at the page's focus.
(() => {
    const tab = document.getElementById('tab');
    let nextId = 500000;
    const ask = (op, code) => new Promise((resolve) => {
        const id = nextId++;
        const h = (e) => {
            if (e.detail.id !== id)
                return;
            removeEventListener('chitin-devtools-reply', h);
            let v;
            try { v = JSON.parse(e.detail.json); } catch { v = { error: 'unreadable answer' }; }
            resolve(v);
        };
        addEventListener('chitin-devtools-reply', h);
        setTimeout(() => { removeEventListener('chitin-devtools-reply', h); resolve({ error: 'no answer from the segment' }); }, 5000);
        dispatchEvent(new CustomEvent('chitin-devtools', { detail: { id, op, code } }));
    });
    const evalText = async (code) => { const r = await ask('eval', code); return r && r.ok ? r.text : null; };
    const toast = (text) => {
        const t = document.createElement('div');
        t.className = 'chitin-toast';
        t.textContent = text;
        document.body.append(t);
        setTimeout(() => t.remove(), 1800);
    };
    async function copySelection() {
        const text = await evalText('(() => { const a = document.activeElement; if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && typeof a.selectionStart === "number") return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection()); })()');
        if (!text) {
            toast('nothing selected in the page');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            toast(`copied ${text.length} characters`);
        } catch (err) {
            toast('the host refused the clipboard: ' + err.message);
        }
    }
    async function paste() {
        let text;
        try {
            text = await navigator.clipboard.readText();
        } catch (err) {
            toast('the host refused the clipboard: ' + err.message);
            return;
        }
        const r = await evalText(`(() => { const t = ${JSON.stringify(text)}; const a = document.activeElement;
            if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && typeof a.selectionStart === "number") {
                const s = a.selectionStart, e = a.selectionEnd; a.value = a.value.slice(0, s) + t + a.value.slice(e); a.selectionStart = a.selectionEnd = s + t.length;
                a.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: t })); return "pasted";
            }
            if (a && a.isContentEditable && document.execCommand && document.execCommand("insertText", false, t)) return "pasted";
            return "no text field has the focus"; })()`);
        toast(r || 'paste failed');
    }
    // Cmd/Ctrl+C and Cmd/Ctrl+V on the view also use the host clipboard (the key still goes to the page, as in Chrome).
    tab.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey)
            return;
        if (e.key === 'c' || e.key === 'C')
            copySelection();
        else if (e.key === 'v' || e.key === 'V')
            paste();
    }, true);

    const menu = document.createElement('div');
    menu.id = 'ctxmenu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.tabIndex = -1;
    menu.addEventListener('keydown', (e) => {
        const items = [...menu.querySelectorAll('button:not(:disabled)')];
        if (!items.length)
            return;
        const i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
            items[n].focus();
        }
    });
    document.body.append(menu);
    const close = () => { menu.hidden = true; };
    addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) close(); }, true);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    addEventListener('blur', close);
    function showSource(kind, r) {
        const text = kind === 'dom' ? r.dom : r.source;
        if (!text) {
            toast(kind === 'dom' ? 'no document' : 'no source kept for this page');
            return;
        }
        const head = kind === 'dom'
            ? `<!-- Chitin: the live DOM of ${r.url || 'the page'} as the engine has it now (document.documentElement.outerHTML) -->\n`
            : `<!-- Chitin: ${r.url} as the engine got it from ${r.via} (${r.type}) -->\n`;
        const w = open(URL.createObjectURL(new Blob([head + text], { type: 'text/plain;charset=utf-8' })), '_blank');
        if (!w)
            toast('the host blocked the new tab');
    }
    function item(label, action, opts = {}) {
        if (label === '-') {
            menu.append(Object.assign(document.createElement('hr'), {}));
            return;
        }
        const b = document.createElement('button');
        b.setAttribute('role', 'menuitem');
        b.textContent = label;
        if (opts.hint) {
            const k = document.createElement('kbd');
            k.textContent = opts.hint;
            b.append(k);
        }
        b.disabled = !!opts.disabled;
        b.addEventListener('click', () => { close(); action(); });
        menu.append(b);
    }
    tab.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        const sx = tab.clientWidth / r.width, sy = tab.clientHeight / r.height;
        const x = Math.round((e.clientX - r.left) * sx), y = Math.round((e.clientY - r.top) * sy);
        const info = await ask('eval', `JSON.stringify((() => { const el = document.elementFromPoint(${x}, ${y}); const a = el && el.closest && el.closest("a[href]"); const img = el && el.closest && el.closest("img");
            return { link: a ? a.href : null, img: img ? (img.currentSrc || img.src) : null, sel: String(getSelection()).length, history: history.length,
                tag: el ? el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") : null, editable: !!(el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) }; })())`);
        let at = {};
        try { at = info && info.ok ? JSON.parse(info.text) : {}; } catch {}
        menu.textContent = '';
        item('Back', () => evalText('history.back()'), { hint: '⌘[', disabled: !(at.history > 1) });
        item('Forward', () => evalText('history.forward()'), { hint: '⌘]' });
        item('Reload', () => evalText('location.reload()'), { hint: '⌘R' });
        item('-');
        if (at.link) {
            item('Open link in Chitin', () => evalText(`location.href = ${JSON.stringify(at.link)}`));
            item('Open link in your browser', () => open(at.link, '_blank', 'noopener'));
            item('Copy link address', async () => { await navigator.clipboard.writeText(at.link).then(() => toast('link copied'), (err) => toast(err.message)); });
            item('-');
        }
        if (at.img) {
            item('Copy image address', async () => { await navigator.clipboard.writeText(at.img).then(() => toast('image address copied'), (err) => toast(err.message)); });
            item('Open image in your browser', () => open(at.img, '_blank', 'noopener'));
            item('-');
        }
        item('Copy', copySelection, { hint: '⌘C', disabled: !at.sel && !at.editable });
        item('Paste', paste, { hint: '⌘V', disabled: !at.editable });
        item('Select all', () => evalText('(() => { const a = document.activeElement; if (a && a.select) a.select(); else getSelection().selectAllChildren(document.body); })()'), { hint: '⌘A' });
        item('-');
        item('View page source', async () => showSource('source', await ask('source')), { hint: '⌥⌘U' });
        item('View live DOM', async () => showSource('dom', await ask('source')));
        item('Inspect', async () => {
            const v = await evalText(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return "nothing at ${x},${y}"; const cs = getComputedStyle(el); const b = el.getBoundingClientRect();
                return el.outerHTML.slice(0, 600) + "\\n\\nbox " + [b.x, b.y, b.width, b.height].map(Math.round).join(" ") + " · display " + cs.display + " · position " + cs.position + " · font " + cs.fontSize + " " + cs.fontFamily; })()`);
            dispatchEvent(new CustomEvent('chitin-console-note', { detail: { label: 'Inspect', text: `${at.tag || 'element'} at ${x},${y}\n` + (v || 'no answer') } }));
        });
        item('-');
        item('Open in your browser', () => document.getElementById('real-browser').click());
        item('Reset site…', () => document.getElementById('reset-site').click());
        menu.hidden = false;
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(e.clientX, innerWidth - mw - 4) + 'px';
        menu.style.top = Math.min(e.clientY, innerHeight - mh - 4) + 'px';
        // Opened by the mouse: nothing is highlighted until the pointer or an arrow key picks an item (as Chrome's menu).
        menu.focus({ preventScroll: true });
    });
})();
