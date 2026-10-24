// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: a script realm per same-site child navigable (M6, docs/architecture.md "Frame realms").
// The segment Worker's V8 has one global, the principal window's. A same-site frame's window gets a global of its own
// here: an ordinary object that the mirror fills from the frame's engine Window (its prototypes are the frame realm's,
// so its interface objects are its own), behind a WindowProxy that stays the same object across the frame's
// navigations. The frame's classic scripts run against it through a fixed wrapper:
//
//   (function (__chitin_r) { with (__chitin_r.g) with (__chitin_r.w) with (__chitin_r.l) { <prologue> <script> } })
//
// `l` holds the frame's global lexical declarations (top-level let/const/class shared by its scripts), `w` is the frame's
// global object and `g` a guard that hides the principal window's own names from the frame (a read gives undefined
// instead of the parent's value; a sloppy assignment lands on the frame's global). The prologue, on the script's first
// line, registers the script's top-level function and lexical declarations with the realm; its top-level `var`s are
// created on the frame's global before it runs. A strict script ("use strict" directive) runs in a strict function
// inside the wrapper (a `with` is not allowed in strict code), its top-level vars registered as live accessors.
// The ECMAScript built-ins (Object, Array, Promise...) are the Worker's, shared by every realm of the segment: the known
// residue (docs/surface.md). The scanner below finds the declarations without a full parser: it tracks strings,
// comments, template literals, regular expression literals and brackets, and descends only into statement blocks.

const RealmsMap = globalThis.Map;
const RealmsSet = globalThis.Set;
const RealmsMapGet = uncurryThis(RealmsMap.prototype.get);
const RealmsMapSet = uncurryThis(RealmsMap.prototype.set);
const RealmsMapHas = uncurryThis(RealmsMap.prototype.has);
const RealmsMapDelete = uncurryThis(RealmsMap.prototype.delete);
const RealmsSetHas = uncurryThis(RealmsSet.prototype.has);
const RealmsSetAdd = uncurryThis(RealmsSet.prototype.add);
const RealmsSetDelete = uncurryThis(RealmsSet.prototype.delete);
const ArrayFromRealms = Array.from;
const RealmsPush = uncurryThis(Array.prototype.push);
const RealmsJoin = uncurryThis(Array.prototype.join);
const RealmsArrayIncludes = uncurryThis(Array.prototype.includes);
const RealmsSlice = uncurryThis(HostString.prototype.slice);
const RealmsJSONStringify = globalThis.JSON.stringify;
const RealmsSyntaxError = globalThis.SyntaxError;
const RealmsProxy = globalThis.Proxy;

// --- The declaration scanner ---------------------------------------------------------------------------------------
const KW_BEFORE_REGEX = new RealmsSet(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const BLOCK_HEADS = new RealmsSet(['if', 'for', 'while', 'with', 'switch', 'catch']);
const BLOCK_KEYWORDS = new RealmsSet(['else', 'try', 'finally', 'do']);

function isIdStart(c) {
    return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c > 127 || c === 92;
}
function isIdPart(c) {
    return isIdStart(c) || (c >= 48 && c <= 57);
}

// Tokens: { t: 'id' | 'p' (punctuator) | 'str' | 'num' | 're' | 'tpl', v, s (start offset), nl (a line break before) }.
function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    let nl = false;
    const tplDepth = []; // brace depth at each open ${ of a template literal
    let braces = 0;
    const last = () => out.length ? out[out.length - 1] : null;
    const regexAllowed = () => {
        const p = last();
        if (p === null)
            return true;
        if (p.t === 'num' || p.t === 'str' || p.t === 're' || p.t === 'tpl')
            return false;
        if (p.t === 'id')
            return RealmsSetHas(KW_BEFORE_REGEX, p.v);
        return p.v !== ')' && p.v !== ']' && p.v !== '}' && p.v !== '++' && p.v !== '--';
    };
    const readTemplate = (start) => {
        // From just after ` or }: to the closing ` or to ${.
        let j = start;
        while (j < n) {
            const c = StringPrototypeCharCodeAt(src, j);
            if (c === 92) { j += 2; continue; }
            if (c === 96) return { end: j + 1, open: false };
            if (c === 36 && StringPrototypeCharCodeAt(src, j + 1) === 123) return { end: j + 2, open: true };
            j++;
        }
        return { end: n, open: false };
    };
    while (i < n) {
        const c = StringPrototypeCharCodeAt(src, i);
        if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) { nl = true; i++; continue; }
        if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xA0 || c === 0xFEFF) { i++; continue; }
        if (c === 47) {
            const d = StringPrototypeCharCodeAt(src, i + 1);
            if (d === 47) {
                const e = StringPrototypeIndexOf(src, '\n', i);
                i = e < 0 ? n : e;
                continue;
            }
            if (d === 42) {
                const e = StringPrototypeIndexOf(src, '*/', i + 2);
                const end = e < 0 ? n : e + 2;
                if (StringPrototypeIncludes(RealmsSlice(src, i, end), '\n'))
                    nl = true;
                i = end;
                continue;
            }
            if (regexAllowed()) {
                let j = i + 1, cls = false;
                while (j < n) {
                    const r = StringPrototypeCharCodeAt(src, j);
                    if (r === 92) { j += 2; continue; }
                    if (r === 10) break;
                    if (cls) { if (r === 93) cls = false; }
                    else if (r === 91) cls = true;
                    else if (r === 47) break;
                    j++;
                }
                j++;
                while (j < n && isIdPart(StringPrototypeCharCodeAt(src, j))) j++;
                RealmsPush(out, { t: 're', v: '', s: i, nl });
                nl = false;
                i = j;
                continue;
            }
        }
        if (c === 39 || c === 34) {
            let j = i + 1;
            while (j < n) {
                const r = StringPrototypeCharCodeAt(src, j);
                if (r === 92) { j += 2; continue; }
                if (r === c || r === 10) break;
                j++;
            }
            RealmsPush(out, { t: 'str', v: RealmsSlice(src, i + 1, j), s: i, nl });
            nl = false;
            i = j + 1;
            continue;
        }
        if (c === 96) {
            const r = readTemplate(i + 1);
            RealmsPush(out, { t: 'tpl', v: '', s: i, nl });
            nl = false;
            if (r.open) { RealmsPush(tplDepth, braces); braces++; }
            i = r.end;
            continue;
        }
        if (c === 125 && tplDepth.length && tplDepth[tplDepth.length - 1] === braces - 1) {
            // The } that closes a template substitution: the template goes on.
            braces--;
            ArrayPrototypePopRealms(tplDepth);
            const r = readTemplate(i + 1);
            if (r.open) { RealmsPush(tplDepth, braces); braces++; }
            const p = last();
            if (p !== null && p.t !== 'tpl') RealmsPush(out, { t: 'tpl', v: '', s: i, nl: false });
            i = r.end;
            continue;
        }
        if (isIdStart(c)) {
            let j = i + 1;
            while (j < n && isIdPart(StringPrototypeCharCodeAt(src, j))) j++;
            RealmsPush(out, { t: 'id', v: RealmsSlice(src, i, j), s: i, nl });
            nl = false;
            i = j;
            continue;
        }
        if ((c >= 48 && c <= 57) || (c === 46 && StringPrototypeCharCodeAt(src, i + 1) >= 48 && StringPrototypeCharCodeAt(src, i + 1) <= 57)) {
            let j = i + 1;
            while (j < n) {
                const r = StringPrototypeCharCodeAt(src, j);
                if (isIdPart(r) || r === 46) j++;
                else if ((r === 43 || r === 45) && (StringPrototypeCharCodeAt(src, j - 1) | 32) === 101 && !(StringPrototypeCharCodeAt(src, i + 1) === 120 || StringPrototypeCharCodeAt(src, i + 1) === 88)) j++;
                else break;
            }
            RealmsPush(out, { t: 'num', v: '', s: i, nl });
            nl = false;
            i = j;
            continue;
        }
        // Punctuators: the ones the scanner cares about are single characters, plus ++ -- => ?. ...
        let v = src[i];
        const two = RealmsSlice(src, i, i + 2);
        if (two === '++' || two === '--' || two === '=>' || two === '?.')
            v = two;
        else if (RealmsSlice(src, i, i + 3) === '...')
            v = '...';
        if (v === '{') braces++;
        else if (v === '}') braces--;
        RealmsPush(out, { t: 'p', v, s: i, nl });
        nl = false;
        i += v.length;
    }
    return out;
}
const ArrayPrototypePopRealms = uncurryThis(Array.prototype.pop);

// The names a binding pattern binds, from token k; returns the index after the pattern.
function bindingNames(toks, k, names) {
    const tok = toks[k];
    if (tok === undefined)
        return k;
    if (tok.t === 'id') {
        RealmsPush(names, tok.v);
        return k + 1;
    }
    if (tok.t !== 'p' || (tok.v !== '{' && tok.v !== '['))
        return k + 1;
    const object = tok.v === '{';
    const close = object ? '}' : ']';
    k++;
    while (k < toks.length && !(toks[k].t === 'p' && toks[k].v === close)) {
        const t = toks[k];
        if (t.t === 'p' && t.v === ',') { k++; continue; }
        if (t.t === 'p' && t.v === '...') { k = bindingNames(toks, k + 1, names); continue; }
        if (object) {
            // key: pattern | key = default | key | [computed]: pattern
            let keyEnd = k + 1;
            if (t.t === 'p' && t.v === '[')
                keyEnd = skipBalanced(toks, k);
            const after = toks[keyEnd];
            if (after && after.t === 'p' && after.v === ':') {
                k = bindingNames(toks, keyEnd + 1, names);
            } else {
                if (t.t === 'id')
                    RealmsPush(names, t.v);
                k = keyEnd;
            }
        } else {
            k = bindingNames(toks, k, names);
        }
        if (toks[k] && toks[k].t === 'p' && toks[k].v === '=')
            k = skipExpression(toks, k + 1, true);
    }
    return k + 1;
}
// From an opening bracket at k: the index after its partner.
function skipBalanced(toks, k) {
    let depth = 0;
    for (; k < toks.length; k++) {
        const t = toks[k];
        if (t.t !== 'p') continue;
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
            depth--;
            if (depth === 0) return k + 1;
        }
    }
    return k;
}
// An initializer: up to a comma (or, with inPattern, a closing bracket) at depth 0, a ; or a line break that ends
// the statement (ASI before a keyword that starts one).
function skipExpression(toks, k, inPattern) {
    for (; k < toks.length; k++) {
        const t = toks[k];
        if (t.t === 'p') {
            if (t.v === '(' || t.v === '[' || t.v === '{') { k = skipBalanced(toks, k) - 1; continue; }
            if (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}') return k;
        } else if (!inPattern && t.nl && t.t === 'id' && (t.v === 'var' || t.v === 'let' || t.v === 'const' || t.v === 'function' || t.v === 'class' || t.v === 'if' || t.v === 'for' || t.v === 'return')) {
            return k;
        }
    }
    return k;
}
// Declarators after var/let/const at k: the names, and the index after the list.
function declarators(toks, k, names) {
    for (;;) {
        k = bindingNames(toks, k, names);
        const t = toks[k];
        if (t && t.t === 'p' && t.v === '=')
            k = skipExpression(toks, k + 1, false);
        const u = toks[k];
        if (u && u.t === 'p' && u.v === ',') { k++; continue; }
        return k;
    }
}

// Top-level declarations of a classic script: { strict, directiveEnd (offset after the directive prologue), vars,
// functions, lexicals: [[name, kind]] }.
function scanScript(src, isModule) {
    const toks = tokenize(src);
    const vars = [], functions = [], lexicals = [];
    let strict = false, directiveEnd = 0;
    let k = 0;
    // The directive prologue: string literal statements at the start.
    while (k < toks.length && toks[k].t === 'str') {
        const next = toks[k + 1];
        if (next && !(next.t === 'p' && next.v === ';') && !next.nl && !(next.t === 'p' && next.v === '}'))
            break;
        if (toks[k].v === 'use strict')
            strict = true;
        k++;
        if (toks[k] && toks[k].t === 'p' && toks[k].v === ';') k++;
        directiveEnd = k < toks.length ? toks[k].s : src.length;
    }
    if (k === 0 || !strict)
        directiveEnd = 0;
    // The statement blocks the scan is in (it descends into those only; a function body, a class body or an object
    // literal is skipped).
    const stack = [];
    let parenHead = null;
    const parens = [];
    const atStatementStart = (j) => {
        if (j === 0) return true;
        const p = toks[j - 1];
        if (p.t === 'p') return p.v === ';' || p.v === '}' || p.v === '{';
        // A module's `export function`, `export default class`: the declaration after export is one.
        if (isModule && (p.v === 'export' || (p.v === 'default' && j > 1 && toks[j - 2].v === 'export'))) return true;
        return toks[j].nl && p.t !== 'p';
    };
    for (; k < toks.length; k++) {
        const t = toks[k];
        const depth0 = stack.length === 0 && parens.length === 0;
        if (t.t === 'p') {
            if (t.v === '(') {
                const p = toks[k - 1];
                RealmsPush(parens, p && p.t === 'id' ? p.v : '');
                continue;
            }
            if (t.v === ')') {
                parenHead = ArrayPrototypePopRealms(parens);
                // The next { after `if (...)` is a block.
                const nx = toks[k + 1];
                if (nx && nx.t === 'p' && nx.v === '{') {
                    if (RealmsSetHas(BLOCK_HEADS, parenHead) && parens.length === 0) {
                        RealmsPush(stack, true);
                        k++;
                    } else {
                        k = skipBalanced(toks, k + 1) - 1;
                    }
                }
                continue;
            }
            if (t.v === '{') {
                const p = toks[k - 1];
                const block = parens.length === 0 && (atStatementStart(k) || (p && p.t === 'id' && RealmsSetHas(BLOCK_KEYWORDS, p.v)));
                if (block)
                    RealmsPush(stack, true);
                else
                    k = skipBalanced(toks, k) - 1;
                continue;
            }
            if (t.v === '}') {
                ArrayPrototypePopRealms(stack);
                continue;
            }
            if (t.v === '[') { k = skipBalanced(toks, k) - 1; continue; }
            continue;
        }
        if (t.t !== 'id')
            continue;
        const prev = toks[k - 1];
        const member = prev && prev.t === 'p' && (prev.v === '.' || prev.v === '?.');
        if (member)
            continue;
        if (isModule && t.v === 'import' && depth0 && atStatementStart(k)) {
            // import d, { a as b, c } from '...'; import * as ns from '...'; import '...' (no names)
            let j = k + 1;
            const nx = toks[j];
            if (nx && (nx.t === 'str' || (nx.t === 'p' && (nx.v === '(' || nx.v === '.'))))
                continue; // a bare import, or import() / import.meta
            for (; j < toks.length; j++) {
                const u = toks[j];
                if (u.t === 'str' || (u.t === 'id' && u.v === 'from'))
                    break;
                if (u.t === 'id' && u.v !== 'as' && u.v !== 'type') {
                    const after = toks[j + 1];
                    if (!(after && after.t === 'id' && after.v === 'as'))
                        RealmsPush(lexicals, [u.v, 'import']);
                }
            }
            k = j;
            continue;
        }
        if (t.v === 'var' && (parens.length === 0 || (parens.length === 1 && parens[0] === 'for'))) {
            k = declarators(toks, k + 1, vars) - 1;
            continue;
        }
        if ((t.v === 'let' || t.v === 'const') && depth0) {
            const nx = toks[k + 1];
            if (nx && (nx.t === 'id' || (nx.t === 'p' && (nx.v === '{' || nx.v === '[')))) {
                const names = [];
                k = declarators(toks, k + 1, names) - 1;
                for (let i = 0; i < names.length; i++) RealmsPush(lexicals, [names[i], t.v]);
            }
            continue;
        }
        if (t.v === 'class' && atStatementStart(k)) {
            const nx = toks[k + 1];
            if (depth0 && nx && nx.t === 'id' && nx.v !== 'extends')
                RealmsPush(lexicals, [nx.v, 'class']);
            // Skip to the class body and over it.
            let j = k + 1;
            while (j < toks.length && !(toks[j].t === 'p' && toks[j].v === '{')) {
                if (toks[j].t === 'p' && (toks[j].v === '(' || toks[j].v === '[')) j = skipBalanced(toks, j);
                else j++;
            }
            k = skipBalanced(toks, j) - 1;
            continue;
        }
        if (t.v === 'function' && (atStatementStart(k) || (prev && prev.t === 'id' && prev.v === 'async' && atStatementStart(k - 1)))) {
            let j = k + 1;
            if (toks[j] && toks[j].t === 'p' && toks[j].v === '*') j++;
            if (depth0 && toks[j] && toks[j].t === 'id')
                RealmsPush(functions, toks[j].v);
            // Over the parameters and the body.
            while (j < toks.length && !(toks[j].t === 'p' && toks[j].v === '(')) j++;
            j = skipBalanced(toks, j);
            k = skipBalanced(toks, j) - 1;
            continue;
        }
    }
    // The shared names the script refers to (bound once per script, below).
    const used = [];
    const seen = new RealmsSet();
    for (let j = 0; j < toks.length; j++) {
        const t = toks[j];
        if (t.t !== 'id' || !RealmsSetHas(BINDABLE, t.v) || RealmsSetHas(seen, t.v))
            continue;
        const p = toks[j - 1];
        if (p && p.t === 'p' && (p.v === '.' || p.v === '?.'))
            continue;
        RealmsSetAdd(seen, t.v);
        RealmsPush(used, t.v);
    }
    // A module: every name it refers to (for the frame realm's prologue, moduleBindings).
    let ids = null;
    if (isModule) {
        ids = [];
        const all = new RealmsSet();
        for (let j = 0; j < toks.length; j++) {
            const t = toks[j];
            if (t.t !== 'id' || RealmsSetHas(all, t.v))
                continue;
            const p = toks[j - 1];
            if (p && p.t === 'p' && (p.v === '.' || p.v === '?.'))
                continue;
            RealmsSetAdd(all, t.v);
            RealmsPush(ids, t.v);
        }
    }
    return { strict, directiveEnd, vars, functions, lexicals, used, ids };
}

// --- Compiling a frame's classic script ----------------------------------------------------------------------------
function identifierList(names) {
    const out = [];
    for (let i = 0; i < names.length; i++) RealmsPush(out, RealmsJSONStringify(names[i]));
    return RealmsJoin(out, ',');
}
// The wrapper text for a script; `info` from scanScript. The script's body is a function body (strict when its directive
// says so), so its own top-level declarations are that function's bindings: references to them inside the script resolve
// statically, as fast as in a real script. The realm sees them through accessors registered by the prologue (live: a
// later assignment in either direction is seen by the other). The shared names the script uses (the ECMAScript globals,
// `window`, `document`...) are the parameters of the function around it, bound once when the script starts; only the
// other names go through the with-statements, at the cost of a dynamic lookup.
function frameScriptText(src, info) {
    const own = new RealmsSet();
    const entries = (names, out) => {
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (RealmsSetHas(own, name))
                continue;
            RealmsSetAdd(own, name);
            RealmsPush(out, '[' + RealmsJSONStringify(name) + ',()=>' + name + ',(__chitin_v)=>' + name + '=__chitin_v]');
        }
    };
    const vars = [], lex = [];
    entries(info.functions, vars);
    entries(info.vars, vars);
    const lexNames = [];
    for (let i = 0; i < info.lexicals.length; i++) RealmsPush(lexNames, info.lexicals[i][0]);
    entries(lexNames, lex);
    const params = [];
    for (let i = 0; i < info.used.length; i++) {
        if (!RealmsSetHas(own, info.used[i]))
            RealmsPush(params, info.used[i]);
    }
    info.params = params;
    const prologue = (vars.length || lex.length) ? '__chitin_r.d([' + RealmsJoin(vars, ',') + '],[' + RealmsJoin(lex, ',') + ']);' : '';
    const head = RealmsSlice(src, 0, info.directiveEnd);
    const rest = RealmsSlice(src, info.directiveEnd);
    return '(function(__chitin_r){with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)return function(' + RealmsJoin(params, ',')
        + '){' + head + prologue + rest + '\n}.apply(__chitin_r.t,__chitin_r.b)})';
}

// --- Frame realms --------------------------------------------------------------------------------------------------
// The ECMAScript globals every realm has (the Worker's, shared): names the guard never hides and every frame
// global carries as its own properties.
const ES_GLOBALS = ['globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent',
    'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array',
    'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array', 'Function', 'Int8Array',
    'Int16Array', 'Int32Array', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect',
    'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'Intl', 'WebAssembly', 'console', 'DisposableStack', 'AsyncDisposableStack', 'SuppressedError'];
const esGlobalDescriptors = [];
function captureESGlobals() {
    for (let i = 0; i < ES_GLOBALS.length; i++) {
        const d = ObjectGetOwnPropertyDescriptor(G, ES_GLOBALS[i]);
        if (d !== undefined && ES_GLOBALS[i] !== 'globalThis')
            RealmsPush(esGlobalDescriptors, [ES_GLOBALS[i], d]);
    }
}
captureESGlobals();
const ES_GLOBAL_SET = new RealmsSet(ES_GLOBALS);
// Bound per script: the ECMAScript globals (but not eval: a direct eval must stay one) and the Window members that a
// script cannot replace ([LegacyUnforgeable] window, document; the WindowProxy's own names).
const STATIC_WINDOW_NAMES = ['window', 'self', 'globalThis', 'document', 'frames'];
const BINDABLE = new RealmsSet();
for (let i = 0; i < ES_GLOBALS.length; i++) if (ES_GLOBALS[i] !== 'eval') RealmsSetAdd(BINDABLE, ES_GLOBALS[i]);
for (let i = 0; i < STATIC_WINDOW_NAMES.length; i++) RealmsSetAdd(BINDABLE, STATIC_WINDOW_NAMES[i]);

const compiledScripts = new RealmsMap(); // source text -> { fn, info } (a frame that reloads runs the same scripts)
function compileFrameScript(source, filename) {
    const key = filename + '\n' + source;
    let entry = RealmsMapGet(compiledScripts, key);
    if (entry === undefined) {
        const info = scanScript(source);
        const fn = indirectEval(frameScriptText(source, info) + '\n//# sourceURL=' + filename);
        entry = { fn, info };
        if (compiledScripts.size > 512) compiledScripts.clear();
        RealmsMapSet(compiledScripts, key, entry);
    }
    return entry;
}

// A frame realm: `global` (the frame's global object, the target of the scope), `proxy` (its WindowProxy), the
// lexical record and the guard. Made by makeFrameRealm in the bridge, which fills the global.
function makeRealmRecord(global, proxy) {
    const lexical = ObjectCreate(null);
    const lexicalNames = new RealmsMap();
    const guard = new RealmsProxy(ObjectCreate(null), {
        __proto__: null,
        // Names the frame does not have but the principal window does: the frame must not see the parent's value. A
        // name neither has falls through to the Worker's global, where a read throws a ReferenceError as it should.
        // A sloppy assignment to a name nobody has lands on the Worker's global (the lookup fell through to it): the name is
        // remembered here, and the property is moved to the frame's global at the frame's next lookup of it (or after the
        // script, or at the next microtask checkpoint, whichever comes first).
        has(t, key) {
            if (typeof key !== 'string' || RealmsSetHas(ES_GLOBAL_SET, key) || key === '__chitin_r')
                return false;
            if (!ReflectHas(G, key)) {
                RealmsSetAdd(misses, key);
                scheduleAdopt();
                return false;
            }
            if (RealmsSetHas(misses, key) && adoptOne(key))
                return true;
            // Made on the principal window by this frame's running script (`this.name = ...`): the frame's (below).
            if (record.before !== null && !RealmsSetHas(record.before, key) && adoptOne(key))
                RealmsSetAdd(record.madeNames, key);
            return true;
        },
        get(t, key) {
            if (key === SymbolUnscopables) return undefined;
            return ReflectGet(global, key);
        },
        set(t, key, value) {
            return ReflectSet(global, key, value);
        },
        deleteProperty(t, key) {
            return ReflectDeleteProperty(global, key);
        },
    });
    const misses = new RealmsSet();
    let adoptScheduled = false;
    const adoptOne = (key) => {
        const d = ObjectGetOwnPropertyDescriptor(G, key);
        if (d === undefined || !d.configurable || !ObjectHasOwn(d, 'value') || !d.enumerable || ObjectHasOwn(global, key))
            return false;
        if (!ReflectDeleteProperty(G, key))
            return false;
        RealmsSetDelete(misses, key);
        ObjectDefineProperty(global, key, d);
        return true;
    };
    const adoptAll = () => {
        adoptScheduled = false;
        const names = ArrayFromRealms(misses);
        for (let i = 0; i < names.length; i++) {
            if (ObjectHasOwn(G, names[i]))
                adoptOne(names[i]);
        }
        if (misses.size > 4096)
            misses.clear();
    };
    const scheduleAdopt = () => {
        if (adoptScheduled || HostQueueMicrotask === null)
            return;
        adoptScheduled = true;
        HostQueueMicrotask(adoptAll);
    };
    const record = {
        __proto__: null,
        adoptAll,
        adoptName: (key) => RealmsSetHas(misses, key) && adoptOne(key),
        varNames: new RealmsSet(),
        madeNames: new RealmsSet(), // names the frame's code put on the principal window through `this` (moved here)
        before: null,               // the principal window's own names when the running script of this frame began
        global,
        proxy,
        lexical,
        lexicalNames,
        runtime: {
            __proto__: null,
            g: guard,
            w: global,
            l: lexical,
            t: proxy,
            b: null,
            d(vars, lex) {
                for (let i = 0; i < vars.length; i++) {
                    const [name, get, set] = vars[i];
                    RealmsSetAdd(record.varNames, name);
                    if (lentRecord === record)
                        lendOne(record, name);
                    const d = ObjectGetOwnPropertyDescriptor(global, name);
                    if (d === undefined || d.configurable)
                        ObjectDefineProperty(global, name, { get, set, enumerable: true, configurable: false });
                    else if (ObjectHasOwn(d, 'value') && d.writable)
                        global[name] = get();
                }
                for (let i = 0; i < lex.length; i++) {
                    const [name, get, set] = lex[i];
                    RealmsMapSet(lexicalNames, name, true);
                    ObjectDefineProperty(lexical, name, { get, set, enumerable: false, configurable: true });
                }
            },
        },
    };
    return record;
}

// A sloppy function's default `this` (and the `this` of a function called without a receiver) is its realm's global, and
// every function of a frame's scripts is the Worker realm's: `(function () { this.locale_data.duckduckgo = ... })()` in a
// frame's script (DuckDuckGo's util.js) reaches the principal window, the Worker's global. Its prototype chain cannot
// be changed (a [Global] interface's chain is immutable), so while a frame's classic script runs the frame's own
// globals (its declared vars and functions, the names it made) are lent to the principal window as accessors to the
// frame's global, for the names the principal window does not have, and taken back after the script; a property the
// script created on the principal window meanwhile (`this.name = ...`) is moved to the frame's global. Names the
// principal window has (`this.document`) stay its own (docs/surface.md); callbacks the frame's code left behind do
// not borrow anything.
const lentNames = [];
let lentRecord = null;
function lendOne(record, name) {
    if (typeof name !== 'string' || ObjectHasOwn(G, name) || RealmsSetHas(ES_GLOBAL_SET, name))
        return;
    const global = record.global;
    const get = function () { return ReflectGet(global, name); };
    const set = function (value) { ReflectSet(global, name, value); };
    ObjectDefineProperty(G, name, { get, set, enumerable: false, configurable: true });
    RealmsPush(lentNames, [name, get]);
}
function lendFrameNames(record) {
    lentRecord = record;
    for (const name of record.varNames) lendOne(record, name);
    for (const name of record.madeNames) lendOne(record, name);
}
function takeBackFrameNames() {
    for (let i = 0; i < lentNames.length; i++) {
        const [name, get] = lentNames[i];
        const d = ObjectGetOwnPropertyDescriptor(G, name);
        if (d !== undefined && d.get === get)
            ReflectDeleteProperty(G, name);
    }
    lentNames.length = 0;
    lentRecord = null;
}
// The principal window's own names before a frame's script: what is new after it is the frame's.
function principalKeys() {
    return new RealmsSet(ReflectOwnKeys(G));
}
function moveMadeNames(record, before) {
    const after = ReflectOwnKeys(G);
    if (after.length === before.size)
        return;
    for (let i = 0; i < after.length; i++) {
        const key = after[i];
        if (typeof key !== 'string' || RealmsSetHas(before, key))
            continue;
        const d = ObjectGetOwnPropertyDescriptor(G, key);
        if (d === undefined || !d.configurable || ObjectHasOwn(record.global, key))
            continue;
        if (!ReflectDeleteProperty(G, key))
            continue;
        ObjectDefineProperty(record.global, key, d);
        RealmsSetAdd(record.madeNames, key);
    }
}

// Runs a classic script of the frame realm `record`.
function runFrameScript(record, source, filename) {
    const { fn, info } = compileFrameScript(source, filename);
    // The realm a script of this URL runs in, for the incumbent of calls from host jobs (40-bridge.js callerRealmCell).
    if (typeof noteScriptRealm === 'function')
        noteScriptRealm(filename, record.global);
    // A redeclared global lexical is the page's SyntaxError, as in a real realm.
    for (let i = 0; i < info.lexicals.length; i++) {
        const name = info.lexicals[i][0];
        if (RealmsMapHas(record.lexicalNames, name))
            throw new RealmsSyntaxError("Identifier '" + name + "' has already been declared");
    }
    const global = record.global;
    const params = info.params;
    const values = [];
    for (let i = 0; i < params.length; i++)
        values[i] = ReflectGet(global, params[i]);
    record.runtime.b = values;
    // A script inside another's (document.write, a frame's frame): the outer one's loan is taken back and made again after.
    const outer = lentRecord;
    if (outer !== null)
        takeBackFrameNames();
    const before = principalKeys();
    const outerBefore = record.before;
    record.before = before;
    lendFrameNames(record);
    try {
        return ReflectApply(fn, undefined, [record.runtime]);
    } finally {
        record.runtime.b = null;
        takeBackFrameNames();
        moveMadeNames(record, before);
        record.before = outerBefore;
        record.adoptAll(); // a sloppy assignment to an undeclared name (the guard above)
        if (outer !== null)
            lendFrameNames(outer);
        syncFrameIndices();
    }
}

// Event handler content attributes of a frame's document: the element, form and document scopes inside the frame's.
function frameHandlerFactory(record, scopeCount, source) {
    let code = '';
    for (let i = scopeCount - 1; i >= 0; i--)
        code += 'with (__chitin_scopes[' + i + ']) ';
    return HostFunction('__chitin_r', '__chitin_scopes', 'with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)' + code + 'return (' + source + '\n);');
}

// --- The realms of the segment's frames ----------------------------------------------------------------------------
let frameRealmsOn = false;
const realmByWindowCell = new RealmsMap();  // a frame Window's global object cell -> its realm record

function rawCell(fn, cell) {
    const mark = scratchTop;
    const o = slots(1), r = slots(1);
    writeObject(o, cell);
    const ok = fn(o, r);
    views();
    const out = ok && (u32[(r >>> 2) + 1] >>> 16) === TAG_OBJECT ? u32[r >>> 2] : 0;
    scratchTop = mark;
    return out;
}
function windowOfProxy(wpCell) {
    return rawCell(X.ganglion_v_window_proxy_window, wpCell);
}
function currentGlobalCell() {
    const mark = scratchTop;
    const g = slots(1);
    X.ganglion_js_current_global(g);
    views();
    const cell = u32[g >>> 2];
    scratchTop = mark;
    return cell;
}

// The page object for a frame's WindowProxy, made with each realm of the navigable (record.proxy). It forwards every
// operation to the global of the Window the navigable has *now*, so a reference kept across the frame's navigation
// still reaches the frame's current document; the object the page is handed is the current realm's (identity across a
// navigation is the residue, docs/surface.md). Each has a target of its own for the Proxy invariants: a page that defines
// a non-configurable property on its window (Scramjet's `$scramjet$rewrite`) gets it on the frame's global and on the
// target, so the definition is allowed and reads back as defined; other own properties read as configurable.
function makeWindowProxyObject(home, wpCell) {
    const target = ObjectCreate(null);
    const current = () => {
        const windowCell = windowOfProxy(wpCell);
        const record = windowCell === 0 ? null : realmForWindow(windowCell, wpCell);
        if (record === null)
            throw typeError('The frame has no window');
        return record;
    };
    // A non-configurable property the page fixed through this object: the target's answer stands (the invariants), the
    // current global's when it is this object's own realm.
    const fixed = (key) => {
        const d = ObjectGetOwnPropertyDescriptor(target, key);
        return d !== undefined && !d.configurable ? d : undefined;
    };
    const proxy = new RealmsProxy(target, {
        __proto__: null,
        get(t, key) {
            if (typeof key === 'string' && isArrayIndex(key))
                return indexedFrame(wpCell, key);
            const r = current();
            const f = fixed(key);
            if (f !== undefined && r !== home && ObjectHasOwn(f, 'value') && !f.writable)
                return f.value;
            r.adoptName(key);
            return ReflectGet(r.global, key);
        },
        set(t, key, value) { return ReflectSet(current().global, key, value); },
        has(t, key) {
            if (typeof key === 'string' && isArrayIndex(key))
                return indexedFrame(wpCell, key) !== undefined;
            if (fixed(key) !== undefined)
                return true;
            const r = current();
            r.adoptName(key);
            return ReflectHas(r.global, key);
        },
        deleteProperty(t, key) {
            if (fixed(key) !== undefined)
                return false;
            return ReflectDeleteProperty(current().global, key);
        },
        ownKeys(t) {
            const keys = ReflectOwnKeys(current().global);
            const own = ReflectOwnKeys(t);
            const seen = new RealmsSet(keys);
            for (let i = 0; i < own.length; i++) {
                if (!RealmsSetHas(seen, own[i]))
                    RealmsPush(keys, own[i]);
            }
            return keys;
        },
        getOwnPropertyDescriptor(t, key) {
            if (typeof key === 'string' && isArrayIndex(key)) {
                const child = indexedFrame(wpCell, key);
                return child === undefined ? undefined : { value: child, writable: false, enumerable: true, configurable: true };
            }
            const f = fixed(key);
            const record = current();
            if (f !== undefined) {
                if (record !== home || !ObjectHasOwn(f, 'value') || !f.writable)
                    return f;
                const now = ObjectGetOwnPropertyDescriptor(record.global, key);
                return { value: now !== undefined && ObjectHasOwn(now, 'value') ? now.value : f.value, writable: true, enumerable: f.enumerable, configurable: false };
            }
            record.adoptName(key);
            const d = ObjectGetOwnPropertyDescriptor(record.global, key);
            if (d === undefined)
                return undefined;
            if (RealmsSetHas(record.varNames, key) && d.get !== undefined)
                return { value: ReflectApply(d.get, record.global, []), writable: true, enumerable: true, configurable: true };
            d.configurable = true;
            return d;
        },
        defineProperty(t, key, d) {
            const record = current();
            const desc = { __proto__: null };
            if (ObjectHasOwn(d, 'value')) desc.value = d.value;
            if (ObjectHasOwn(d, 'writable')) desc.writable = d.writable;
            if (ObjectHasOwn(d, 'get')) desc.get = d.get;
            if (ObjectHasOwn(d, 'set')) desc.set = d.set;
            if (ObjectHasOwn(d, 'enumerable')) desc.enumerable = d.enumerable;
            if (d.configurable === false) {
                // As asked, on the global and on the target (whose answer must agree from now on).
                desc.configurable = false;
                if (!ReflectDefineProperty(record.global, key, desc))
                    return false;
                const full = ObjectGetOwnPropertyDescriptor(record.global, key);
                return ReflectDefineProperty(t, key, full);
            }
            if (fixed(key) !== undefined)
                return ReflectDefineProperty(t, key, d) && ReflectDefineProperty(record.global, key, d);
            desc.configurable = true;
            return ReflectDefineProperty(record.global, key, desc);
        },
        getPrototypeOf() { return ObjectGetPrototypeOf(current().global); },
        setPrototypeOf(t, proto) { return proto === ObjectGetPrototypeOf(current().global); },
        isExtensible() { return true; },
        preventExtensions() { return false; },
    });
    WeakMapPrototypeSet(cellOf, proxy, wpCell);
    return proxy;
}
// The page object for a frame's WindowProxy now: its current realm's.
function frameWindowProxy(wpCell) {
    const windowCell = windowOfProxy(wpCell);
    if (windowCell === 0)
        throw typeError('The frame has no window');
    return realmForWindow(windowCell, wpCell).proxy;
}

// `Function` of a frame realm: a function built from source text resolves its free names in the frame (a proxy's client code
// compiles the pages it rewrites with it, and `location` must be the frame's). The function is the Worker realm's
// (`instanceof Function` and Function.prototype are the shared ones); the text is checked by the host's Function first,
// so the errors are V8's.
function frameFunctionConstructor(record) {
    const ctor = { Function: function (...args) {
        const body = args.length ? HostString(args[args.length - 1]) : '';
        const params = [];
        for (let i = 0; i < args.length - 1; i++) RealmsPush(params, HostString(args[i]));
        const list = RealmsJoin(params, ',');
        ReflectApply(HostFunction, undefined, [...params, body]); // the early errors
        return HostFunction('__chitin_r', 'with(__chitin_r.g)with(__chitin_r.w)with(__chitin_r.l)return function anonymous(' + list + '\n) {\n' + body + '\n}')(record.runtime);
    } }.Function;
    ObjectDefineProperty(ctor, 'prototype', { value: HostFunction.prototype, writable: false, enumerable: false, configurable: false });
    ObjectDefineProperty(ctor, 'length', { value: 1, configurable: true });
    WeakSetPrototypeAdd(nativeFunctions, ctor);
    return ctor;
}

// frames[i] of a window (the WindowProxy's indexed properties: its document's child navigables, in order).
function indexedFrame(wpCell, key) {
    const entered = idleEntry();
    try {
        return vGet(wpCell, key);
    } finally {
        idleExit(entered);
    }
}
// The principal window's frames[i] (the Worker's global cannot have indexed properties of its own making): own data
// properties 0..length-1 kept in step with the engine's child navigables after each script, at each pump and when a frame
// realm appears, as Chrome shows them (enumerable, configurable, read-only).
let principalFrameCount = 0;
function syncFrameIndices() {
    if (!frameRealmsOn || globalCell === 0)
        return;
    let n = 0;
    const entered = idleEntry();
    try {
        const length = vGet(globalCell, 'length');
        n = typeof length === 'number' ? length : 0;
        for (let i = 0; i < n; i++) {
            const child = vGet(principalWindowProxyCell(), HostString(i));
            const d = ObjectGetOwnPropertyDescriptor(G, HostString(i));
            if (d === undefined || d.value !== child)
                ObjectDefineProperty(G, HostString(i), { value: child, writable: false, enumerable: true, configurable: true });
        }
    } catch {
        // a document going away: try again next time
    } finally {
        idleExit(entered);
    }
    for (let i = n; i < principalFrameCount; i++)
        ReflectDeleteProperty(G, HostString(i));
    principalFrameCount = n;
    syncFrameNames();
}
// The principal window's named frames (window[name], frames[name]: the document-tree child navigable target names, as
// reCAPTCHA's challenge frame finds its anchor with parent.frames[name]). Chrome answers them from the named properties
// object behind Window.prototype; here they are data properties on that object (WindowProperties, docs/surface.md),
// so the global's own names and Window.prototype's still win, kept in step with the iframes' name attributes.
let principalFrameNames = [];
function syncFrameNames() {
    if (!framesInstalled || F.nameGet === undefined)
        return;
    let windowProperties = null;
    try {
        windowProperties = ObjectGetPrototypeOf(ObjectGetPrototypeOf(G));
    } catch {
        return;
    }
    // Only the surface's named properties object (45-surface.js), never a prototype other objects share.
    if (windowProperties === null || ObjectGetOwnPropertyDescriptor(windowProperties, SymbolToStringTag) === undefined || windowProperties[SymbolToStringTag] !== 'WindowProperties')
        return;
    const names = [];
    const values = [];
    try {
        const doc = ReflectApply(F.documentGet, G, []);
        const list = ReflectApply(F.getElementsByTagName, doc, ['iframe']);
        const n = ReflectApply(F.collectionLength, list, []);
        for (let i = 0; i < n; i++) {
            const el = ReflectApply(F.collectionItem, list, [i]);
            const name = ReflectApply(F.nameGet, el, []);
            if (typeof name !== 'string' || name === '' || RealmsArrayIncludes(names, name))
                continue;
            const w = remoteUrl(el) !== null ? frameProxy(el) : ReflectApply(F.contentWindowGet, el, []);
            if (w === null || w === undefined)
                continue;
            RealmsPush(names, name);
            RealmsPush(values, w);
        }
    } catch {
        return; // a document going away: next time
    }
    for (let i = 0; i < principalFrameNames.length; i++)
        if (!RealmsArrayIncludes(names, principalFrameNames[i]))
            ReflectDeleteProperty(windowProperties, principalFrameNames[i]);
    for (let i = 0; i < names.length; i++) {
        const d = ObjectGetOwnPropertyDescriptor(windowProperties, names[i]);
        if (d === undefined || d.value !== values[i])
            ObjectDefineProperty(windowProperties, names[i], { value: values[i], writable: true, enumerable: false, configurable: true });
    }
    principalFrameNames = names;
}

// The realm of a frame's Window (its global object cell), made on first use: a global filled from the Window's members
// (bound to it), the ECMAScript globals, and the frame's WindowProxy for `window`, `self`, `globalThis` and `this`.
function realmForWindow(windowCell, wpCell) {
    let record = RealmsMapGet(realmByWindowCell, windowCell);
    if (record !== undefined)
        return record;
    if (wpCell === 0)
        wpCell = rawCell((o, r) => X.ganglion_v_get(o, keyBits('window'), r) === 0, windowCell);
    const protoCell = vPrototypeCell(windowCell);
    const cls = protoCell === 0 ? null : classForPrototype(protoCell);
    const global = ObjectCreate(cls !== null ? cls.prototype : HostObject.prototype);
    WeakMapPrototypeSet(cellOf, global, windowCell);
    record = makeRealmRecord(global, null);
    const proxy = makeWindowProxyObject(record, wpCell);
    record.proxy = proxy;
    record.runtime.t = proxy;
    record.windowCell = windowCell;
    record.wpCell = wpCell;
    record.id = nextRealmId++;
    RealmsMapSet(realmByWindowCell, windowCell, record);
    RealmsMapSet(realmById, record.id, record);
    for (let i = 0; i < esGlobalDescriptors.length; i++)
        ObjectDefineProperty(global, esGlobalDescriptors[i][0], esGlobalDescriptors[i][1]);
    ObjectDefineProperty(global, 'globalThis', { value: proxy, writable: true, enumerable: false, configurable: true });
    ObjectDefineProperty(global, 'Function', { value: frameFunctionConstructor(record), writable: true, enumerable: false, configurable: true });
    // The Window's members, from its prototype chain and its own properties, as own properties of the frame's global
    // (as the principal window's are of the Worker's global), bound to the frame's Window.
    const chain = [];
    for (let p = protoCell; p !== 0 && p !== objectPrototypeCell; p = vPrototypeCell(p))
        RealmsPush(chain, p);
    for (let i = chain.length - 1; i >= 0; i--) {
        const keys = vOwnKeys(chain[i]);
        for (let k = 0; k < keys.length; k++) {
            const key = keyToJS(keys[k]);
            if (key === 'constructor' || typeof key === 'symbol' || HOST_ONLY_GLOBALS[key] === true)
                continue;
            defineMember(global, chain[i], keys[k], key, global);
        }
        classForPrototype(chain[i]);
    }
    const own = vOwnKeys(windowCell);
    for (let k = 0; k < own.length; k++) {
        const key = keyToJS(own[k]);
        // WebAssembly stays the host's, as on the principal window (40-bridge.js HOST_ONLY_GLOBALS): the engine's own
        // namespace is LibWasm, an interpreter with its own memory limits (Scramjet's rewriter failed in it with
        // "Failed to allocate a memory instance"), and the frame's ECMAScript globals are the host's already.
        if (typeof key === 'symbol' || key === 'Worker' || key === 'SharedWorker' || HOST_ONLY_GLOBALS[key] === true)
            continue;
        defineMember(global, windowCell, own[k], key, global);
    }
    installFrameQueueMicrotask(global);
    // SharedArrayBuffer only in a cross-origin isolated frame (the engine's crossOriginIsolated for its document: the top-level
    // document isolated and the frame allowed "cross-origin-isolated"), as on the principal window (setPageIsolation).
    let frameIsolated = false;
    try { frameIsolated = global.crossOriginIsolated === true; } catch { frameIsolated = false; }
    if (!frameIsolated)
        ReflectDeleteProperty(global, 'SharedArrayBuffer');
    record.isolated = frameIsolated;
    // The host's own interfaces for the frame (a dedicated Worker whose URLs are the frame's: harness/segment/pagesw-host.js).
    if (typeof callbacks.frameRealmCreated === 'function') {
        try { callbacks.frameRealmCreated(global); } catch { /* the frame goes on without them */ }
    }
    syncFrameIndices();
    return record;
}
function installFrameQueueMicrotask(global) {
    if (HostQueueMicrotask === null)
        return;
    const queue = {
        queueMicrotask(callback) {
            if (typeof callback !== 'function')
                throw typeError("Failed to execute 'queueMicrotask' on 'Window': parameter 1 is not of type 'Function'.");
            HostQueueMicrotask(() => {
                try {
                    callback();
                } catch (e) {
                    try { global.reportError(e); } catch { /* nothing more to do with it */ }
                }
            });
        },
    }.queueMicrotask;
    WeakSetPrototypeAdd(nativeFunctions, queue);
    ObjectDefineProperty(global, 'queueMicrotask', { value: queue, writable: true, enumerable: true, configurable: true });
}

// The page object for a WindowProxy that is not the principal window's: a frame realm's when the frame is same-origin
// with the page, otherwise the engine-checked stand-in (frameWindow in 40-bridge.js).
function windowProxyToJS(wpCell) {
    if (!frameRealmsOn)
        return null;
    const windowCell = windowOfProxy(wpCell);
    if (windowCell === 0 || windowCell === globalCell)
        return null;
    // Same origin as the script asking (HTML's WindowProxy checks are relative to the accessing realm): a frame's own code
    // reading its `window` gets its realm's proxy even when the frame is cross-origin to the principal page (hCaptcha's
    // frames: newassets.hcaptcha.com in accounts.hcaptcha.com; `delete window.msgpack` hit the stand-in and threw).
    const asking = currentGlobalCell();
    let origin, own;
    try {
        origin = vGet(windowCell, 'origin');
        own = vGet(asking !== 0 ? asking : globalCell, 'origin');
    } catch {
        return null;
    }
    if (origin !== own)
        return null;
    return frameWindowProxy(wpCell);
}

// The engine asks the host to run a classic script: a frame realm's when its execution context is a frame's.
function frameRealmOfCurrentScript() {
    if (!frameRealmsOn)
        return null;
    const cell = currentGlobalCell();
    if (cell === 0 || cell === globalCell)
        return null;
    return realmForWindow(cell, 0);
}
// A handler's last scope is a frame's global object only when the engine put it there (Bridge.cpp): a Window.
function frameRealmOfGlobalCell(cell) {
    if (!frameRealmsOn || cell === 0 || cell === globalCell)
        return null;
    if (!RealmsMapHas(realmByWindowCell, cell) && vClassName(cell) !== globalClassName())
        return null;
    return realmForWindow(cell, 0);
}
let principalClassName = null;
function globalClassName() {
    if (principalClassName === null)
        principalClassName = vClassName(globalCell);
    return principalClassName;
}

// The principal document was replaced: the frames of the old one are gone.
function resetFrameRealms() {
    for (let i = 0; i < principalFrameCount; i++)
        ReflectDeleteProperty(G, HostString(i));
    principalFrameCount = 0;
    realmByWindowCell.clear();
    realmById.clear();
}

// The ECMAScript built-ins are the Worker's and shared by every frame realm (docs/surface.md): a frame's page that fixes
// a non-configurable property on one (Scramjet's client defines `$scramjet__location` on `Object.prototype` with
// configurable: false) fixes it for the next document of that frame as well, whose own client then fails with "Cannot
// redefine property" (in Chrome the next document has an Object.prototype of its own). While a frame's code runs, a
// property it defines on a shared built-in (a constructor, its prototype, JSON, Math, Reflect...) is kept configurable,
// so a later document of a frame can define it again; what the principal document defines is left as it is.
const SharedBuiltins = new RealmsSet();
const frameFixed = new (globalThis.WeakMap)(); // shared built-in -> the keys frames defined on it
let builtinGuardInstalled = false;
function frameRealmNow() {
    if (realmByWindowCell.size === 0)
        return false;
    const cell = currentGlobalCell();
    return cell !== 0 && cell !== globalCell && RealmsMapHas(realmByWindowCell, cell);
}
function looseForFrame(target, key, desc) {
    if (!RealmsSetHas(SharedBuiltins, target) || desc === null || typeof desc !== 'object' || desc.configurable === true || !frameRealmNow())
        return desc;
    let keys = WeakMapPrototypeGet(frameFixed, target);
    const k = typeof key === 'symbol' ? key : HostString(key);
    if (ObjectHasOwn(target, k) && (keys === undefined || !RealmsSetHas(keys, k)))
        return desc; // the principal's (or the built-in's own): as it is
    if (keys === undefined) {
        keys = new RealmsSet();
        WeakMapPrototypeSet(frameFixed, target, keys);
    }
    RealmsSetAdd(keys, k);
    const loose = ObjectCreate(null);
    for (const n of ['value', 'writable', 'get', 'set', 'enumerable'])
        if (ReflectHas(desc, n))
            loose[n] = desc[n];
    loose.configurable = true;
    return loose;
}
function installBuiltinGuard() {
    if (builtinGuardInstalled)
        return;
    builtinGuardInstalled = true;
    for (let i = 0; i < esGlobalDescriptors.length; i++) {
        const v = esGlobalDescriptors[i][1].value;
        if ((typeof v === 'object' && v !== null) || typeof v === 'function') {
            RealmsSetAdd(SharedBuiltins, v);
            if (typeof v === 'function' && typeof v.prototype === 'object' && v.prototype !== null)
                RealmsSetAdd(SharedBuiltins, v.prototype);
        }
    }
    const define = ObjectDefineProperty;
    const reflectDefine = HostReflect.defineProperty;
    const defineAll = HostObject.defineProperties;
    const wrapped = {
        defineProperty(o, p, attributes) { return define(o, p, looseForFrame(o, p, attributes)); },
        defineProperties(o, properties) {
            if (!RealmsSetHas(SharedBuiltins, o) || properties === null || typeof properties !== 'object')
                return defineAll(o, properties);
            const out = ObjectCreate(null);
            const keys = ReflectOwnKeys(properties);
            for (let i = 0; i < keys.length; i++)
                out[keys[i]] = looseForFrame(o, keys[i], properties[keys[i]]);
            return defineAll(o, out);
        },
    };
    const reflectWrapped = { defineProperty(o, p, attributes) { return reflectDefine(o, p, looseForFrame(o, p, attributes)); } };
    for (const [holder, name, f] of [[HostObject, 'defineProperty', wrapped.defineProperty], [HostObject, 'defineProperties', wrapped.defineProperties], [HostReflect, 'defineProperty', reflectWrapped.defineProperty]]) {
        WeakSetPrototypeAdd(nativeFunctions, f);
        define(holder, name, { value: f, writable: true, enumerable: false, configurable: true });
    }
}

function enableFrameRealms(on) {
    if (!on || typeof X.ganglion_js_frame_realms !== 'function' || typeof X.ganglion_js_current_global !== 'function' || typeof X.ganglion_v_window_proxy_window !== 'function')
        return false;
    X.ganglion_js_frame_realms(1);
    frameRealmsOn = true;
    installBuiltinGuard();
    return true;
}

// --- A frame's module scripts --------------------------------------------------------------------------------------
// The host's V8 loads a module and its imports itself, in the Worker's realm, where a module's free names are the
// Worker's global (the principal window). A frame's module graph is loaded under the realm's own name in the segment's
// mirror (/__chitin/r/<id>/o/https/<host>/<path>, harness/segment/sw.js), so it is a module graph of its own (a chunk
// the parent page also imports is evaluated again, for the frame), and the service worker puts one fixed line in
// front of each of its modules: an import of the realm's accessor module and a `const` destructuring of the frame's
// WindowProxy for the names the module uses that are the frame's or the principal window's and that the module does
// not declare itself (docs/architecture.md "Frame realms"). Nothing else in the module changes. The names are read
// once, when the module is evaluated (a later replacement of a frame global is not seen by a module that read it).
const realmById = new RealmsMap();
let nextRealmId = 1;
let inlineFrameModules = 0;
const MODULE_NEVER_BOUND = new RealmsSet(['arguments', 'await', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public',
    'enum', 'eval', 'undefined', 'NaN', 'Infinity', '__chitin_f']);
function moduleBindings(record, text) {
    const info = scanScript(text, true);
    const declared = new RealmsSet();
    for (let i = 0; i < info.vars.length; i++) RealmsSetAdd(declared, info.vars[i]);
    for (let i = 0; i < info.functions.length; i++) RealmsSetAdd(declared, info.functions[i]);
    for (let i = 0; i < info.lexicals.length; i++) RealmsSetAdd(declared, info.lexicals[i][0]);
    const names = [];
    const ids = info.ids;
    for (let i = 0; i < ids.length; i++) {
        const name = ids[i];
        if (RealmsSetHas(declared, name) || RealmsSetHas(MODULE_NEVER_BOUND, name))
            continue;
        if (RealmsSetHas(ES_GLOBAL_SET, name) && name !== 'globalThis' && ReflectGet(record.global, name) === ReflectGet(G, name))
            continue; // the shared built-in: the module reaches it as it is
        if (ReflectHas(record.global, name) || ReflectHas(G, name))
            RealmsPush(names, name);
    }
    return names;
}
function frameModuleBindings(realmId, text) {
    const record = RealmsMapGet(realmById, realmId);
    if (record === undefined)
        return [];
    return moduleBindings(record, text);
}

// A module script of a frame: the host imports it under the realm's mirror name (callbacks.runFrameModule).
function runFrameModule(record, source, filename, lineOffset) {
    if (typeof callbacks.runFrameModule !== 'function')
        return PromiseReject(new HostTypeError('segment: this host cannot run a frame\'s module scripts: ' + filename));
    const text = '\n'.repeat(lineOffset > 1 ? lineOffset - 1 : 0) + source;
    // An inline module has the document's URL, which cannot be imported twice: a query names it (as for the page's).
    let href = '';
    try { href = HostString(ReflectGet(ReflectGet(record.global, 'location'), 'href')).replace(/#.*$/, ''); } catch { /* none */ }
    if (href !== '' && HostString(filename).replace(/#.*$/, '') === href)
        filename = href + (StringPrototypeIncludes(href, '?') ? '&' : '?') + '__chitin_module=' + (++inlineFrameModules);
    return callbacks.runFrameModule(text, filename, record.id, record.proxy, moduleBindings(record, text));
}
