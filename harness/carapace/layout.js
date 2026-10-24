// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// The carapace's own layout: the tab's size (a standard window size, or the window's free space), the options row, and the
// devtools-style panel under the page. Runs before carapace.js so the tab has its size when the segment starts; a later
// size change goes to carapace.js as a 'chitin-tab-resize' event (the segment's viewport follows, as a resized window).
(() => {
    const store = {
        get(k) { try { return localStorage.getItem('chitin.' + k); } catch { return null; } },
        set(k, v) { try { localStorage.setItem('chitin.' + k, v); } catch {} },
    };
    const params = new URLSearchParams(location.search);
    const tab = document.getElementById('tab');
    const main = document.querySelector('main');
    const sizeEl = document.getElementById('size');

    // Tests drive the carapace with automation and compare against Chrome at 800x600: that stays their default.
    const fixed = /^(\d{2,4})x(\d{2,4})$/.test(params.get('tab') || '');
    let size = fixed ? params.get('tab') : (store.get('size') || (navigator.webdriver ? '800x600' : '1280x720'));
    function fitSize() {
        const cs = getComputedStyle(main);
        const w = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
        const h = main.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 2;
        return [Math.max(200, Math.floor(w)), Math.max(150, Math.floor(h))];
    }
    function apply(notify) {
        if (fixed)
            return;
        const m = /^(\d+)x(\d+)$/.exec(size);
        const [w, h] = m ? [+m[1], +m[2]] : fitSize();
        if (tab.clientWidth === w && tab.clientHeight === h)
            return;
        tab.style.width = w + 'px';
        tab.style.height = h + 'px';
        if (notify)
            window.dispatchEvent(new CustomEvent('chitin-tab-resize', { detail: { width: w, height: h } }));
    }
    if (fixed) {
        sizeEl.disabled = true;
        sizeEl.title = 'set by ?tab=' + size;
    }
    if (![...sizeEl.options].some((o) => o.value === size))
        sizeEl.add(new Option(size.replace('x', ' × '), size));
    sizeEl.value = size;
    sizeEl.addEventListener('change', () => {
        size = sizeEl.value;
        store.set('size', size);
        apply(true);
    });
    let fitTimer = 0;
    const refit = () => {
        if (size !== 'fit')
            return;
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => apply(true), 150);
    };
    window.addEventListener('resize', refit);

    // The options row (engine, frames, relay, ...), folded away by default.
    const optsBtn = document.getElementById('opts-toggle');
    const opts = document.getElementById('opts');
    const showOpts = (on) => { opts.hidden = !on; optsBtn.setAttribute('aria-expanded', String(on)); };
    showOpts(store.get('opts') === '1');
    optsBtn.addEventListener('click', () => { showOpts(opts.hidden); store.set('opts', opts.hidden ? '0' : '1'); refit(); });

    // The panel: tabs, a drag handle for its height, hide/show.
    const dev = document.getElementById('devtools');
    const tabs = [...dev.querySelectorAll('.tabs [role=tab]')];
    const select = (name) => {
        for (const b of tabs)
            b.setAttribute('aria-selected', String(b.dataset.pane === name));
        for (const p of dev.querySelectorAll('.pane'))
            p.hidden = p.dataset.pane !== name;
        store.set('pane', name);
    };
    tabs.forEach((b) => b.addEventListener('click', () => { if (dev.classList.contains('collapsed')) collapse(false); select(b.dataset.pane); }));
    select(tabs.some((b) => b.dataset.pane === store.get('pane')) ? store.get('pane') : 'segment');
    const toggle = document.getElementById('devtools-toggle');
    function collapse(on) {
        dev.classList.toggle('collapsed', on);
        toggle.textContent = on ? 'show' : 'hide';
        store.set('collapsed', on ? '1' : '0');
        refit();
    }
    collapse(store.get('collapsed') === '1');
    toggle.addEventListener('click', () => collapse(!dev.classList.contains('collapsed')));
    const savedH = parseInt(store.get('devtools-h') || '', 10);
    if (savedH > 0)
        dev.style.setProperty('--devtools-h', savedH + 'px');
    const grip = document.getElementById('devtools-grip');
    grip.addEventListener('pointerdown', (e) => {
        grip.setPointerCapture(e.pointerId);
        const startY = e.clientY, startH = dev.getBoundingClientRect().height;
        const move = (ev) => dev.style.setProperty('--devtools-h', Math.max(60, Math.min(innerHeight * 0.8, startH + startY - ev.clientY)) + 'px');
        const up = () => {
            grip.removeEventListener('pointermove', move);
            store.set('devtools-h', String(Math.round(dev.getBoundingClientRect().height)));
            refit();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up, { once: true });
    });

    apply(false);
})();
