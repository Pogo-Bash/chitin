// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// DOMRect: a plain value object, implemented entirely in the glue (no engine object, no handle).
// https://drafts.fxtf.org/geometry/#domrect (the toy keeps it read-only and skips DOMRectReadOnly)

let makeDOMRect;
class DOMRect {
    #x; #y; #w; #h;
    constructor(x = 0, y = 0, width = 0, height = 0) {
        this.#x = +x;
        this.#y = +y;
        this.#w = +width;
        this.#h = +height;
    }
    static {
        makeDOMRect = (x, y, w, h) => new DOMRect(x, y, w, h);
    }
    get x() { if (!(#x in this)) throw illegalInvocation(); return this.#x; }
    get y() { if (!(#x in this)) throw illegalInvocation(); return this.#y; }
    get width() { if (!(#x in this)) throw illegalInvocation(); return this.#w; }
    get height() { if (!(#x in this)) throw illegalInvocation(); return this.#h; }
    get top() { if (!(#x in this)) throw illegalInvocation(); return MathMin(this.#y, this.#y + this.#h); }
    get right() { if (!(#x in this)) throw illegalInvocation(); return MathMax(this.#x, this.#x + this.#w); }
    get bottom() { if (!(#x in this)) throw illegalInvocation(); return MathMax(this.#y, this.#y + this.#h); }
    get left() { if (!(#x in this)) throw illegalInvocation(); return MathMin(this.#x, this.#x + this.#w); }
    toJSON() {
        if (!(#x in this)) throw illegalInvocation();
        return { x: this.#x, y: this.#y, width: this.#w, height: this.#h, top: this.top, right: this.right, bottom: this.bottom, left: this.left };
    }
}
finishInterface(DOMRect, { __proto__: null, name: 'DOMRect', members: ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left', 'toJSON'], constants: { __proto__: null }, unscopables: [], length: 0 });
