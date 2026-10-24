// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The CSSOM serialization generator (tools/cssom-diff, docs/cssom.md). Sets property/value pairs through every CSSOM door and reads
// each serialization back: style.getPropertyValue / cssText / the style attribute / CSSRule.cssText / getComputedStyle / CSS.supports,
// plus rule text for the at-rules. Results: window.__cssom = JSON string of { results: { key: value } }, keys "<kind>|<prop>|<value>".
// The page's own origin is written as ORIGIN so Chrome (localhost) and Chitin (cssom.example) compare.
window.__cssomStage = 'start';
try { (function () {
    'use strict';
    var out = {};
    var origin = location.origin;
    function norm(s) { return typeof s === 'string' ? s.split(origin).join('ORIGIN') : s; }
    function put(k, f) { try { out[k] = norm(String(f())); } catch (e) { out[k] = 'THROW ' + (e && e.name); } }

    var len = ['0', '1px', '-2px', '1.5em', '.5px', '10%', '1e3px', '2rem', '1.23456789px', '10PX', 'calc(1px + 2px)', 'calc(10% + 5px)', 'calc(2 * 3px)',
        'calc(1em - 1px)', 'calc((1px + 2px) * 2)', 'min(1px, 2px)', 'max(10%, 5px)', 'clamp(1px, 2em, 3px)', 'calc(1px * 0)', 'calc(100% / 3)', 'auto', 'inherit', 'var(--x)', 'calc(var(--x) + 1px)'];
    var colors = ['red', 'RED', 'Red', '#abc', '#ABCDEF', '#aabbcc80', '#abcd', 'rgb(1,2,3)', 'rgb(1 2 3)', 'rgba(1,2,3,.5)', 'rgb(1 2 3 / 50%)', 'rgba(1, 2, 3, 1)',
        'rgb(10%, 20%, 30%)', 'rgb(1.5, 2.5, 3.5)', 'rgb(300, -1, 0)', 'hsl(120, 50%, 50%)', 'hsl(120 50% 50% / .25)', 'hsla(120deg, 100%, 25%, 0.3)', 'hwb(120 10% 20%)',
        'lab(50% 20 30)', 'lch(50% 30 120)', 'oklab(0.5 0.1 -0.1)', 'oklch(0.5 0.1 120)', 'oklch(50% 0.1 120 / 0.5)', 'color(display-p3 1 0 0)', 'color(srgb 0.5 0.5 0.5 / 50%)',
        'color-mix(in srgb, red 50%, blue)', 'color-mix(in oklch, red, blue 30%)', 'currentcolor', 'currentColor', 'transparent', 'rebeccapurple', 'canvastext', 'Canvas', 'none', 'initial'];
    var numbers = ['0', '1', '0.5', '.5', '-1', '1e2', '1.000', '10', '50%', 'calc(1 + 2)', 'calc(0.5 * 2)'];
    var times = ['1s', '100ms', '0s', '.5s', '-1s', 'calc(1s + 100ms)', '1000ms'];
    var angles = ['10deg', '1turn', '1rad', '100grad', '0', 'calc(10deg + 1turn)'];
    var lenProps = ['width', 'height', 'min-width', 'max-height', 'margin-top', 'padding-left', 'top', 'left', 'border-top-width', 'font-size', 'line-height',
        'letter-spacing', 'text-indent', 'border-top-left-radius', 'outline-offset', 'column-gap', 'flex-basis', 'inset-inline-start', 'block-size', 'stroke-width'];
    var colorProps = ['color', 'background-color', 'border-top-color', 'outline-color', 'text-decoration-color', 'caret-color', 'column-rule-color', 'fill', 'stroke',
        'stop-color', 'flood-color', 'lighting-color', 'accent-color'];
    var numProps = ['opacity', 'z-index', 'flex-grow', 'order', 'fill-opacity', 'stroke-opacity', 'stroke-miterlimit', 'line-height', 'orphans', 'font-weight', 'tab-size'];
    var curated = {
        'margin': ['1px', '1px 2px', '1px 2px 3px', '1px 2px 3px 4px', '1px 1px 1px 1px', '1px 2px 1px 2px', '1px 2px 3px 2px', 'auto', '0 auto', 'calc(1px + 1px) 0'],
        'padding': ['1px', '1px 2px', '1px 2px 3px 4px', '0 0 0 0', '5%'],
        'inset': ['0', '1px 2px', 'auto', '1px 2px 3px 4px', '1px auto'],
        'border': ['1px solid red', 'solid', '1px', 'red', 'thin dotted', 'medium none currentcolor', '2px dashed rgb(1,2,3)', 'none', '0'],
        'border-top': ['1px solid red', 'solid'], 'border-width': ['1px', '1px 2px', 'thin medium thick'], 'border-color': ['red', 'red blue', 'red blue green yellow'],
        'border-style': ['solid', 'solid dashed'], 'border-radius': ['1px', '1px 2px', '1px / 2px', '1px 2px 3px 4px / 5px', '50%'],
        'outline': ['1px solid red', 'auto', 'none', 'thin dashed'],
        'background': ['red', 'url(img.png)', 'url(img.png) no-repeat center / cover red', 'none', 'linear-gradient(red, blue)', 'red url(a.png), blue',
            'url("img.png") 10px 20px / 50% auto repeat-x scroll padding-box border-box', 'transparent', 'repeat-y fixed', 'top left'],
        'background-position': ['center', 'left top', '10px 20px', 'right 10px bottom 5px', '50%', 'top'],
        'background-size': ['cover', 'auto', '10px', '10px auto', 'auto auto'],
        'background-image': ['url(img.png)', 'url("img.png")', "url('img.png')", 'url(a\\ b.png)', 'url("a b.png")', 'url(data:image/png;base64,AAAA)', 'none',
            'url(img.png), none', 'linear-gradient(to right, red 0%, blue 100%)', 'radial-gradient(circle, red, blue)', 'linear-gradient(45deg, red, blue)', 'image-set("a.png" 1x)'],
        'font': ['12px serif', 'bold 12px/1.5 Arial, sans-serif', 'italic small-caps bold 1em/2 "Times New Roman"', 'menu', 'caption', '12px', 'normal 400 16px/normal serif',
            'condensed 12px sans-serif', 'oblique 10deg 12px x'],
        'font-family': ['serif', 'Arial', '"Arial"', "'Times New Roman'", 'Times New Roman', 'a, b, monospace', '"serif"', 'system-ui'],
        'font-weight': ['bold', 'normal', '400', '700', 'bolder', '350.5'],
        'font-variant': ['small-caps', 'normal', 'none', 'common-ligatures small-caps'],
        'grid': ['auto / 1fr', 'none', '"a b" 10px / 1fr 2fr', 'auto-flow / 1fr 1fr', 'repeat(2, 1fr) / auto-flow dense'],
        'grid-template': ['none', '1fr / 1fr', '"a" "b"', '[a] 1fr [b] / auto'],
        'grid-template-columns': ['1fr 2fr', 'repeat(3, 1fr)', 'repeat(auto-fill, minmax(100px, 1fr))', '[a] 10px [b c] 20px', 'subgrid', 'none', 'fit-content(10px)'],
        'grid-template-areas': ['"a b" "c d"', 'none', '"a . b"'],
        'grid-area': ['1 / 2 / 3 / 4', 'a', '1 / 2', 'span 2 / auto', 'auto'],
        'grid-row': ['1 / 3', 'span 2', '1', 'a / b'], 'grid-column': ['1 / -1', 'auto / span 3'],
        'grid-auto-flow': ['row', 'column dense', 'dense'],
        'gap': ['1px', '1px 2px', 'normal', '10%'],
        'flex': ['1', '1 1 0', 'auto', 'none', '0 0 auto', '2 3', '1 1 10px', '10px', 'initial', '0', '1 0%'],
        'flex-flow': ['row wrap', 'column', 'wrap', 'row nowrap'],
        'transition': ['all 1s', 'opacity 1s ease-in 0.5s', 'none', '1s', 'opacity 1s, transform 2s linear', 'all 0s ease 0s', 'width 1s cubic-bezier(0.1, 0.2, 0.3, 0.4)',
            'color 1s steps(4, jump-end)', 'all 1s allow-discrete'],
        'animation': ['spin 1s infinite', 'spin 1s linear 0s infinite normal none running', 'none', '1s', 'a 1s, b 2s', 'x 2s ease-in-out 1s 3 alternate both paused'],
        'transition-timing-function': ['ease', 'linear', 'steps(2)', 'cubic-bezier(0, 0, 1, 1)', 'linear(0, 0.5 50%, 1)', 'step-start'],
        'place-items': ['center', 'start end', 'normal', 'baseline'], 'place-content': ['center', 'space-between start', 'normal'], 'place-self': ['auto', 'center end'],
        'text-decoration': ['underline', 'underline red', 'underline dotted 2px red', 'none', 'line-through overline'],
        'list-style': ['none', 'disc inside', 'url(img.png)', 'square'],
        'columns': ['2', '10px', '2 10px', 'auto'], 'column-rule': ['1px solid red'],
        'overflow': ['hidden', 'auto scroll', 'visible hidden', 'clip'],
        'transform': ['none', 'rotate(10deg)', 'translate(10px, 20px) scale(2)', 'matrix(1, 0, 0, 1, 0, 0)', 'translateX(10%)', 'rotate(0.5turn)', 'scale(1.5, 1.5)'],
        'translate': ['10px', '10px 20px', 'none'], 'rotate': ['10deg', 'x 10deg', 'none'], 'scale': ['2', '1 2', 'none'],
        'box-shadow': ['1px 2px red', 'inset 0 0 3px 1px rgba(0,0,0,.5)', 'none', '1px 1px red, 2px 2px blue'],
        'text-shadow': ['1px 1px 2px black', 'none', 'red 1px 1px'],
        'filter': ['blur(2px)', 'none', 'brightness(50%) contrast(1.2)', 'drop-shadow(1px 1px red)'],
        'clip-path': ['circle(50%)', 'inset(1px 2px)', 'none', 'polygon(0 0, 100% 0, 50% 100%)', 'url(#c)'],
        'content': ['"a"', 'none', 'normal', "'x'", 'counter(c)', '"a" attr(title)', 'url(img.png)'],
        'quotes': ['none', '"a" "b"', 'auto'],
        'cursor': ['pointer', 'url(cur.png), auto', 'url(cur.png) 2 3, pointer'],
        'stroke-dasharray': ['none', '1 2', '1px, 2px', '1 2 3', '10%'], 'stroke-dashoffset': ['1', '1px', '10%'], 'stroke-linecap': ['round', 'butt'],
        'stroke-linejoin': ['miter', 'bevel'], 'fill-rule': ['evenodd', 'nonzero'], 'paint-order': ['normal', 'stroke', 'markers stroke fill', 'fill stroke markers'],
        'marker-start': ['none', 'url(#m)'], 'vector-effect': ['non-scaling-stroke'], 'dominant-baseline': ['middle', 'auto'], 'text-anchor': ['middle'],
        'shape-rendering': ['crispEdges', 'auto'], 'r': ['1px', '10'], 'cx': ['1px', '10%'], 'x': ['1px'], 'd': ['path("M 0 0 L 10 10")', 'none'],
        'mask': ['none', 'url(m.png)', 'url(m.png) no-repeat'], 'mask-image': ['url(m.png)', 'none'],
        'aspect-ratio': ['16 / 9', 'auto', '1', 'auto 2 / 1', '0.5'],
        'container': ['a / size', 'none', 'b'], 'container-type': ['inline-size', 'normal'],
        'contain': ['none', 'layout paint', 'strict', 'content', 'size layout style paint'],
        'will-change': ['transform', 'auto', 'opacity, transform'],
        'counter-reset': ['c', 'c 2', 'none', 'a b 3'], 'counter-increment': ['c', 'c -1'],
        'white-space': ['nowrap', 'pre-wrap', 'normal', 'break-spaces'], 'text-wrap': ['balance', 'wrap'],
        'vertical-align': ['middle', '10px', '-5%', 'baseline'],
        'display': ['block', 'inline flex', 'flex', 'inline-block', 'block flow', 'grid', 'list-item', 'none', 'contents', 'flow-root', 'table-cell', 'inline-grid'],
        'position': ['sticky', 'absolute'], 'float': ['left'], 'visibility': ['collapse'],
        'object-position': ['center', '10px 20px', 'left top'], 'transform-origin': ['center', 'left top', '10px 20px 30px', '50% 50%'],
        'perspective-origin': ['center', 'left'], 'offset': ['none', 'path("M 0 0") 10px'],
        'border-image': ['url(b.png) 30 round', 'none', 'linear-gradient(red, blue) 10%'],
        'scrollbar-color': ['red blue', 'auto'], 'scroll-margin': ['1px', '1px 2px'], 'scroll-padding': ['auto', '1px 2px 3px'],
        'overscroll-behavior': ['contain', 'auto none'], 'touch-action': ['pan-x pan-y', 'manipulation', 'none'],
        'user-select': ['none'], '-webkit-user-select': ['none'], '-webkit-line-clamp': ['2'], '-webkit-box-orient': ['vertical'], '-webkit-text-fill-color': ['red'],
        'text-emphasis': ['dot red'], 'text-underline-offset': ['2px', 'auto'], 'font-feature-settings': ['"liga" 0', 'normal', '"kern", "liga" off'],
        'font-variation-settings': ['"wght" 400', 'normal'], 'font-stretch': ['condensed', '75%', 'normal'], 'font-style': ['italic', 'oblique', 'oblique 10deg', 'normal'],
        'inset-block': ['1px', '1px 2px'], 'margin-inline': ['1px', '1px 2px', 'auto'], 'padding-block': ['1px 1px'], 'border-inline': ['1px solid red'],
        'border-block-start': ['2px dotted blue'],
        '--x': ['1px', ' 1px ', 'red', '{a:b}', 'calc( 1px + 2px )', 'var(--y)', '"str"', '  ', 'a   b', '1px !foo'],
        '--y': ['var(--x, 2px)', 'url(img.png)'],
        'width': ['fit-content', 'max-content', 'min-content', 'fit-content(10px)', 'stretch', '-webkit-fill-available', 'calc(100% - var(--x))'],
        'color': ['var(--x)', 'var(--x, red)', 'light-dark(red, blue)', 'rgb(from red r g b)', 'color-mix(in srgb, currentcolor, red)', 'hsl(none 50% 50%)'],
    };

    var pairs = [];
    function add(p, vs) { for (var i = 0; i < vs.length; i++) pairs.push([p, vs[i]]); }
    lenProps.forEach(function (p) { add(p, len); });
    colorProps.forEach(function (p) { add(p, colors); });
    numProps.forEach(function (p) { add(p, numbers); });
    ['transition-duration', 'animation-delay', 'animation-duration'].forEach(function (p) { add(p, times); });
    ['hue-rotate'].length; add('rotate', angles); add('font-style', ['oblique 10deg', 'oblique 1rad']);
    Object.keys(curated).forEach(function (p) { add(p, curated[p]); });

    var t = document.getElementById('t');
    var styleEl = document.createElement('style');
    document.head.appendChild(styleEl);
    var sheet = styleEl.sheet;
    for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i][0], v = pairs[i][1], k = p + '|' + v;
        if (i % 100 === 0) window.__cssomStage = 'pairs ' + i + '/' + pairs.length;
        t.setAttribute('style', '');
        put('supports|' + k, function () { return CSS.supports(p, v); });
        put('get|' + k, function () { t.style.setProperty(p, v); return t.style.getPropertyValue(p); });
        put('css|' + k, function () { return t.style.cssText; });
        put('attr|' + k, function () { return t.getAttribute('style'); });
        if (p.indexOf('--') !== 0) put('cs|' + k, function () { return getComputedStyle(t).getPropertyValue(p); });
        put('imp|' + k, function () { t.setAttribute('style', ''); t.style.setProperty(p, v, 'important'); return t.style.cssText + ' ;; ' + t.style.getPropertyPriority(p); });
        put('rule|' + k, function () { while (sheet.cssRules.length) sheet.deleteRule(0); sheet.insertRule('.r { ' + p + ': ' + v + '; }', 0); return sheet.cssRules[0].cssText; });
        put('ruleget|' + k, function () { return sheet.cssRules[0].style.getPropertyValue(p); });
        put('attrin|' + k, function () { t.setAttribute('style', p + ':' + v); return t.style.cssText; });
    }
    t.setAttribute('style', '');

    window.__cssomStage = '// Longhands read back';
    // Longhands read back from a shorthand set, and a shorthand read back from longhands.
    var sh = [['margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], ['1px', '1px', '1px', '1px'], ['1px', '2px', '1px', '2px'], ['1px', '2px', '3px', '4px']],
        ['border', ['border-top-width', 'border-top-style', 'border-top-color', 'border-image-source']],
        ['background', ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat']],
        ['font', ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family', 'font-variant-caps', 'font-stretch']],
        ['flex', ['flex-grow', 'flex-shrink', 'flex-basis']],
        ['transition', ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior']],
        ['animation', ['animation-name', 'animation-duration', 'animation-iteration-count', 'animation-fill-mode', 'animation-timeline']],
        ['grid', ['grid-template-rows', 'grid-template-columns', 'grid-template-areas', 'grid-auto-flow']],
        ['inset', ['top', 'right', 'bottom', 'left']], ['place-items', ['align-items', 'justify-items']], ['gap', ['row-gap', 'column-gap']]];
    sh.forEach(function (s) {
        (curated[s[0]] || []).forEach(function (v) {
            s[1].forEach(function (lh) { put('long|' + s[0] + '|' + v + '|' + lh, function () { t.setAttribute('style', ''); t.style.setProperty(s[0], v); return t.style.getPropertyValue(lh); }); });
        });
        for (var j = 2; j < s.length; j++) {
            var vals = s[j];
            put('fromlong|' + s[0] + '|' + vals.join(','), function () { t.setAttribute('style', ''); s[1].forEach(function (lh, n) { t.style.setProperty(lh, vals[n]); }); return t.style.getPropertyValue(s[0]) + ' ;; ' + t.style.cssText; });
        }
    });
    put('fromlong|border-mixed', function () { t.setAttribute('style', 'border: 1px solid red; border-top-color: blue'); return t.style.cssText + ' ;; ' + t.style.getPropertyValue('border'); });
    put('fromlong|font-partial', function () { t.setAttribute('style', 'font: 12px serif; font-weight: bold'); return t.style.cssText; });
    put('fromlong|imp-mixed', function () { t.setAttribute('style', 'margin: 1px; margin-top: 2px !important'); return t.style.cssText + ' ;; ' + t.style.getPropertyValue('margin'); });
    put('attr|dup', function () { t.setAttribute('style', 'color: red; color: blue; COLOR: green'); return t.style.cssText + ' ;; ' + t.style.length; });
    put('attr|item', function () { t.setAttribute('style', 'margin: 1px; color: red'); var a = []; for (var n = 0; n < t.style.length; n++) a.push(t.style.item(n)); return a.join(','); });
    put('attr|camel', function () { t.setAttribute('style', ''); t.style.backgroundColor = 'red'; t.style.cssFloat = 'left'; t.style.webkitTransform = 'scale(2)'; return t.style.cssText; });
    t.setAttribute('style', '');

    window.__cssomStage = '// Rule text:';
    // Rule text: at-rules through insertRule and through a parsed <style>.
    var rules = ['@media screen and (min-width: 100px) { .a { color: red; } }', '@media (min-width:100px) and (max-width:200px){.a{color:red}}', '@media not print, (hover) { }',
        '@media (width >= 600px) { .a { color: red } }', '@media screen and (-webkit-min-device-pixel-ratio: 2) { }', '@media (prefers-color-scheme: dark) { .a { color: red } }',
        '@supports (display: grid) { .a { display: grid } }', '@supports not (display:foo) { }', '@supports (display: grid) and (not (display: inline-grid)) { }',
        '@supports selector(:has(a)) { }', '@supports font-tech(color-COLRv1) { }',
        '@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }', '@keyframes k { 0%, 50% { opacity: 0 } 100% { opacity: 1 } }',
        '@keyframes "q" { 10% { color: red } }', '@-webkit-keyframes w { from { color: red } }',
        '@font-face { font-family: "X"; src: url(x.woff2) format("woff2"), local(Arial); font-display: swap; unicode-range: U+0-7F; }',
        '@font-face { font-family: Y; src: url("y.ttf"); font-weight: 100 900; }',
        '@container (min-width: 400px) { .a { color: red } }', '@container card (width > 10px) { }', '@container style(--x: 1) { }',
        '@layer a;', '@layer a, b;', '@layer a { .x { color: red } }', '@layer { .x { color: red } }',
        '@namespace svg url(http://www.w3.org/2000/svg);', '@page { margin: 1cm }', '@page :first { margin: 2cm }',
        '@property --p { syntax: "<length>"; inherits: false; initial-value: 0px; }', '@counter-style c { system: cyclic; symbols: "*"; }',
        '@font-feature-values Font One { @styleset { nice-style: 12; } }', '@scope (.a) to (.b) { .c { color: red } }', '@starting-style { .a { opacity: 0 } }',
        '.a { color: red; & .b { color: blue } }', '.a:hover > .b ~ .c + .d, #e::before { color: red }', 'a[href^="x" i] { color: red }', '*|a, svg|rect { color: red }',
        ':is(.a, .b) :where(.c) :not(.d, .e) :has(> img) { color: red }', ':nth-child(2n + 1 of .a) { color: red }', 'div::after { content: "\\201C"; }',
        '.a { --x: { b }; }', '.a { color: red !important; margin: 1px }', '.a { background: url(img.png) }'];
    rules.forEach(function (r, n) {
        put('insert|' + r, function () { while (sheet.cssRules.length) sheet.deleteRule(0); sheet.insertRule(r, 0); var rr = sheet.cssRules[0]; return rr.cssText + ' ;; ' + rr.constructor.name + ' ;; ' + (rr.cssRules ? rr.cssRules.length : '-'); });
        put('parsed|' + r, function () { styleEl.textContent = r; var rr = styleEl.sheet.cssRules[0]; return rr ? rr.cssText : 'none'; });
    });
    styleEl.textContent = '@keyframes kf { from { color: red } to { color: blue } }';
    put('kf|api', function () { var k = styleEl.sheet.cssRules[0]; k.appendRule('50% { color: green }'); var a = [k.name, k.cssRules.length, k.findRule('50%') && k.findRule('50%').keyText, k.cssRules[0].keyText]; k.deleteRule('from'); a.push(k.cssText); return a.join(' ;; '); });
    styleEl.textContent = '@media screen { .a { color: red } }';
    put('media|api', function () { var m = styleEl.sheet.cssRules[0]; m.media.appendMedium('print'); return [m.media.mediaText, m.media.length, m.conditionText, m.cssText].join(' ;; '); });
    put('medialist|', function () { styleEl.textContent = '@media SCREEN AND (MIN-WIDTH: 100PX), print { }'; return styleEl.sheet.cssRules[0].media.mediaText; });
    put('selectorText|', function () { styleEl.textContent = 'A > B.C , D{}'; var r = styleEl.sheet.cssRules[0]; var a = r.selectorText; r.selectorText = 'x  y'; return a + ' ;; ' + r.selectorText; });
    styleEl.textContent = '';

    window.__cssomStage = '// url() resolution';
    // url() resolution against the stylesheet base, and quoting.
    ['u1', 'u2', 'u3', 'u4'].forEach(function (id) {
        var el = document.getElementById(id);
        ['background-image', 'cursor', 'list-style-image'].forEach(function (p) { put('url-cs|' + id + '|' + p, function () { return getComputedStyle(el).getPropertyValue(p); }); });
    });
    for (var s = 0; s < document.styleSheets.length; s++) {
        (function (sh, s) {
            put('sheet|' + s + '|href', function () { return sh.href; });
            for (var r = 0; r < sh.cssRules.length; r++) (function (r) { put('sheet|' + s + '|' + r, function () { return sh.cssRules[r].cssText; }); })(r);
        })(document.styleSheets[s], s);
    }
    put('url-inline|', function () { t.style.backgroundImage = 'url(img.png)'; return t.style.backgroundImage + ' ;; ' + getComputedStyle(t).backgroundImage; });
    put('url-cssss|', function () { var c = new CSSStyleSheet({ baseURL: origin + '/deep/dir/' }); c.replaceSync('.a { background: url(img.png) }'); return c.cssRules[0].cssText; });
    t.setAttribute('style', '');

    window.__cssomStage = '// Specified vs computed';
    // Specified vs computed for a few classic cases on an attached element.
    var comp = [['width', '50%'], ['margin-left', 'auto'], ['line-height', 'normal'], ['line-height', '1.5'], ['line-height', '150%'], ['font-size', 'larger'],
        ['font-size', 'medium'], ['font-weight', 'bolder'], ['color', 'currentcolor'], ['border-top-width', 'thin'], ['border-top-width', 'medium'], ['border-top-style', 'none'],
        ['transform', 'rotate(90deg)'], ['transform', 'translate(10px)'], ['top', 'calc(10% + 5px)'], ['position', 'relative'], ['opacity', '0.333333333'],
        ['z-index', 'auto'], ['letter-spacing', 'normal'], ['vertical-align', 'calc(1px + 1px)'], ['font-family', '"Arial", serif'], ['display', 'inline flex'],
        ['background-position', 'center'], ['transition', 'opacity 1s'], ['animation', 'spin 1s'], ['grid-template-columns', 'repeat(2, 10px)'], ['flex', '1'],
        ['text-decoration', 'underline'], ['outline', '1px solid red'], ['color', 'color-mix(in srgb, red 50%, blue)'], ['color', 'oklch(0.5 0.1 120)'],
        ['color', 'hsl(120 50% 50%)'], ['color', 'lab(50% 20 30)'], ['color', 'color(display-p3 1 0 0)'], ['color', 'rgb(1 2 3 / 0.5)'], ['color', 'transparent']];
    comp.forEach(function (c) {
        put('comp|' + c[0] + '|' + c[1], function () { t.setAttribute('style', 'position: relative; width: 200px; font-size: 16px; ' + c[0] + ': ' + c[1]); return getComputedStyle(t).getPropertyValue(c[0]); });
    });
    t.setAttribute('style', '');
    put('cs|length', function () { return getComputedStyle(t).length > 300; });
    put('cs|item0', function () { return getComputedStyle(t).item(0); });
    put('cs|cssText', function () { return JSON.stringify(getComputedStyle(t).cssText); });
    put('supports|cond', function () { return [CSS.supports('(display: grid)'), CSS.supports('display: grid'), CSS.supports('(display: grid) and (color: red)'), CSS.supports('selector(:has(a))'),
        CSS.supports('not (display: foo)'), CSS.supports('(--x: 1)'), CSS.supports('--x', '{'), CSS.supports('color', 'red !important'), CSS.supports('font-tech(color-colrv1)'), CSS.supports('font-format(woff2)')].join(','); });
    put('escape|', function () { return [CSS.escape('a b'), CSS.escape('1a'), CSS.escape('-'), CSS.escape('\u0000'), CSS.escape('a\u0080')].join('|'); });

    window.__cssom = JSON.stringify({ count: Object.keys(out).length, results: out });
    document.title = 'done';
})(); } catch (e) { window.__cssom = JSON.stringify({ error: String(e && e.stack || e), stage: window.__cssomStage, results: {} }); }
