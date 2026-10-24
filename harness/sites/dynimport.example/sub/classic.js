// An external classic script in /sub/: '/root.mjs' is the site's root, './rel.mjs' and '../rel.mjs' resolve against this file.
window.ext = [];
Promise.allSettled([import('/root.mjs'), import('./rel.mjs'), import('../rel.mjs')]).then((r) => {
    window.ext = r.map((x) => (x.status === 'fulfilled' ? x.value.name : 'ERR ' + x.reason));
});
