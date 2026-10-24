window.seen = []; Promise.resolve().then(function () { window.seen.push('promise:' + (document.currentScript && document.currentScript.id)); });
