export const selfUrl = import.meta.url;
export function describe(body) {
  const note = body.ownerDocument.createElement('div');
  note.setAttribute('style', 'padding: 4px; color: #6c584c');
  note.appendChild(body.ownerDocument.createTextNode('modules loaded from ' + new URL('.', import.meta.url).href));
  body.appendChild(note);
}
