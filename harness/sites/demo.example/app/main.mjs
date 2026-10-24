// demo.example's module entry. Every URL below should be the site's real one.
import { selfUrl as utilUrl, describe } from './lib/util.mjs';
import { selfUrl as cdnUrl } from 'https://cdn.example/lib.mjs';

const report = self.__chitinReport || (() => {});
report('main.mjs import.meta.url', import.meta.url);
report('relative import ./lib/util.mjs', utilUrl);
report('cross-origin import https://cdn.example/lib.mjs', cdnUrl);
report('import.meta.resolve("./x.mjs")', import.meta.resolve('./x.mjs'));
report('module stack frame', (new Error('probe').stack || '').split('\n')[1]?.trim());
const dynamic = await import('./lib/util.mjs?dynamic');
report('dynamic import with a query', dynamic.selfUrl);
describe(document.body);
