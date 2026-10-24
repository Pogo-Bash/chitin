const got = [];
const finish = () => { if (got.length === 3 && !got.includes(undefined)) postMessage(got.join('|')); };
const a = new Worker('inner.js', { name: 'in' });
a.onmessage = (e) => { got[0] = e.data; finish(); };
a.postMessage(5);
const b = new Worker(URL.createObjectURL(new Blob(['postMessage(location.protocol)'], { type: 'text/javascript' })));
b.onmessage = (e) => { got[1] = e.data; finish(); };
const c = new Worker('throws.js');
c.onerror = (e) => { got[2] = [e.type, e.message, e.lineno, Object.prototype.toString.call(e)].join(':'); e.preventDefault(); finish(); };
