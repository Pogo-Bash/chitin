import { store } from './store.js';
window.shellStore = store;
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') { window.opened = e.data.url; document.getElementById('tabs').textContent = 'tab: ' + e.data.url; } });
