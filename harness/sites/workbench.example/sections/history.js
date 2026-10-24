// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// History and navigation within the document: pushState/replaceState, traversals and the popstate/hashchange order, the
// Navigation API. The document's URL is put back at the end.
WB.section('history', async (t) => {
    const start = location.href, len0 = history.length;
    const L = [];
    const pop = (e) => L.push('popstate:' + JSON.stringify(e.state) + ':' + location.hash);
    const hash = (e) => L.push('hashchange:' + new URL(e.oldURL).hash + '->' + new URL(e.newURL).hash);
    addEventListener('popstate', pop); addEventListener('hashchange', hash);
    const nav = self.navigation;
    const navLog = (e) => L.push('navigate:' + e.navigationType + ':' + new URL(e.destination.url).hash + ':' + e.hashChange + ':' + e.canIntercept);
    if (nav) nav.addEventListener('navigate', navLog);
    const waitFor = (pred, what) => t.withTimeout((async () => { while (!pred()) await t.sleep(5); })(), 3000, what);
    history.pushState({ n: 1 }, '', '#wb-h1');
    L.push('pushed:' + history.state.n + ':' + location.hash + ':' + (history.length - len0));
    history.replaceState({ n: 2 }, '');
    L.push('replaced:' + history.state.n);
    location.hash = 'wb-h2';
    L.push('hash-set-sync:' + location.hash);
    await waitFor(() => L.some((x) => x.startsWith('hashchange')), 'hashchange');
    history.back();
    await waitFor(() => L.filter((x) => x.startsWith('popstate')).length >= 2 || L.some((x) => x.startsWith('popstate:{"n":2}')), 'popstate');
    await t.sleep(50);
    history.forward();
    await t.sleep(200);
    t.set('scrollRestoration', history.scrollRestoration);
    let badState = null; try { history.pushState({ f: () => 1 }, ''); } catch (e) { badState = e.name; }
    t.set('badState', badState);
    let crossOrigin = null; try { history.pushState(null, '', 'https://elsewhere.example/'); } catch (e) { crossOrigin = e.name; }
    t.set('crossOriginPush', crossOrigin);
    if (nav) {
        await t.check('navigationApi', async () => {
            const entries = nav.entries().length;
            const r = nav.navigate('#wb-nav', { state: { v: 3 }, history: 'push' });
            await r.committed;
            await r.finished.catch(() => {});
            return [nav.currentEntry.getState(), new URL(nav.currentEntry.url).hash, nav.entries().length - entries, nav.canGoBack, typeof nav.transition];
        });
        nav.removeEventListener('navigate', navLog);
    } else t.set('navigationApi', 'none');
    removeEventListener('popstate', pop); removeEventListener('hashchange', hash);
    t.set('order', L);
    t.set('lengthDelta', history.length - len0);
    history.replaceState(null, '', start);
    t.set('restored', location.href === start);
    await t.check('location', () => [location.protocol, location.hostname, location.pathname, typeof location.reload, location.origin === self.origin, document.URL === location.href, document.referrer, document.domain]);
});
