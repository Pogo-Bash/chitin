import { x } from './a.js';
import def from './c.js';
order.push('b:' + x + ':' + def);
results.bMeta = import.meta.url;
import('./c.js').then((m) => { order.push('dyn:' + m.default); results.dyn = m.default; });
