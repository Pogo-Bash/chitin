// The compositor corpus (docs/compositor.md): deterministic filler text, so every run paints the same pixels.
(function () {
    const words = 'shell segment carapace engine layer tile scroll frame paint raster damage offset sticky fixed blur canvas glyph pixel quad texture budget viewport'.split(' ');
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    window.lorem = (n) => { let s = ''; for (let i = 0; i < n; i++) s += (i ? ' ' : '') + words[Math.floor(rand() * words.length)]; return s.charAt(0).toUpperCase() + s.slice(1) + '.'; };
    window.fill = (el, paragraphs) => { for (let i = 0; i < paragraphs; i++) { const p = document.createElement('p'); p.textContent = (i + 1) + '. ' + lorem(40 + (i % 5) * 9); el.appendChild(p); } };
})();
