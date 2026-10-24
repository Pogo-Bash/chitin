// Shared by the shell and the new-tab frame: each realm evaluates its own copy.
export const store = { shortcuts: [], realm: document.title };
export function addShortcut(title, url) { store.shortcuts.push({ title, url }); return store.shortcuts.length; }
