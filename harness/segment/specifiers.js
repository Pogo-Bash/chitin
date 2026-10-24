// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Import maps for page modules (docs/architecture.md "Import maps"): the module specifiers a module's text names, found by
// a real JavaScript parser (Acorn, third_party/acorn), and the one change the segment's service worker may make with them:
// a specifier string the document's import map remaps is replaced by the URL the map gives. Nothing else in the text is
// touched; a replacement never spans a line break, so every line keeps its number (stack traces, source maps' lines).
//
// Shared by harness/segment/sw.js (importScripts) and the Node tests (tests/engine-run.mjs): no imports, no globals
// besides the one it defines.
'use strict';
(function (root) {
    // The specifiers of `text`: [{ start, end, value, kind }], start/end the string literal's offsets (quotes included).
    // kind: 'static' (import ... from / import '...' / export ... from), 'dynamic' (import('...')), 'resolve'
    // (import.meta.resolve('...')). Only literal specifiers: import(expression) is left to the host (docs/architecture.md).
    // A text Acorn cannot parse is left alone (V8 reports its own SyntaxError): null.
    function find(acorn, text, isModule) {
        const tokens = [];
        let program;
        try {
            program = acorn.parse(text, {
                ecmaVersion: 'latest',
                sourceType: isModule ? 'module' : 'script',
                allowHashBang: true,
                allowAwaitOutsideFunction: true,
                allowReturnOutsideFunction: !isModule,
                onToken: tokens,
            });
        } catch {
            return null;
        }
        const out = [];
        const literal = (node) => node && node.type === 'Literal' && typeof node.value === 'string';
        if (isModule) {
            for (const node of program.body) {
                if ((node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') && literal(node.source))
                    out.push({ start: node.source.start, end: node.source.end, value: node.source.value, kind: 'static', names: importedNames(node) });
            }
        }
        // import( <string> ) and import.meta.resolve( <string> ), from the parser's own tokens (so a regular expression
        // or a template's text is never mistaken for code).
        const label = (i) => (i < tokens.length ? tokens[i].type.label : '');
        // A string argument at i: a string token, or a template with no substitutions (` text `). Returns [start, end, value, next].
        const stringAt = (i) => {
            if (label(i) === 'string')
                return [tokens[i].start, tokens[i].end, tokens[i].value, i + 1];
            if (label(i) === '`' && label(i + 1) === 'template' && label(i + 2) === '`' && typeof tokens[i + 1].value === 'string')
                return [tokens[i].start, tokens[i + 2].end, tokens[i + 1].value, i + 3];
            if (label(i) === '`' && label(i + 1) === '`')
                return [tokens[i].start, tokens[i + 1].end, '', i + 2];
            return null;
        };
        const closes = (i) => label(i) === ')' || label(i) === ',';
        for (let i = 0; i < tokens.length; i++) {
            if (label(i) !== 'import')
                continue;
            if (label(i + 1) === '(') {
                const s = stringAt(i + 2);
                if (s && closes(s[3]))
                    out.push({ start: s[0], end: s[1], value: s[2], kind: 'dynamic' });
            } else if (label(i + 1) === '.' && tokens[i + 2] && tokens[i + 2].value === 'meta' && label(i + 3) === '.' && tokens[i + 4] && label(i + 4) === 'name' && tokens[i + 4].value === 'resolve' && label(i + 5) === '(') {
                const s = stringAt(i + 6);
                if (s && closes(s[3]))
                    out.push({ start: s[0], end: s[1], value: s[2], kind: 'resolve' });
            }
        }
        out.sort((a, b) => a.start - b.start);
        return out;
    }

    // `text` with each edit's [start, end) replaced by the string literal of edit.url. A literal that spans lines (a line
    // continuation) keeps its line breaks after the new literal, as a comment-free run of newlines would change nothing
    // but the line count: they are appended so the lines after it keep their numbers.
    function apply(text, edits) {
        if (!edits.length)
            return text;
        let out = '';
        let at = 0;
        for (const e of edits) {
            out += text.slice(at, e.start);
            const old = text.slice(e.start, e.end);
            const breaks = (old.match(/\r\n|[\n\r\u2028\u2029]/g) || []).length;
            out += JSON.stringify(e.url) + (breaks ? '/*' + '\n'.repeat(breaks) + '*/' : '');
            at = e.end;
        }
        return out + text.slice(at);
    }

    // The names a static import or re-export takes from its module (a blocked specifier's stand-in must export them, or
    // linking fails before its TypeError is thrown).
    function importedNames(node) {
        const names = [];
        const nameOf = (n) => (n.type === 'Identifier' ? n.name : String(n.value));
        for (const spec of node.specifiers || []) {
            if (spec.type === 'ImportDefaultSpecifier')
                names.push('default');
            else if (spec.type === 'ImportSpecifier')
                names.push(nameOf(spec.imported));
            else if (spec.type === 'ExportSpecifier')
                names.push(nameOf(spec.local));
        }
        return names;
    }

    // The edits for `found` given the engine's results (glue/engine/57-importmap.js importMapResolve, one per specifier):
    // a remapped specifier becomes the map's URL (inside a frame realm's graph, the realm's mirror name of it;
    // import.meta.resolve keeps the real URL); one the map blocks becomes `origin`/__chitin/unresolvable.mjs, a module that
    // throws Chrome's TypeError; one the map does not know stays (V8's error for it is Chrome's).
    // classic: the text is a classic script, run from a name in the segment's mirror of the site (worker.js runScript), so its
    // relative import()s are mirror names: a remapped URL is given as its mirror name too, one module per URL as in Chrome.
    function plan(found, results, origin, realm, base, classic) {
        const edits = [];
        for (let i = 0; i < found.length; i++) {
            const f = found[i], r = results[i];
            if (!r)
                continue;
            if (r.url && r.mapped) {
                const https = f.kind !== 'resolve' && r.url.startsWith('https://');
                const rest = r.url.slice('https://'.length);
                const url = https && realm ? `${origin}/__chitin/r/${realm}/o/https/${rest}` : https && classic ? `${origin}/__chitin/o/https/${rest}` : r.url;
                edits.push({ start: f.start, end: f.end, url });
            } else if (r.error === 'bare' && f.kind === 'dynamic' && base) {
                // import() of a specifier no map knows yet: resolved when the import happens (a map added later may know it),
                // as Chrome resolves import() at the call (LATE: the service worker redirects to the URL, or throws).
                edits.push({ start: f.start, end: f.end, url: `${origin}${LATE}?s=${encodeURIComponent(f.value)}&b=${encodeURIComponent(base)}&r=${realm || 0}` });
            } else if (r.error && r.error !== 'bare' && f.kind !== 'resolve') {
                const message = f.kind === 'static' ? r.staticMessage : r.dynamicMessage;
                const names = f.names && f.names.length ? '&n=' + encodeURIComponent(JSON.stringify(f.names)) : '';
                edits.push({ start: f.start, end: f.end, url: `${origin}${UNRESOLVABLE}?m=${encodeURIComponent(message)}${names}` });
            }
        }
        return edits;
    }
    const UNRESOLVABLE = '/__chitin/unresolvable.mjs';
    const LATE = '/__chitin/late.mjs';
    // The module served at UNRESOLVABLE?m=<message>.
    // The module served at UNRESOLVABLE?m=<message>&n=<names>: it exports the names its importer takes and throws.
    const thrower = (message, namesJSON) => {
        let names = [];
        try { names = namesJSON ? JSON.parse(namesJSON) : []; } catch { names = []; }
        const exports = Array.isArray(names) && names.length ? 'let ' + names.map((_, i) => '_' + i).join(',') + ';export{' + names.map((n, i) => '_' + i + ' as ' + JSON.stringify(String(n))).join(',') + '};' : '';
        return `${exports}throw new TypeError(${JSON.stringify(message)});\n`;
    };

    root.ChitinSpecifiers = { find, apply, plan, thrower, UNRESOLVABLE, LATE };
})(typeof self !== 'undefined' ? self : globalThis);
