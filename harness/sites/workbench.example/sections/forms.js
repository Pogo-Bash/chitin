// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Forms without real input: values and sanitisation, validity, FormData order, submit and reset events, selection.
WB.section('forms', async (t) => {
    const r = t.root;
    r.insertAdjacentHTML('beforeend', `<form id="wbform" action="/api/echo" method="post" novalidate>
<input name="text" value=" a b ">
<input name="num" type="number" value="12abc" min="0" max="10" step="2">
<input name="email" type="email" value="not-an-email" required>
<input name="pat" pattern="[a-z]{3}" value="ab1">
<input name="color" type="color" value="#ABCDEF">
<input name="date" type="date" value="2026-02-30">
<input name="range" type="range" value="150">
<input name="cb" type="checkbox" checked><input name="cb2" type="checkbox" value="v">
<input name="rad" type="radio" value="1"><input name="rad" type="radio" value="2" checked>
<input type="file" name="file">
<select name="sel" multiple><option value="o1" selected>1</option><option selected>two</option><option disabled selected>3</option></select>
<textarea name="ta">line1
line2</textarea>
<input name="dis" disabled value="x">
<button name="btn" value="b">go</button>
<output name="out">5</output>
<fieldset disabled><input name="infs" value="y"></fieldset>
</form>`);
    const f = r.querySelector('#wbform'), el = f.elements;
    await t.check('values', () => [el.text.value, el.num.value, el.num.valueAsNumber, el.color.value, el.date.value, el.range.value, el.ta.value, el.out.value, el.rad.value, [...el.sel.selectedOptions].map((o) => o.value), el.file.files.length, el.cb2.value]);
    await t.check('validity', () => ['num', 'email', 'pat', 'text'].map((n) => { const v = el[n].validity; return n + ':' + ['valid', 'valueMissing', 'typeMismatch', 'patternMismatch', 'rangeOverflow', 'stepMismatch', 'badInput'].filter((k) => v[k]).join('|'); }));
    await t.check('validationMessageNonEmpty', () => [el.email.validationMessage.length > 0, el.text.validationMessage]);
    await t.check('checkValidity', () => { const L = []; f.addEventListener('invalid', (e) => L.push('invalid:' + e.target.name), true); const ok = f.checkValidity(); el.text.setCustomValidity('custom'); const ok2 = el.text.checkValidity(); el.text.setCustomValidity(''); return [ok, ok2, L, el.dis.willValidate, el.infs.willValidate, el.out.willValidate]; });
    await t.check('formData', () => [...new FormData(f)].map(([k, v]) => k + '=' + (typeof v === 'string' ? v : 'File:' + v.name + ':' + v.size)));
    await t.check('formDataSubmitter', () => [...new FormData(f, el.btn)].filter(([k]) => k === 'btn').length);
    await t.check('setters', () => { el.num.value = '7.5'; const a = el.num.value; el.num.valueAsNumber = 4; el.num.stepUp(2); const b = el.num.value; el.date.valueAsDate = new Date(Date.UTC(2026, 0, 2)); el.color.value = 'red'; el.range.value = '-5'; return [a, b, el.date.value, el.color.value, el.range.value]; });
    await t.check('submitEvents', async () => {
        const L = [];
        f.addEventListener('formdata', (e) => { L.push('formdata:' + [...e.formData.keys()].length); e.formData.append('extra', '1'); });
        f.addEventListener('submit', (e) => { L.push('submit:' + (e.submitter && e.submitter.name)); e.preventDefault(); });
        f.addEventListener('reset', () => L.push('reset'));
        f.requestSubmit(el.btn);
        f.reset();
        await t.sleep(0);
        return [L, el.text.value, el.cb.checked, el.num.value];
    });
    await t.check('selection', () => { const i = el.text; i.value = 'hello world'; i.setSelectionRange(2, 7, 'backward'); const a = [i.selectionStart, i.selectionEnd, i.selectionDirection]; i.setRangeText('XX', 0, 1, 'select'); return [a, i.value, i.selectionStart, i.selectionEnd, el.num.selectionStart]; });
    await t.check('labelsAndAttrs', () => { r.insertAdjacentHTML('beforeend', '<label for="wbl">L</label><label><input id="wbl" maxlength="3" placeholder="p" autocomplete="off" inputmode="numeric" readonly></label>'); const i = r.querySelector('#wbl'); return [i.labels.length, i.maxLength, i.placeholder, i.readOnly, i.inputMode, i.type, document.createElement('input').type, (() => { const x = document.createElement('input'); x.type = 'bogus'; return x.type; })()]; });
    await t.check('dialog', async () => { const d = document.createElement('dialog'); d.innerHTML = '<form method="dialog"><button value="ok">ok</button></form>'; r.append(d); const L = []; d.addEventListener('close', () => L.push('close:' + d.returnValue)); d.showModal(); const open = [d.open, d.matches(':modal')]; d.querySelector('button').click(); await t.sleep(20); return [open, L, d.open]; });
    await t.check('popover', () => { const p = document.createElement('div'); if (!('popover' in p)) return 'none'; p.popover = 'auto'; r.append(p); const L = []; p.addEventListener('beforetoggle', (e) => L.push('before:' + e.oldState + '->' + e.newState)); p.addEventListener('toggle', (e) => L.push('toggle:' + e.newState)); p.showPopover(); const open = p.matches(':popover-open'); p.hidePopover(); return new Promise((res) => setTimeout(() => res([open, L]), 20)); });
    await t.check('contentEditable', () => { const d = document.createElement('div'); d.contentEditable = 'true'; d.textContent = 'abc'; r.append(d); return [d.isContentEditable, d.contentEditable, typeof document.execCommand, document.queryCommandSupported ? document.queryCommandSupported('bold') : 'n/a']; });
});
