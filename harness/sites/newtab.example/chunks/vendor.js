import { store, addShortcut } from './store.js';
const slot = self._newtab_slot && self._newtab_slot.value;
class ShortcutsManager {
    constructor(section) { this.section = section; }
    render() {
        for (const s of store.shortcuts) {
            const tile = document.createElement('button');
            tile.className = 'tile';
            tile.textContent = s.title;
            tile.addEventListener('click', () => { window.clickedShortcut = s.url; parent.postMessage({ type: 'open', url: s.url }, location.origin); });
            this.section.appendChild(tile);
        }
        return this.section.children.length;
    }
}
addShortcut('Wiki', 'https://wiki.example/');
addShortcut('News', 'https://news.example/');
window.shortcutsManager = new ShortcutsManager(document.getElementById('shortcuts-section'));
window.tiles = window.shortcutsManager.render();
window.vendorSaw = [store.realm, typeof slot, slot && slot.base].join(' ');
