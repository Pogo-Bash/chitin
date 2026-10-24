// demo.example's classic script. It builds the page with ordinary DOM calls; it does not know it is
// running in a Worker next to a wasm engine.
(function () {
  var report = self.__chitinReport || function () {};

  // Where does this script think it is? (sourceURL / importScripts: the real URL, not the segment's)
  var frame = (new Error('probe').stack || '').split('\n')[1] || '';
  report('classic script stack frame', frame.trim());

  var body = document.body;
  var title = document.createElement('div');
  title.setAttribute('style', 'padding: 8px; background-color: #3b2f2a; color: #f4efe6');
  title.appendChild(document.createTextNode('demo.example in a Chitin segment: toy engine + page JS on V8'));
  body.appendChild(title);

  var info = document.createElement('div');
  info.setAttribute('style', 'padding: 4px; color: #3b2f2a');
  var infoText = document.createTextNode('click a box; drag the green one; type to append text');
  info.appendChild(infoText);
  body.appendChild(info);

  var stage = document.createElement('div');
  stage.setAttribute('style', 'height: 360px; background-color: #efe8dc; margin: 4px');
  body.appendChild(stage);

  var colors = ['#6b8f71', '#a3b18a', '#b08968', '#7f5539', '#588157', '#ddb892'];
  var clicks = 0;
  for (var i = 0; i < 24; i++) {
    (function (i) {
      var box = document.createElement('div');
      var x = 12 + (i % 8) * 70, y = 12 + Math.floor(i / 8) * 70;
      box.style.setProperty('position', 'absolute');
      box.style.setProperty('left', x + 'px');
      box.style.setProperty('top', y + 'px');
      box.style.setProperty('width', '56px');
      box.style.setProperty('height', '56px');
      box.style.setProperty('background-color', colors[i % colors.length]);
      box.addEventListener('click', function (e) {
        clicks++;
        this.style.setProperty('background-color', this.style.getPropertyValue('background-color') === '#3b2f2a' ? colors[i % colors.length] : '#3b2f2a');
        infoText.data = 'clicks: ' + clicks + ' (last at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ', trusted: ' + e.isTrusted + ')';
      });
      stage.appendChild(box);
    })(i);
  }

  // A draggable box: pointer events in page coordinates, mapped by the carapace.
  var drag = document.createElement('div');
  drag.style.setProperty('position', 'absolute');
  drag.style.setProperty('left', '20px');
  drag.style.setProperty('top', '230px');
  drag.style.setProperty('width', '80px');
  drag.style.setProperty('height', '80px');
  drag.style.setProperty('background-color', '#2d6a4f');
  stage.appendChild(drag);
  var dragging = null;
  drag.addEventListener('pointerdown', function (e) {
    var r = drag.getBoundingClientRect();
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  });
  document.addEventListener('pointerup', function () { dragging = null; });
  document.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var s = stage.getBoundingClientRect();
    drag.style.setProperty('left', (e.clientX - s.left - dragging.dx) + 'px');
    drag.style.setProperty('top', (e.clientY - s.top - dragging.dy) + 'px');
  });

  // An animation: a bar that moves every frame (requestAnimationFrame is the carapace's clock).
  var bar = document.createElement('div');
  bar.style.setProperty('position', 'absolute');
  bar.style.setProperty('top', '330px');
  bar.style.setProperty('width', '40px');
  bar.style.setProperty('height', '12px');
  bar.style.setProperty('background-color', '#bc6c25');
  stage.appendChild(bar);
  var frames = 0;
  function tick(t) {
    frames++;
    bar.style.setProperty('left', (12 + (t / 4) % 520) + 'px');
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  var typed = document.createElement('div');
  typed.setAttribute('style', 'padding: 4px; color: #1b4332');
  var typedText = document.createTextNode('> ');
  typed.appendChild(typedText);
  body.appendChild(typed);
  document.addEventListener('keydown', function (e) {
    if (e.key.length === 1) typedText.appendData(e.key);
    else if (e.key === 'Backspace' && typedText.data.length > 2) typedText.data = typedText.data.slice(0, -1);
  });

  // import() from a classic script: what base URL does V8 resolve it against?
  import('./lib/util.mjs').then(
    function (m) { report('import() from the classic script resolved to', m.selfUrl); },
    function (e) { report('import() from the classic script failed', String(e && e.message || e)); }
  );
})();
