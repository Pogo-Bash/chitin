// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// OPFS (the origin private file system) for a segment's page and for its page's virtual service worker. Loaded with
// importScripts before the host's doors are removed (harness/segment/doors.js), in the segment Worker and in the runner
// of a page's service worker; both are Workers on the segment's origin, so the host's own OPFS of that origin is already
// one store per site, persisted, and shared between the two. This file is the only code that holds the host's
// StorageManager and FileSystem* objects: it captures what it needs now (the doors delete them afterwards) and hands the
// page its own interfaces, with Chrome's names, members, attributes and errors, over private native handles. A page never
// holds a host handle, and nothing here reaches the network.
//
// It defines `__chitinOPFS`, which the caller takes and deletes from the global.
'use strict';
(() => {
    const G = self;
    const ReflectApply = Reflect.apply;
    const defineProperty = Object.defineProperty;
    const HostPromise = G.Promise;
    const HostDOMException = G.DOMException;
    const HostTypeError = G.TypeError;
    const HostFile = G.File;
    const HostUint8Array = G.Uint8Array;
    const HostArrayBuffer = G.ArrayBuffer;
    const HostTextEncoder = G.TextEncoder;
    const arrayBufferIsView = G.ArrayBuffer.isView;
    const objectToString = Object.prototype.toString;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

    // --- The host's objects, captured before the doors go -------------------------------------------------------------
    // Methods are taken off the interface prototypes and called with Reflect.apply: the prototypes are emptied afterwards.
    const method = (Ctor, name) => {
        const f = Ctor && Ctor.prototype && Ctor.prototype[name];
        return typeof f === 'function' ? f : undefined;
    };
    const getter = (Ctor, name) => {
        const d = Ctor && Ctor.prototype && getOwnPropertyDescriptor(Ctor.prototype, name);
        return d && d.get;
    };
    const SM = G.StorageManager;
    const FH = G.FileSystemHandle;
    const FFH = G.FileSystemFileHandle;
    const FDH = G.FileSystemDirectoryHandle;
    const FSAH = G.FileSystemSyncAccessHandle;
    const WS = G.WritableStream;
    const hostStorage = (() => { try { return G.navigator && G.navigator.storage; } catch { return undefined; } })();
    const N = {
        storage: hostStorage,
        getDirectory: method(SM, 'getDirectory'), estimate: method(SM, 'estimate'), persist: method(SM, 'persist'), persisted: method(SM, 'persisted'),
        kind: getter(FH, 'kind'), name: getter(FH, 'name'),
        isSameEntry: method(FH, 'isSameEntry'), queryPermission: method(FH, 'queryPermission'), requestPermission: method(FH, 'requestPermission'),
        remove: method(FH, 'remove'), move: method(FH, 'move'), getUniqueId: method(FH, 'getUniqueId'),
        getFile: method(FFH, 'getFile'), createWritable: method(FFH, 'createWritable'), createSyncAccessHandle: method(FFH, 'createSyncAccessHandle'),
        getFileHandle: method(FDH, 'getFileHandle'), getDirectoryHandle: method(FDH, 'getDirectoryHandle'), removeEntry: method(FDH, 'removeEntry'),
        resolve: method(FDH, 'resolve'), entries: method(FDH, 'entries'),
        syncRead: method(FSAH, 'read'), syncWrite: method(FSAH, 'write'), syncTruncate: method(FSAH, 'truncate'), syncGetSize: method(FSAH, 'getSize'),
        syncFlush: method(FSAH, 'flush'), syncClose: method(FSAH, 'close'),
        getWriter: method(WS, 'getWriter'),
        blobSlice: method(G.Blob, 'slice'), blobArrayBuffer: method(G.Blob, 'arrayBuffer'), blobSize: getter(G.Blob, 'size'),
    };
    // Every own method of the host's handle interfaces, by interface: the ones this file does not write out by hand
    // (Chrome's `move`, whichever interface it sits on this version) are forwarded generically.
    const NATIVE_METHODS = {};
    for (const [tag, Ctor] of Object.entries({ FileSystemHandle: FH, FileSystemFileHandle: FFH, FileSystemDirectoryHandle: FDH }))
        NATIVE_METHODS[tag] = Ctor && Ctor.prototype ? Object.getOwnPropertyNames(Ctor.prototype).filter((k) => k !== 'constructor' && typeof (getOwnPropertyDescriptor(Ctor.prototype, k) || {}).value === 'function').map((k) => [k, Ctor.prototype[k]]) : [];
    // Function lengths are the host's (WebIDL: only required arguments count), whatever the wrappers' formal parameters are.
    const LENGTHS = {};
    for (const [tag, Ctor] of Object.entries({ FileSystemHandle: FH, FileSystemFileHandle: FFH, FileSystemDirectoryHandle: FDH, FileSystemSyncAccessHandle: FSAH, StorageManager: SM, FileSystemWritableFileStream: G.FileSystemWritableFileStream }))
        if (Ctor && Ctor.prototype)
            for (const key of Object.getOwnPropertyNames(Ctor.prototype)) {
                const d = getOwnPropertyDescriptor(Ctor.prototype, key);
                if (d && typeof d.value === 'function')
                    LENGTHS[tag + '.' + key] = d.value.length;
            }
    const available = typeof N.getDirectory === 'function' && !!N.storage;
    const hostArrayBufferOf = (b) => (b instanceof HostArrayBuffer ? b : new HostUint8Array(b).buffer);

    // The part of the host's interface a page may see: only what Chrome's interface has. `sync` is for contexts where the
    // interface is exposed (a dedicated Worker); a window and a service worker do not have createSyncAccessHandle.
    function create(options = {}) {
        const sync = options.sync === true;
        // The page's realm is read at install time: the engine's Window brings its own DOMException, WritableStream, Blob
        // and File; the runner's are the host's.
        function install(P, navigatorTarget) {
            const PDOMException = P.DOMException || HostDOMException;
            const PTypeError = P.TypeError || HostTypeError;
            const PPromise = P.Promise || HostPromise;
            const PWritableStream = P.WritableStream || WS;
            const PBlob = P.Blob || G.Blob;
            const PFile = P.File || HostFile;
            const PObject = P.Object || Object;

            // A native error as the page's own: Chrome's name and message, the page's DOMException or TypeError class.
            const fix = (e) => {
                if (e instanceof HostDOMException && PDOMException !== HostDOMException)
                    return new PDOMException(e.message, e.name);
                if (e instanceof HostTypeError && PTypeError !== HostTypeError)
                    return new PTypeError(e.message);
                return e;
            };
            const illegal = () => new PTypeError('Illegal invocation');
            const illegalConstructor = () => new PTypeError('Illegal constructor');
            const missing = (iface, name, got, need = 1) => new PTypeError(`Failed to execute '${name}' on '${iface}': ${need} argument${need > 1 ? 's' : ''} required, but only ${got} present.`);
            const guard = async (fn) => {
                try {
                    return await fn();
                } catch (e) {
                    throw fix(e);
                }
            };
            const guardSync = (fn) => {
                try {
                    return fn();
                } catch (e) {
                    throw fix(e);
                }
            };
            const rejected = (e) => PPromise.reject(e);
            const slot = (map) => (o) => {
                const n = o !== null && typeof o === 'object' ? map.get(o) : undefined;
                if (n === undefined)
                    throw illegal();
                return n;
            };
            const argv = (a) => Array.prototype.slice.call(a);

            // --- Handles: the page's wrapper holds the host's handle in a slot nothing else can read -------------------
            const nativeOf = new WeakMap();
            const unwrap = slot(nativeOf);
            let FSFileHandle;
            let FSDirectoryHandle;
            const wrapHandle = (n) => {
                const w = Object.create((ReflectApply(N.kind, n, []) === 'directory' ? FSDirectoryHandle : FSFileHandle).prototype);
                nativeOf.set(w, n);
                return w;
            };
            const handleArg = (o) => (o !== null && typeof o === 'object' ? nativeOf.get(o) : undefined);

            class FileSystemHandle {
                constructor() { throw illegalConstructor(); }
                get kind() { return ReflectApply(N.kind, unwrap(this), []); }
                get name() { return ReflectApply(N.name, unwrap(this), []); }
                isSameEntry(other) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    if (arguments.length < 1)
                        return rejected(missing('FileSystemHandle', 'isSameEntry', 0));
                    const o = handleArg(other);
                    if (!o)
                        return rejected(new PTypeError("Failed to execute 'isSameEntry' on 'FileSystemHandle': parameter 1 is not of type 'FileSystemHandle'."));
                    return guard(() => ReflectApply(N.isSameEntry, n, [o]));
                }
                getUniqueId() {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    return guard(() => ReflectApply(N.getUniqueId, n, []));
                }
                queryPermission(descriptor) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    return guard(() => ReflectApply(N.queryPermission, n, argv(arguments)));
                }
                requestPermission(descriptor) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    return guard(() => ReflectApply(N.requestPermission, n, argv(arguments)));
                }
                remove(options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    return guard(() => ReflectApply(N.remove, n, argv(arguments)));
                }
            }

            // --- Data going into a writable -------------------------------------------------------------------------
            const isArrayBuffer = (v) => { const t = objectToString.call(v); return t === '[object ArrayBuffer]' || t === '[object SharedArrayBuffer]'; };
            const isBlob = (v) => !!PBlob && v instanceof PBlob;
            const bytesOf = (v) => (arrayBufferIsView(v)
                ? new HostUint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
                : new HostUint8Array(v.slice(0)));
            async function dataOf(data) {
                if (typeof data === 'string')
                    return data;
                if (data !== null && typeof data === 'object') {
                    if (arrayBufferIsView(data) || isArrayBuffer(data))
                        return bytesOf(data);
                    if (isBlob(data))
                        return new HostUint8Array(await data.arrayBuffer());
                }
                return data; // null, numbers, others: the native stream refuses them with Chrome's own error
            }
            const isData = (v) => typeof v === 'string' || (v !== null && typeof v === 'object' && (arrayBufferIsView(v) || isArrayBuffer(v) || isBlob(v)));
            async function commandOf(chunk) {
                if (chunk !== null && typeof chunk === 'object' && !isData(chunk)) {
                    const out = { type: chunk.type };
                    if ('data' in chunk)
                        out.data = await dataOf(chunk.data);
                    if ('position' in chunk)
                        out.position = chunk.position;
                    if ('size' in chunk)
                        out.size = chunk.size;
                    return out;
                }
                return dataOf(chunk);
            }

            // --- FileSystemWritableFileStream ------------------------------------------------------------------------
            const MAKE = Symbol('make');
            const writers = new WeakSet();
            class FileSystemWritableFileStream extends PWritableStream {
                constructor(token, writer) {
                    if (token !== MAKE)
                        throw illegalConstructor();
                    super({
                        write: (chunk) => guard(async () => writer.write(await commandOf(chunk))),
                        close: () => guard(() => writer.close()),
                        abort: (reason) => guard(() => writer.abort(reason)),
                    });
                    writers.add(this);
                }
                write(data) { return command(this, arguments.length, 'write', () => (isData(data) || data === null || typeof data !== 'object' ? { type: 'write', data } : data)); }
                seek(position) { return command(this, arguments.length, 'seek', () => ({ type: 'seek', position })); }
                truncate(size) { return command(this, arguments.length, 'truncate', () => ({ type: 'truncate', size })); }
            }
            function command(stream, argc, name, build) {
                if (!writers.has(stream))
                    return rejected(illegal());
                if (argc < 1)
                    return rejected(missing('FileSystemWritableFileStream', name, 0));
                if (stream.locked)
                    return rejected(new PTypeError(`Failed to execute '${name}' on 'FileSystemWritableFileStream': Cannot write to a locked stream`));
                // The command is queued on the stream's own queue and the lock goes at once: `locked` stays false between calls.
                const w = PWritableStream.prototype.getWriter.call(stream);
                let done;
                try {
                    done = w.write(build());
                } finally {
                    w.releaseLock();
                }
                return done;
            }

            // --- FileSystemSyncAccessHandle (dedicated Workers only) -------------------------------------------------
            const syncOf = new WeakMap();
            const unwrapSync = slot(syncOf);
            class FileSystemSyncAccessHandle {
                constructor() { throw illegalConstructor(); }
                read(buffer, options) { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncRead, n, argv(arguments))); }
                write(buffer, options) { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncWrite, n, argv(arguments))); }
                truncate(newSize) { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncTruncate, n, argv(arguments))); }
                getSize() { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncGetSize, n, [])); }
                flush() { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncFlush, n, [])); }
                close() { const n = unwrapSync(this); return guardSync(() => ReflectApply(N.syncClose, n, [])); }
            }

            // --- Files and directories -------------------------------------------------------------------------------
            // A File of the page's realm. When the page's File class is the host's own, the native snapshot is handed over;
            // otherwise (the engine's File) its bytes are copied into one.
            //
            // Chrome's File is a snapshot whose bytes are read when the page reads it: a read after the file changed or went
            // away rejects (NotReadableError, NotFoundError), and getFile() itself does not fail when a writer closes at the
            // same moment. The copy is taken at getFile(), so: a copy that a concurrent close made unreadable still gives the page
            // its File, and each read of the page's File first reads one byte of the native snapshot, so it
            // rejects as Chrome's does. (DayDream's file layer reported the copy's NotReadableError as `Error: i/o error`.)
            const nativeOfFile = new WeakMap();
            const validate = async (file) => {
                const n = nativeOfFile.get(file);
                if (n && ReflectApply(N.blobSize, n, []) > 0)
                    await ReflectApply(N.blobArrayBuffer, ReflectApply(N.blobSlice, n, [0, 1]), []);
            };
            let checkedFileProto = null;
            const checkedProto = () => {
                if (checkedFileProto)
                    return checkedFileProto;
                const proto = PFile.prototype;
                const props = {};
                for (const name of ['text', 'arrayBuffer', 'bytes']) {
                    const base = proto[name] || (PBlob && PBlob.prototype[name]);
                    if (typeof base !== 'function')
                        continue;
                    // A method of the page's File named and shaped as the original; it reads the page's copy once the snapshot is known good.
                    props[name] = { value: { [name]() { return guard(async () => { await validate(this); return ReflectApply(base, this, []); }); } }[name], writable: true, configurable: true };
                }
                checkedFileProto = Object.create(proto, props);
                return checkedFileProto;
            };
            const pageFile = async (handle) => {
                const f = await ReflectApply(N.getFile, handle, []);
                if (PFile === HostFile)
                    return f;
                let bytes;
                try {
                    bytes = new HostUint8Array(await ReflectApply(N.blobArrayBuffer, f, []));
                } catch (e) {
                    // The file changed or went away while the copy was read: Chrome's getFile() still answers this snapshot,
                    // and reading it rejects. The copy has the snapshot's size and reads reject through validate().
                    if (!e || (e.name !== 'NotReadableError' && e.name !== 'NotFoundError'))
                        throw e;
                    bytes = new HostUint8Array(ReflectApply(N.blobSize, f, []));
                }
                const copy = new PFile([bytes], f.name, { type: f.type, lastModified: f.lastModified });
                nativeOfFile.set(copy, f);
                Object.setPrototypeOf(copy, checkedProto());
                return copy;
            };
            class FileSystemFileHandle extends FileSystemHandle {
                getFile() {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    return guard(() => pageFile(n));
                }
                createWritable(options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    const a = argv(arguments);
                    return guard(async () => {
                        const stream = await ReflectApply(N.createWritable, n, a);
                        return new FileSystemWritableFileStream(MAKE, ReflectApply(N.getWriter, stream, []));
                    });
                }
                createSyncAccessHandle(options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    const a = argv(arguments);
                    return guard(async () => {
                        const h = await ReflectApply(N.createSyncAccessHandle, n, a);
                        const w = Object.create(FileSystemSyncAccessHandle.prototype);
                        syncOf.set(w, h);
                        return w;
                    });
                }
            }
            const iterState = new WeakMap();
            const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf((async function* () {}).prototype));
            class DirectoryIterator {
                constructor() { throw illegalConstructor(); }
                next() {
                    const s = iterState.get(this);
                    if (!s)
                        return rejected(illegal());
                    return guard(async () => {
                        const r = await s.it.next();
                        if (r.done)
                            return { value: undefined, done: true };
                        const [name, handle] = r.value;
                        return { value: s.kind === 'keys' ? name : s.kind === 'values' ? wrapHandle(handle) : [name, wrapHandle(handle)], done: false };
                    });
                }
                return(value) {
                    const s = iterState.get(this);
                    if (!s)
                        return rejected(illegal());
                    return guard(async () => {
                        if (typeof s.it.return === 'function')
                            await s.it.return(value);
                        return { value, done: true };
                    });
                }
            }
            Object.setPrototypeOf(DirectoryIterator.prototype, AsyncIteratorPrototype);
            const iterate = (self, kind) => {
                const n = unwrap(self);
                const w = Object.create(DirectoryIterator.prototype);
                iterState.set(w, { it: ReflectApply(N.entries, n, [])[Symbol.asyncIterator](), kind });
                return w;
            };
            class FileSystemDirectoryHandle extends FileSystemHandle {
                getFileHandle(name, options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    const a = argv(arguments);
                    return guard(async () => wrapHandle(await ReflectApply(N.getFileHandle, n, a)));
                }
                getDirectoryHandle(name, options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    const a = argv(arguments);
                    return guard(async () => wrapHandle(await ReflectApply(N.getDirectoryHandle, n, a)));
                }
                removeEntry(name, options) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    const a = argv(arguments);
                    return guard(() => ReflectApply(N.removeEntry, n, a));
                }
                resolve(possibleDescendant) {
                    let n;
                    try { n = unwrap(this); } catch (e) { return rejected(e); }
                    if (arguments.length < 1)
                        return rejected(missing('FileSystemDirectoryHandle', 'resolve', 0));
                    const o = handleArg(possibleDescendant);
                    if (!o)
                        return rejected(new PTypeError("Failed to execute 'resolve' on 'FileSystemDirectoryHandle': parameter 1 is not of type 'FileSystemHandle'."));
                    return guard(async () => {
                        const r = await ReflectApply(N.resolve, n, [o]);
                        return r === null ? null : Array.from(r, String);
                    });
                }
                entries() { return iterate(this, 'entries'); }
                keys() { return iterate(this, 'keys'); }
                values() { return iterate(this, 'values'); }
            }
            FSFileHandle = FileSystemFileHandle;
            FSDirectoryHandle = FileSystemDirectoryHandle;
            // Members of the host's interface that are not written out above: forwarded, handles unwrapped and wrapped.
            const fromNative = async (r) => {
                if (r !== null && typeof r === 'object' && FH && r instanceof FH)
                    return wrapHandle(r);
                if (HostFile && r instanceof HostFile)
                    return pageFile(r);
                return r;
            };
            for (const [tag, Ctor] of [['FileSystemHandle', FileSystemHandle], ['FileSystemFileHandle', FileSystemFileHandle], ['FileSystemDirectoryHandle', FileSystemDirectoryHandle]])
                for (const [key, nf] of NATIVE_METHODS[tag]) {
                    if (Object.prototype.hasOwnProperty.call(Ctor.prototype, key) || (tag !== 'FileSystemHandle' && Object.prototype.hasOwnProperty.call(FileSystemHandle.prototype, key)))
                        continue;
                    if (key === 'createSyncAccessHandle' || key === 'entries' || key === 'keys' || key === 'values')
                        continue;
                    defineProperty(Ctor.prototype, key, {
                        value: { [key]() {
                            let n;
                            try { n = unwrap(this); } catch (e) { return rejected(e); }
                            const a = argv(arguments).map((x) => handleArg(x) || x);
                            return guard(async () => fromNative(await ReflectApply(nf, n, a)));
                        } }[key],
                        writable: true, configurable: true,
                    });
                    LENGTHS[tag + '.' + key] = nf.length;
                }

            // --- StorageManager -------------------------------------------------------------------------------------
            const managers = new WeakSet();
            const manager = (self, fn) => (managers.has(self) ? guard(fn) : rejected(illegal()));
            class StorageManager {
                constructor() { throw illegalConstructor(); }
                getDirectory() { return manager(this, async () => wrapHandle(await ReflectApply(N.getDirectory, N.storage, []))); }
                estimate() {
                    return manager(this, async () => {
                        const e = await ReflectApply(N.estimate, N.storage, []);
                        const out = { usage: e.usage, quota: e.quota };
                        if (e.usageDetails)
                            out.usageDetails = { ...e.usageDetails };
                        return out;
                    });
                }
                persist() { return manager(this, () => ReflectApply(N.persist, N.storage, [])); }
                persisted() { return manager(this, () => ReflectApply(N.persisted, N.storage, [])); }
            }
            // A worker's StorageManager has no persist() (Chrome: [Exposed=Window]); the runner of the page's workers installs with no navigator target.
            if (navigatorTarget === null)
                delete StorageManager.prototype.persist;
            const storage = Object.create(StorageManager.prototype);
            managers.add(storage);

            // --- WebIDL shape: enumerable members, class tags, only the members this Chrome's interface has --------------
            const nativeFor = {
                FileSystemHandle: { isSameEntry: 'isSameEntry', getUniqueId: 'getUniqueId', queryPermission: 'queryPermission', requestPermission: 'requestPermission', remove: 'remove', move: 'move' },
                FileSystemFileHandle: { getFile: 'getFile', createWritable: 'createWritable', createSyncAccessHandle: sync ? 'createSyncAccessHandle' : null },
            };
            const shape = (Ctor, tag) => {
                const gone = nativeFor[tag] || {};
                for (const key of Reflect.ownKeys(Ctor.prototype)) {
                    if (key === 'constructor')
                        continue;
                    if (typeof key === 'string' && key in gone && (gone[key] === null || !N[gone[key]])) {
                        Reflect.deleteProperty(Ctor.prototype, key);
                        continue;
                    }
                    const d = getOwnPropertyDescriptor(Ctor.prototype, key);
                    defineProperty(Ctor.prototype, key, { ...d, enumerable: true });
                    // A member the subclass inherits is measured against the interface that declares it.
                    const len = LENGTHS[tag + '.' + key] !== undefined ? LENGTHS[tag + '.' + key] : (tag !== 'FileSystemHandle' ? LENGTHS['FileSystemHandle.' + key] : undefined);
                    if (typeof d.value === 'function' && len !== undefined)
                        defineProperty(d.value, 'length', { value: len, configurable: true });
                }
                defineProperty(Ctor.prototype, Symbol.toStringTag, { value: tag, configurable: true });
            };
            // createSyncAccessHandle is not in a window's or a service worker's FileSystemFileHandle at all.
            const classes = { FileSystemHandle, FileSystemFileHandle, FileSystemDirectoryHandle, FileSystemWritableFileStream, StorageManager };
            if (sync)
                classes.FileSystemSyncAccessHandle = FileSystemSyncAccessHandle;
            for (const tag of Object.keys(classes)) {
                shape(classes[tag], tag);
                defineProperty(classes[tag], 'length', { value: 0, configurable: true }); // none of them has a constructor a page may call
            }
            shape(DirectoryIterator, 'FileSystemDirectoryHandle AsyncIterator');
            defineProperty(FileSystemDirectoryHandle.prototype, Symbol.asyncIterator, { value: FileSystemDirectoryHandle.prototype.entries, writable: true, configurable: true });
            defineProperty(DirectoryIterator.prototype, Symbol.asyncIterator, { value: function () { return this; }, writable: true, configurable: true });
            void PObject;
            const define = () => {
                for (const n of Object.keys(classes))
                    defineProperty(P, n, { value: classes[n], writable: true, configurable: true });
                if (navigatorTarget)
                    defineProperty(navigatorTarget, 'storage', { get: () => storage, set: undefined, configurable: true, enumerable: true });
            };
            define();
            return { storage, redefine: define, names: Object.keys(classes) };
        }
        return { available, install };
    }
    G.__chitinOPFS = Object.freeze({ create });
})();
