export const seenTitle = document.title;
export const sameWindow = window === self && globalThis === window;
window.sharedModRuns = (window.sharedModRuns || 0) + 1;
export function where() { return location.pathname; }
