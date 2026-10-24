importScripts('lib.js');
onmessage = async (e) => {
    const t = await (await fetch('data.txt')).text();
    postMessage([double(e.data.n), e.data.buf.byteLength, t, self.name, location.href]);
};
