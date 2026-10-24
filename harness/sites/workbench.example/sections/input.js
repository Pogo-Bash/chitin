// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Real input from the runner (puppeteer's mouse and keyboard, through the carapace's view in Chitin): the event sequence of a
// click into a text field, typing, Tab, Space on a button, a checkbox click, a hover and a wheel, with isTrusted and the
// microtask checkpoint between listeners that only trusted events have.
WB.section('input', async (t) => {
    const ids = ['wb-text', 'wb-btn', 'wb-cb', 'wb-ta', 'wb-hover', 'wb-scroll'];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const L = [];
    const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'focus', 'focusin', 'pointerup', 'mouseup', 'click', 'blur', 'focusout', 'keydown', 'keypress', 'beforeinput', 'input', 'keyup', 'change', 'pointerleave', 'mouseleave', 'wheel', 'scroll', 'scrollend', 'select', 'auxclick', 'contextmenu', 'dblclick', 'compositionstart'];
    const describe = (e) => {
        let s = e.type + '@' + e.currentTarget.id + (e.isTrusted ? '' : ':untrusted');
        if (e instanceof KeyboardEvent) s += ':' + e.key + '/' + e.code + (e.repeat ? '/r' : '');
        if (e instanceof InputEvent) s += ':' + e.inputType + '/' + e.data;
        if (e instanceof MouseEvent && !(e instanceof WheelEvent) && /click|down|up/.test(e.type)) s += ':b' + e.button + '/' + e.buttons + '/d' + e.detail;
        if (e instanceof PointerEvent && /down|up/.test(e.type)) s += ':' + e.pointerType + '/primary=' + e.isPrimary;
        if (e instanceof WheelEvent) s += ':' + Math.sign(e.deltaY) + '/mode' + e.deltaMode;
        if (e.type === 'focus' || e.type === 'blur') s += ':rt=' + (e.relatedTarget ? e.relatedTarget.id : null);
        return s;
    };
    for (const el of Object.values(els)) for (const ty of types) el.addEventListener(ty, (e) => { L.push(describe(e)); if (e.type === 'click' && e.currentTarget.id === 'wb-btn') Promise.resolve().then(() => L.push('microtask-after-btn-click-l1')); });
    els['wb-btn'].addEventListener('click', () => L.push('btn-click-l2'));
    const center = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left + Math.min(b.width / 2, 20)), Math.round(b.top + b.height / 2)]; };
    const scrolled0 = els['wb-scroll'].scrollTop;
    const ok = await t.input([
        { op: 'click', at: center(els['wb-text']) },
        { op: 'type', text: 'Ab1' },
        { op: 'key', key: 'Backspace' },
        { op: 'key', key: 'Tab' },
        { op: 'key', key: ' ' },
        { op: 'click', at: center(els['wb-cb']) },
        { op: 'click', at: center(els['wb-ta']) },
        { op: 'type', text: 'x' },
        { op: 'key', key: 'Enter' },
        { op: 'move', at: center(els['wb-hover']) },
        { op: 'move', at: [5, 5] },
        { op: 'wheel', at: center(els['wb-scroll']), dy: 120 },
    ]);
    await t.sleep(400);
    t.set('runnerDone', ok);
    t.set('order', L.filter((x) => !x.startsWith('scroll@') && !x.startsWith('scrollend@')));
    t.set('scrollEvents', [L.some((x) => x.startsWith('scroll@')), els['wb-scroll'].scrollTop > scrolled0]);
    t.set('values', [els['wb-text'].value, els['wb-cb'].checked, JSON.stringify(els['wb-ta'].value), document.activeElement && document.activeElement.id]);
    t.set('userActivation', navigator.userActivation ? [navigator.userActivation.hasBeenActive] : 'none');
}, { timeout: 60000 });
