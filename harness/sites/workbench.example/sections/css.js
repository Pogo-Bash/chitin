// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// CSS and layout: boxes relative to the section's own box (no text in the measured boxes, so fonts do not enter), computed styles.
WB.section('css', async (t) => {
    const r = t.root;
    const style = document.createElement('style');
    style.textContent = `
.wbc { --gap: 6px; --c: rgb(10 20 30 / 50%); }
.wbc .flex { display: flex; gap: var(--gap); width: 300px; height: 30px; align-items: center; justify-content: space-between; }
.wbc .flex > div { flex: 1 1 40px; height: 20px; background: #c33; }
.wbc .flex > div:nth-child(2) { flex: 2 0 10px; min-width: 0; height: 10px; align-self: flex-end; }
.wbc .flex > div:nth-child(3) { flex: 0 0 50px; order: -1; }
.wbc .grid { display: grid; grid-template-columns: 50px 1fr minmax(20px, 30%); grid-template-rows: 20px auto; gap: 4px 8px; width: 300px; }
.wbc .grid > div { background: #3a3; min-height: 10px; }
.wbc .grid > .span { grid-column: 1 / -1; height: 12px; }
.wbc .grid > .area { grid-row: 2 / span 2; }
.wbc .float { width: 300px; overflow: hidden; }
.wbc .float > .l { float: left; width: 60px; height: 30px; background: #33c; }
.wbc .float > .r { float: right; width: 40px; height: 20px; background: #c3c; margin: 3px; }
.wbc .float > .c { clear: both; height: 5px; background: #999; }
.wbc .pos { position: relative; width: 300px; height: 50px; border: 2px solid #000; padding: 3px; box-sizing: border-box; }
.wbc .pos > .abs { position: absolute; right: 10%; bottom: calc(5px + 1em); width: calc(25% - 4px); height: 10px; background: #f80; font-size: 10px; }
.wbc .pos > .tr { position: absolute; left: 20px; top: 5px; width: 40px; height: 20px; background: #088; transform: translate(10px, 5px) rotate(45deg) scale(1.5); transform-origin: 0 0; }
.wbc .pos > .sticky { position: sticky; top: 0; width: 10px; height: 10px; margin-left: 200px; background: #808; }
.wbc .ib { width: 300px; font-size: 0; }
.wbc .ib > span { display: inline-block; width: 70px; height: 15px; margin: 2px 3px; vertical-align: top; background: #456; }
.wbc .ib > span:nth-child(odd) { height: 25px; vertical-align: middle; }
.wbc .mc { width: 300px; container-type: inline-size; }
@container (min-width: 200px) { .wbc .mc > div { width: 50cqw; } }
.wbc .mc > div { width: 10px; height: 8px; aspect-ratio: auto; background: #aa0; }
.wbc .ar { width: 120px; aspect-ratio: 16 / 9; background: #0aa; }
.wbc .mbox { width: 200px; margin: 10px auto; height: 6px; background: #a0a; }
.wbc .collapse > div { margin: 12px 0 8px; height: 4px; background: #333; }
.wbc .nest { color: red; & .child { color: rgb(1, 2, 3); } }
@layer base, top; @layer top { .wbc .lay { color: rgb(0, 128, 0); } } @layer base { .wbc .lay { color: rgb(255, 0, 0); } }
.wbc .vars { --a: 2; --b: calc(var(--a) * 3px); width: var(--b); height: var(--missing, 7px); }
.wbc .colors { color: hsl(120deg 50% 50%); background-color: oklch(0.7 0.1 200); border-color: color-mix(in srgb, red 25%, blue); outline-color: #abcd; }
.wbc .anim { transition: width 0s; animation: wbspin 10s linear paused; }
@keyframes wbspin { from { opacity: 0.5 } to { opacity: 1 } }
.wbc .hasparent:has(> .flag) { border-left: 3px solid rgb(9, 9, 9); }
.wbc .ws { white-space: pre; tab-size: 4; }
`;
    r.append(style);
    const w = document.createElement('div');
    w.className = 'wbc';
    w.innerHTML = `
<div class="flex"><div></div><div></div><div></div><div></div></div>
<div class="grid"><div class="span"></div><div class="area"></div><div></div><div></div><div></div><div></div></div>
<div class="float"><div class="l"></div><div class="r"></div><div class="r"></div><div class="c"></div></div>
<div class="pos"><div class="abs"></div><div class="tr"></div><div class="sticky"></div></div>
<div class="ib"><span></span><span></span><span></span><span></span><span></span></div>
<div class="mc"><div></div></div>
<div class="ar"></div><div class="mbox"></div>
<div class="collapse"><div></div><div></div></div>
<div class="nest"><span class="child"></span></div>
<div class="lay"></div><div class="vars"></div><div class="colors"></div><div class="anim"></div>
<div class="hasparent"><i class="flag"></i></div><div class="ws"></div>`;
    r.append(w);
    await t.sleep(0);
    const q = (s) => w.querySelector(s), qa = (s) => [...w.querySelectorAll(s)];
    const rects = (s) => qa(s).map((e) => t.rel(e));
    await t.check('flex', () => rects('.flex > div'));
    await t.check('grid', () => rects('.grid > div'));
    await t.check('float', () => [...rects('.float > div'), t.rel(q('.float'))]);
    await t.check('positioned', () => [...rects('.pos > div'), t.rel(q('.pos'))]);
    await t.check('transform.rect', () => t.approx(t.rel(q('.tr')), 0.5));
    await t.check('transform.matrix', () => getComputedStyle(q('.tr')).transform);
    await t.check('inlineBlock', () => rects('.ib > span'));
    await t.check('containerQuery', () => t.rel(q('.mc > div')));
    await t.check('aspectRatio', () => t.rel(q('.ar')));
    await t.check('autoMargin', () => t.rel(q('.mbox')));
    await t.check('marginCollapse', () => [...rects('.collapse > div'), t.rel(q('.collapse'))]);
    await t.check('offsets', () => { const e = q('.pos > .abs'); return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight, e.offsetParent === q('.pos'), q('.pos').clientWidth, q('.pos').clientTop, q('.pos').scrollWidth]; });
    await t.check('clientRects', () => q('.flex').getClientRects().length);
    const cs = (s, props) => { const c = getComputedStyle(q(s)); return Object.fromEntries(props.map((p) => [p, c.getPropertyValue(p)])); };
    await t.check('computed.flexItem', () => cs('.flex > div:nth-child(2)', ['flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order', 'width', 'display']));
    await t.check('computed.grid', () => cs('.grid', ['grid-template-columns', 'grid-template-rows', 'row-gap', 'column-gap', 'display']));
    await t.check('computed.nesting', () => cs('.nest .child', ['color']));
    await t.check('computed.layers', () => cs('.lay', ['color']));
    await t.check('computed.vars', () => cs('.vars', ['width', 'height', '--a', '--b']));
    await t.check('computed.colors', () => cs('.colors', ['color', 'background-color', 'border-top-color', 'outline-color']));
    await t.check('computed.anim', () => cs('.anim', ['animation-name', 'animation-duration', 'animation-play-state', 'opacity', 'transition-property', 'transition-duration']));
    await t.check('computed.has', () => cs('.hasparent', ['border-left-width', 'border-left-color', 'border-left-style']));
    await t.check('computed.position', () => cs('.pos > .abs', ['position', 'right', 'bottom', 'width', 'top', 'left']));
    await t.check('computed.defaults', () => cs('.ws', ['display', 'white-space', 'tab-size', 'margin-top', 'font-size', 'line-height', 'box-sizing', 'visibility', 'z-index', 'cursor', 'direction', 'writing-mode']));
    await t.check('matchMedia', () => ['(min-width: 100px)', '(prefers-color-scheme: light)', '(prefers-reduced-motion: reduce)', '(hover: hover)', '(pointer: fine)', 'print', 'screen', '(orientation: landscape)', '(color)', '(min-resolution: 1dppx)', '(display-mode: browser)'].map((m) => m + '=' + matchMedia(m).matches));
    await t.check('CSS.supports', () => ['display: grid', 'display: subgrid', 'selector(:has(a))', 'color: oklch(0.5 0.1 10)', 'container-type: size', 'anchor-name: --a', 'text-wrap: balance', 'view-transition-name: a', 'field-sizing: content', 'interpolate-size: allow-keywords'].map((s) => s + '=' + (s.startsWith('selector') ? CSS.supports(s) : CSS.supports(...s.split(': ')))));
    await t.check('cssom', () => { const sh = style.sheet; const n = sh.cssRules.length; sh.insertRule('.wbc .ins { width: 3px }', n); const rule = sh.cssRules[n]; rule.style.setProperty('height', '4px', 'important'); return [n > 10, rule.cssText, rule.selectorText, rule.style.getPropertyPriority('height'), sh.cssRules[0].constructor.name]; });
    await t.check('constructable', () => { const s = new CSSStyleSheet(); s.replaceSync('.wbc .ar { outline: 2px solid rgb(1, 1, 1) }'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; const v = getComputedStyle(q('.ar')).outlineWidth; document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s); return [v, getComputedStyle(q('.ar')).outlineWidth]; });
    await t.check('animations', () => { const a = q('.anim').getAnimations(); return [a.length, a[0] && a[0].playState, a[0] && a[0].animationName]; });
    await t.check('waapi', async () => { const e = q('.mbox'); const an = e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: 'both' }); an.pause(); an.currentTime = 250; const o = t.round(Number(getComputedStyle(e).opacity), 2); an.finish(); await an.finished; return [o, getComputedStyle(e).opacity, an.playState]; });
    await t.check('scroll', () => { const s = document.createElement('div'); s.style.cssText = 'width:100px;height:50px;overflow:scroll;scrollbar-width:none'; s.innerHTML = '<div style="width:300px;height:500px"></div>'; w.append(s); s.scrollTop = 120; s.scrollLeft = 1000; s.scrollBy(0, 5); return [s.scrollTop, s.scrollLeft, s.scrollHeight, s.scrollWidth, s.clientWidth]; });
    await t.check('elementFromPoint', () => { const b = q('.ar').getBoundingClientRect(); const e = document.elementFromPoint(b.left + 5, b.top + 5); return e && e.className; });
});
