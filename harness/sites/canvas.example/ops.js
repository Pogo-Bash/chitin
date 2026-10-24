// The 2D operations tests/engine-js.test.mjs and the chrome-test group run in Chitin and in Chrome; what each reads
// back (pixels, an ink bounding box) is compared. `doc` is the page's document.
function canvasProbe(doc) {
    var r = {};
    var c = doc.createElement('canvas');
    c.width = 200; c.height = 120;
    c.id = 'c'; c.style.display = 'block';
    if (doc.body) doc.body.appendChild(c);
    var g = c.getContext('2d');
    r.ctx = !!g;
    g.fillStyle = '#ff0000'; g.fillRect(10, 10, 40, 30);                                   // fillRect
    g.fillStyle = '#0000ff'; g.beginPath(); g.arc(100, 30, 20, 0, Math.PI * 2); g.fill();   // arc
    g.strokeStyle = '#00aa00'; g.lineWidth = 6; g.beginPath();                              // lineTo + stroke
    g.moveTo(10, 70); g.lineTo(80, 70); g.lineTo(80, 100); g.stroke();
    var src = doc.createElement('canvas'); src.width = 20; src.height = 20;                 // drawImage
    var sg = src.getContext('2d'); sg.fillStyle = '#ff00ff'; sg.fillRect(0, 0, 20, 20);
    g.drawImage(src, 120, 70);
    g.fillStyle = '#000'; g.font = '24px sans-serif'; g.fillText('Hi', 150, 30);            // fillText
    function px(x, y) { return Array.from(g.getImageData(x, y, 1, 1).data); }
    r.rect = px(20, 20); r.rectOutside = px(55, 20);
    r.arc = px(100, 30); r.arcOutside = px(100, 5);
    r.stroke = px(45, 70); r.strokeUp = px(45, 60); r.strokeVertical = px(80, 90);
    r.image = px(130, 80); r.empty = px(190, 110);
    var t = g.getImageData(140, 0, 60, 50).data, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (var i = 0; i < t.length; i += 4) {
        if (t[i + 3] > 128) { var p = i / 4, x = p % 60, y = (p - x) / 60; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    r.textBox = [x0 + 140, y0, x1 + 140, y1];
    r.dataURL = c.toDataURL().slice(0, 22);
    r.put = (function () { g.putImageData(new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1), 190, 110); return px(190, 110); })();
    return { results: r, ctx: g, canvas: c };
}
