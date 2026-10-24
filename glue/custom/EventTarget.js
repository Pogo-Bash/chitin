// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// EventTarget's [ImplementedInBindings] members: listener callbacks are engine -> JS edges, so
// they are stored on the component's anchor, never in the engine.
// https://dom.spec.whatwg.org/#dom-eventtarget-addeventlistener

function flattenListenerOptions(options, withOnceAndPassive) {
    // (AddEventListenerOptions or boolean): an object (or null/undefined) is the dictionary,
    // anything else is ToBoolean. Members are read in WebIDL order: inherited first, then sorted.
    let capture = false, once = false, passive = false;
    if (options === undefined || options === null || typeof options === 'object' || typeof options === 'function') {
        if (options !== undefined && options !== null) {
            capture = !!options.capture;
            if (withOnceAndPassive) {
                once = !!options.once;
                passive = !!options.passive;
            }
        }
    } else {
        capture = !!options;
    }
    return (capture ? 1 : 0) | (once ? 2 : 0) | (passive ? 4 : 0);
}

function checkCallback(callback, label) {
    if (callback === undefined || callback === null)
        return false;
    if (typeof callback !== 'object' && typeof callback !== 'function')
        throw typeError(label + ": parameter 2 is not of type 'EventListener'.");
    return true;
}

installCustom(EventTarget, {
    addEventListener(type, callback, options) {
        const h = EventTarget_h(this);
        const label = "Failed to execute 'addEventListener' on 'EventTarget'";
        if (arguments.length < 2)
            throw argCountError(label, 2, arguments.length);
        const t = toDOMString(type);
        const hasCallback = checkCallback(callback, label);
        const flags = flattenListenerOptions(options, true);
        if (!hasCallback)
            return undefined;
        const id = callbackIdOf(callback, true);
        const base = inTop;
        const p = putString(t);
        const edge = X.ganglion_EventTarget_addEventListener(h, p, t.length, id, flags & 1, (flags >> 1) & 1, (flags >> 2) & 1) >>> 0;
        endCall(base);
        if (edge !== 0)
            topAnchor(EventTarget_anchor(this)).edges[edge] = callback;
        return undefined;
    },
    removeEventListener(type, callback, options) {
        const h = EventTarget_h(this);
        const label = "Failed to execute 'removeEventListener' on 'EventTarget'";
        if (arguments.length < 2)
            throw argCountError(label, 2, arguments.length);
        const t = toDOMString(type);
        const hasCallback = checkCallback(callback, label);
        const flags = flattenListenerOptions(options, false);
        if (!hasCallback)
            return undefined;
        const id = callbackIdOf(callback, false);
        if (id === undefined)
            return undefined;
        const base = inTop;
        const p = putString(t);
        const edge = X.ganglion_EventTarget_removeEventListener(h, p, t.length, id, flags & 1) >>> 0;
        endCall(base);
        if (edge !== 0)
            delete topAnchor(EventTarget_anchor(this)).edges[edge];
        return undefined;
    },
}, { __proto__: null, addEventListener: 2, removeEventListener: 2 });
