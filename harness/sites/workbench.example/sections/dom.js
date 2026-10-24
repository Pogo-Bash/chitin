// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// DOM, events, shadow DOM, custom elements and MutationObserver: values and order logs.
WB.section('dom', async (t) => {
    const r = t.root;
    r.innerHTML = '<div id="a" class="x y" data-k-v="1"><p>one<b>two</b>three</p><!--c--><ul><li>1<li>2</ul><table><tr><td>t</table><select><option>a<option selected>b</select></div>';
    const a = r.firstChild;
    await t.check('parse.serialize', () => r.innerHTML);
    await t.check('parse.childNodes', () => [...a.childNodes].map((n) => n.nodeName));
    await t.check('qsa', () => [...r.querySelectorAll('li:nth-child(2), p > b, :is(ul) li:first-child, td:only-child, option:checked, :not(p, ul, li, b, table, tbody, tr, td, select, option)')].map((e) => e.tagName + ':' + e.textContent));
    await t.check('matches.closest', () => [r.querySelector('b').matches('div p b'), r.querySelector('b').closest('.x').id, a.matches(':has(> ul)'), a.matches('[data-k-v="1"]')]);
    await t.check('dataset.classList', () => { a.classList.toggle('y'); a.classList.add('z', 'x'); a.classList.replace('z', 'w'); return [a.className, JSON.stringify({ ...a.dataset }), a.classList.contains('w')]; });
    const p = r.querySelector('p');
    await t.check('text', () => [p.textContent, p.innerText, p.outerText, a.querySelector('ul').innerText]);
    await t.check('range', () => { const rg = document.createRange(); rg.setStart(p.firstChild, 1); rg.setEnd(p.lastChild, 2); const f = rg.cloneContents(); return [rg.toString(), [...f.childNodes].map((n) => n.nodeName + ':' + n.textContent), rg.commonAncestorContainer.nodeName]; });
    await t.check('treewalker', () => { const w = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT); const out = []; while (w.nextNode()) out.push(w.currentNode.nodeName); return out; });
    await t.check('nodeiterator', () => { const it = document.createNodeIterator(p, NodeFilter.SHOW_TEXT); const out = []; let n; while ((n = it.nextNode())) out.push(n.data); return out; });
    await t.check('insertAdjacent', () => { const d = document.createElement('div'); d.innerHTML = '<i>m</i>'; const i = d.firstChild; i.insertAdjacentHTML('beforebegin', '<u>1</u>'); i.insertAdjacentHTML('afterend', '<u>2</u>'); i.insertAdjacentText('afterbegin', '<'); i.insertAdjacentElement('beforeend', document.createElement('br')); return d.innerHTML; });
    await t.check('template', () => { const tp = document.createElement('template'); tp.innerHTML = '<span>x</span><tr><td>y</td></tr>'; return [tp.childNodes.length, tp.content.childNodes.length, tp.innerHTML, tp.content.ownerDocument === document]; });
    await t.check('domparser.xml', () => { const d = new DOMParser().parseFromString('<root xmlns:q="urn:q"><a b="1"/><q:c>t&amp;</q:c></root>', 'application/xml'); return [d.documentElement.nodeName, new XMLSerializer().serializeToString(d), d.querySelector('a').getAttribute('b')]; });
    await t.check('domparser.html', () => { const d = new DOMParser().parseFromString('<title>T</title><p>x<p>y', 'text/html'); return [d.title, d.body.innerHTML, d.compatMode]; });
    await t.check('domparser.badxml', () => { const d = new DOMParser().parseFromString('<a><b></a>', 'application/xml'); return d.getElementsByTagName('parsererror').length > 0; });
    await t.check('compareDocumentPosition', () => { const b = r.querySelector('b'), li = r.querySelector('li'); return [b.compareDocumentPosition(li), li.compareDocumentPosition(b), a.compareDocumentPosition(b), a.contains(b)]; });
    await t.check('normalize.splitText', () => { const s = document.createElement('span'); s.append('a', 'b', '', 'c'); s.normalize(); const n = s.firstChild.splitText(1); return [s.childNodes.length, s.firstChild.data, n.data, n.wholeText]; });
    await t.check('attributes', () => { const e = document.createElement('div'); e.setAttribute('b', '2'); e.setAttribute('a', '1'); e.setAttribute('B', '3'); e.toggleAttribute('h'); e.setAttributeNS('urn:x', 'x:q', '4'); e.removeAttribute('a'); return [...e.attributes].map((x) => x.name + '=' + x.value + (x.namespaceURI ? '@' + x.namespaceURI : '')); });
    await t.check('cloneNode', () => { const c = a.cloneNode(true); return [c.outerHTML === a.outerHTML, c.querySelector('option').selected, c.isEqualNode(a), c.isSameNode(a)]; });
    await t.check('replaceChildren.before.after', () => { const d = document.createElement('div'); d.replaceChildren('x', document.createElement('i')); d.firstChild.before('0'); d.lastChild.after('9'); d.lastChild.replaceWith('Z'); return d.innerHTML; });

    // Events: capture/target/bubble, once, passive, handleEvent, property handlers among listeners.
    const outer = document.createElement('div'), inner = document.createElement('span');
    outer.append(inner); r.append(outer);
    const L = [];
    const on = (el, tag, opts) => el.addEventListener('wb', (e) => L.push(tag + ':' + e.eventPhase), opts);
    on(outer, 'outer-cap', true); on(outer, 'outer-bub'); on(inner, 'inner-cap', true); on(inner, 'inner-bub'); on(inner, 'inner-once', { once: true });
    inner.addEventListener('wb', { handleEvent: (e) => L.push('handleEvent:' + (e.currentTarget === inner)) });
    inner.addEventListener('wb', (e) => { e.preventDefault(); L.push('passive-prevented:' + e.defaultPrevented); }, { passive: true });
    inner.dispatchEvent(new Event('wb', { bubbles: true, cancelable: true }));
    inner.dispatchEvent(new Event('wb', { bubbles: false }));
    t.set('events.order', L.slice());
    L.length = 0;
    inner.onclick = () => L.push('prop1');
    inner.addEventListener('click', () => L.push('listener'));
    inner.onclick = () => L.push('prop2'); // replaces in place, keeps its first position
    inner.addEventListener('click', (e) => { L.push('stopImmediate'); e.stopImmediatePropagation(); });
    inner.addEventListener('click', () => L.push('never'));
    outer.addEventListener('click', () => L.push('outer'));
    inner.click();
    t.set('events.handlers', L.slice());
    await t.check('events.misc', () => { const e = new CustomEvent('c', { detail: { n: 1 }, composed: true }); const k = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true }); const m = new MouseEvent('click', { clientX: 3, button: 1, buttons: 4 }); return [e.detail.n, e.composed, e.isTrusted, k.key, k.code, k.ctrlKey, k.getModifierState('Control'), m.clientX, m.button, m.buttons, m.which, new Event('x').timeStamp > 0, typeof new PointerEvent('pointerdown', { pointerId: 7 }).pointerId]; });
    await t.check('events.dispatchReturn', () => { const d = document.createElement('div'); d.addEventListener('x', (e) => e.preventDefault()); return [d.dispatchEvent(new Event('x', { cancelable: true })), d.dispatchEvent(new Event('x'))]; });

    // Shadow DOM: retargeting, composedPath, slots, slotchange.
    await t.check('shadow', async () => {
        const host = document.createElement('div');
        host.innerHTML = '<span slot="s">light</span><em>default</em>';
        r.append(host);
        const sr = host.attachShadow({ mode: 'open' });
        sr.innerHTML = '<style>:host{display:block}</style><b><slot name="s"></slot></b><slot></slot><i id="in">shadow</i>';
        const seen = [];
        sr.querySelectorAll('slot').forEach((s) => s.addEventListener('slotchange', () => seen.push('slotchange:' + (s.name || 'default') + ':' + s.assignedNodes().length)));
        let path = null, outerTarget = null;
        host.addEventListener('ev', (e) => { path = e.composedPath().map((n) => n.nodeName || (n === window ? 'window' : '?')); outerTarget = e.target.nodeName; });
        sr.getElementById('in').dispatchEvent(new Event('ev', { bubbles: true, composed: true }));
        await t.sleep(0);
        host.append(document.createElement('hr'));
        await t.sleep(0);
        const named = sr.querySelector('slot[name=s]');
        return { path: path.slice(0, 6), outerTarget, assigned: named.assignedNodes().map((n) => n.nodeName), assignedFlat: sr.querySelectorAll('slot')[1].assignedElements({ flatten: true }).map((n) => n.nodeName), slotchange: seen, assignedSlot: host.firstChild.assignedSlot === named, rootNode: sr.getElementById('in').getRootNode() === sr };
    });

    // Custom elements: callback order across upgrade, attribute change, move and removal.
    await t.check('customElements', async () => {
        const CL = [];
        const tag = 'wb-el-' + t.MODE;
        class El extends HTMLElement {
            static get observedAttributes() { return ['a']; }
            constructor() { super(); CL.push('ctor'); }
            connectedCallback() { CL.push('connected:' + this.isConnected); }
            disconnectedCallback() { CL.push('disconnected'); }
            attributeChangedCallback(n, o, v) { CL.push(`attr:${n}:${o}->${v}`); }
            adoptedCallback() { CL.push('adopted'); }
        }
        r.insertAdjacentHTML('beforeend', `<${tag} a="1"></${tag}>`);
        const pre = r.lastChild;
        CL.push('before-define:' + (pre instanceof El));
        customElements.define(tag, El);
        CL.push('after-define:' + (pre instanceof El));
        pre.setAttribute('a', '2');
        pre.setAttribute('b', '2');
        const other = document.createElement('div');
        r.append(other);
        other.append(pre);
        pre.remove();
        const doc = document.implementation.createHTMLDocument('x');
        doc.body.append(document.createElement(tag));
        document.body.append(doc.body.firstChild);
        document.body.lastChild.remove();
        const w = await customElements.whenDefined(tag);
        return { order: CL, whenDefined: w === El, get: customElements.get(tag) === El };
    });

    // MutationObserver: records and their delivery relative to microtasks.
    await t.check('mutationObserver', async () => {
        const M = [];
        const target = document.createElement('div');
        target.innerHTML = '<p>a</p>';
        r.append(target);
        const mo = new MutationObserver((recs) => M.push('cb:' + recs.map((x) => x.type + '/' + (x.attributeName || '') + '/' + (x.oldValue ?? '') + '/' + x.addedNodes.length + '+' + x.removedNodes.length).join(',')));
        mo.observe(target, { subtree: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true, childList: true });
        target.setAttribute('x', '1');
        target.setAttribute('x', '2');
        target.firstChild.firstChild.data = 'b';
        target.append('t');
        target.firstChild.remove();
        Promise.resolve().then(() => M.push('microtask'));
        const pending = mo.takeRecords().length;
        target.id = 'later';
        M.push('sync-end:' + pending);
        await t.sleep(0);
        mo.disconnect();
        target.id = 'after-disconnect';
        await t.sleep(0);
        return M;
    });
});
