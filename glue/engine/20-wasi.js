// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin engine glue: the system imports of ganglion.wasm, written by hand in the hardened style of
// glue/00-primordials.js. Emscripten's own JS runtime never runs in the page realm (docs/toolchain.md);
// the module is linked standalone, so its C library asks for WASI functions and a few Emscripten
// library calls, and every one it can get is here. Anything else fails loudly (90-boot.js).
//
// References: WASI preview1 (wasi_snapshot_preview1), Emscripten 4.0.11 system/lib/libc and
// src/library_*.js for the env.* names (docs/phase1.md, "System imports").

const hostCrypto = globalThis.crypto;
const cryptoGetRandomValues = hostCrypto && hostCrypto.getRandomValues ? uncurryThis(hostCrypto.getRandomValues) : undefined;
const Uint8Array_ = globalThis.Uint8Array;
const BigInt64Array_ = globalThis.BigInt64Array;
const DateNow = globalThis.Date.now;
const HostBigInt = globalThis.BigInt;
const TextDecoderUtf8 = new TextDecoder('utf-8');

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_EINVAL = 28;
const WASI_ENOENT = 44;
const WASI_ENOSYS = 52;
const WASI_ENOTSUP = 58;

// Pending stderr/stdout text, flushed to the log at newlines.
let logBuffer = '';

function makeWasiImports(state) {
    // state: { u8(), u32(), f64(), log(text) } where the view getters return fresh views after growth.
    const emit = (bytes) => {
        logBuffer += TextDecoderPrototypeDecode(TextDecoderUtf8, bytes, { __proto__: null, stream: true });
        let nl;
        while ((nl = logBuffer.indexOf('\n')) >= 0) {
            state.log(logBuffer.slice(0, nl));
            logBuffer = logBuffer.slice(nl + 1);
        }
    };
    const wasi = { __proto__: null };
    wasi.fd_write = (fd, iovs, iovsLen, nwritten) => {
        const u8 = state.u8();
        const u32 = state.u32();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
            const ptr = u32[(iovs >>> 2) + i * 2];
            const len = u32[(iovs >>> 2) + i * 2 + 1];
            if (fd === 1 || fd === 2) {
                // A copy: the decoder must never see a view it could keep.
                const chunk = new Uint8Array_(len);
                for (let j = 0; j < len; j++)
                    chunk[j] = u8[ptr + j];
                emit(chunk);
            }
            total += len;
        }
        u32[nwritten >>> 2] = total;
        return fd === 1 || fd === 2 ? WASI_ESUCCESS : WASI_EBADF;
    };
    wasi.fd_read = (fd, iovs, iovsLen, nread) => {
        state.u32()[nread >>> 2] = 0;
        return fd === 0 ? WASI_ESUCCESS : WASI_EBADF;
    };
    wasi.fd_close = () => WASI_EBADF;
    wasi.fd_seek = (fd, offset, whence, newOffset) => WASI_EBADF;
    wasi.fd_sync = () => WASI_ESUCCESS;
    wasi.fd_fdstat_get = (fd, out) => {
        if (fd > 2)
            return WASI_EBADF;
        const u8 = state.u8();
        for (let i = 0; i < 24; i++)
            u8[out + i] = 0;
        u8[out] = 2; // character device
        return WASI_ESUCCESS;
    };
    wasi.fd_fdstat_set_flags = () => WASI_ENOSYS;
    wasi.fd_prestat_get = () => WASI_EBADF;
    wasi.fd_prestat_dir_name = () => WASI_EBADF;
    wasi.fd_filestat_get = () => WASI_EBADF;
    wasi.fd_readdir = () => WASI_EBADF;
    wasi.path_open = () => WASI_ENOENT;
    wasi.path_filestat_get = () => WASI_ENOENT;
    wasi.path_unlink_file = () => WASI_ENOENT;
    wasi.path_remove_directory = () => WASI_ENOENT;
    wasi.path_create_directory = () => WASI_ENOTSUP;
    wasi.path_readlink = () => WASI_ENOENT;
    wasi.path_rename = () => WASI_ENOENT;
    wasi.path_symlink = () => WASI_ENOTSUP;
    wasi.fd_pread = () => WASI_EBADF;
    wasi.fd_pwrite = () => WASI_EBADF;
    wasi.environ_sizes_get = (count, size) => {
        const u32 = state.u32();
        u32[count >>> 2] = 0;
        u32[size >>> 2] = 0;
        return WASI_ESUCCESS;
    };
    wasi.environ_get = () => WASI_ESUCCESS;
    wasi.args_sizes_get = (count, size) => {
        const u32 = state.u32();
        u32[count >>> 2] = 0;
        u32[size >>> 2] = 0;
        return WASI_ESUCCESS;
    };
    wasi.args_get = () => WASI_ESUCCESS;
    wasi.clock_res_get = (id, out) => {
        const u32 = state.u32();
        u32[out >>> 2] = 1000;
        u32[(out >>> 2) + 1] = 0;
        return WASI_ESUCCESS;
    };
    // i64 parameters arrive as BigInts (Emscripten links with WASM_BIGINT): (id, precision, out).
    wasi.clock_time_get = (id, precision, out) => {
        // 0 realtime, 1 monotonic (and the process/thread clocks count as monotonic here), in nanoseconds.
        let ns;
        if (id === 0)
            ns = HostBigInt(DateNow()) * 1000000n;
        else
            ns = HostBigInt(MathFloor(hostPerformanceNow(hostPerformance) * 1000)) * 1000n;
        // Two 32-bit stores: the out pointer need not be 8-byte aligned (Emscripten's clock_gettime passes a
        // 4-aligned stack slot), and a BigInt64Array index would floor it.
        const u32 = state.u32();
        u32[out >>> 2] = HostNumber(ns & 0xffffffffn);
        u32[(out >>> 2) + 1] = HostNumber(ns >> 32n);
        return WASI_ESUCCESS;
    };
    wasi.random_get = (ptr, len) => {
        const u8 = state.u8();
        if (!cryptoGetRandomValues)
            return WASI_ENOSYS;
        let done = 0;
        while (done < len) {
            const n = MathMin(65536, len - done);
            const chunk = new Uint8Array_(n);
            cryptoGetRandomValues(hostCrypto, chunk);
            for (let i = 0; i < n; i++)
                u8[ptr + done + i] = chunk[i];
            done += n;
        }
        return WASI_ESUCCESS;
    };
    wasi.proc_exit = (code) => {
        throw new HostError('ganglion: proc_exit(' + code + ')');
    };
    wasi.sched_yield = () => WASI_ESUCCESS;
    wasi.poll_oneoff = () => WASI_ENOSYS;
    return wasi;
}

// The Emscripten library functions the standalone module still imports from "env". Each one is here
// because the link listed it; an import without an entry fails at instantiation (90-boot.js).
function makeEnvImports(state) {
    const env = { __proto__: null };
    env.emscripten_notify_memory_growth = () => state.refreshViews();
    env.emscripten_date_now = () => DateNow();
    env.emscripten_get_now = () => hostPerformanceNow(hostPerformance);
    env._emscripten_get_now_is_monotonic = () => 1;
    env._abort_js = () => {
        throw new HostError('ganglion: abort()');
    };
    env.__assert_fail = (condition, file, line, func) => {
        throw new HostError('ganglion: assertion failed: ' + state.cString(condition) + ' at ' + state.cString(file) + ':' + line);
    };
    // setjmp/longjmp, Emscripten style: a function that calls setjmp calls its callees through invoke_<sig>,
    // which catches the longjmp (thrown here as a number, which nothing else throws) and tells the wasm side
    // with setThrew. FreeType, libpng and libjpeg use setjmp for their error paths.
    env._emscripten_throw_longjmp = () => {
        throw Infinity;
    };
    env.__syscall_getcwd = (buf, size) => {
        const u8 = state.u8();
        if (size < 2)
            return -34; // ERANGE
        u8[buf] = 47; // "/"
        u8[buf + 1] = 0;
        return 2;
    };
    env.__syscall_ioctl = () => -25; // ENOTTY
    env.__syscall_fcntl64 = () => -9; // EBADF
    env.__syscall_openat = () => -2; // ENOENT
    env.__syscall_stat64 = () => -2;
    env.__syscall_lstat64 = () => -2;
    env.__syscall_fstat64 = () => -9;
    env.__syscall_newfstatat = () => -2;
    env.__syscall_readlinkat = () => -2;
    env.__syscall_mkdirat = () => -38;
    env.__syscall_unlinkat = () => -2;
    env.__syscall_rmdir = () => -2;
    env.__syscall_renameat = () => -2;
    env.__syscall_faccessat = () => -2;
    env.__syscall_getdents64 = () => -9;
    env.__syscall_pipe = () => -38; // ENOSYS
    env.__syscall_poll = () => -38;
    env.__syscall_dup3 = () => -38;
    env.__syscall_socket = () => -38;
    env.__syscall_connect = () => -38;
    env.__syscall_bind = () => -38;
    env.__syscall_listen = () => -38;
    env.__syscall_accept4 = () => -38;
    env.__syscall_sendto = () => -38;
    env.__syscall_recvfrom = () => -38;
    env.__syscall_getsockopt = () => -38;
    env.__syscall_setsockopt = () => -38;
    env.__syscall_getsockname = () => -38;
    env.__syscall_getpeername = () => -38;
    env.__syscall_shutdown = () => -38;
    env._mmap_js = () => -38;
    env._munmap_js = () => -38;
    env._msync_js = () => -38;
    env._tzset_js = (timezone, daylight, stdName, dstName) => {
        const u32 = state.u32();
        const u8 = state.u8();
        u32[timezone >>> 2] = 0;
        u32[daylight >>> 2] = 0;
        u8[stdName] = 85; // "UTC"
        u8[stdName + 1] = 84;
        u8[stdName + 2] = 67;
        u8[stdName + 3] = 0;
        u8[dstName] = 85;
        u8[dstName + 1] = 84;
        u8[dstName + 2] = 67;
        u8[dstName + 3] = 0;
    };
    const writeTm = (tm, t, utc) => {
        const d = new (globalThis.Date)(t * 1000);
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        i32[base] = utc ? d.getUTCSeconds() : d.getSeconds();
        i32[base + 1] = utc ? d.getUTCMinutes() : d.getMinutes();
        i32[base + 2] = utc ? d.getUTCHours() : d.getHours();
        i32[base + 3] = utc ? d.getUTCDate() : d.getDate();
        i32[base + 4] = utc ? d.getUTCMonth() : d.getMonth();
        i32[base + 5] = (utc ? d.getUTCFullYear() : d.getFullYear()) - 1900;
        i32[base + 6] = utc ? d.getUTCDay() : d.getDay();
        const start = new (globalThis.Date)(d.getFullYear(), 0, 1);
        i32[base + 7] = MathFloor((d - start) / 86400000);
        i32[base + 8] = 0;
        i32[base + 9] = utc ? 0 : -d.getTimezoneOffset() * 60;
    };
    env._localtime_js = (t, tm) => writeTm(tm, HostNumber(t), false);
    env._gmtime_js = (t, tm) => writeTm(tm, HostNumber(t), true);
    env._mktime_js = (tm) => {
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        const d = new (globalThis.Date)(i32[base + 5] + 1900, i32[base + 4], i32[base + 3], i32[base + 2], i32[base + 1], i32[base]);
        return HostBigInt(MathFloor(d.getTime() / 1000));
    };
    env._timegm_js = (tm) => {
        const i32 = new (globalThis.Int32Array)(state.buffer());
        const base = tm >>> 2;
        return HostBigInt(MathFloor(globalThis.Date.UTC(i32[base + 5] + 1900, i32[base + 4], i32[base + 3], i32[base + 2], i32[base + 1], i32[base]) / 1000));
    };
    env._setitimer_js = () => 0;
    env.emscripten_get_heap_max = () => 2147483648;
    env.emscripten_resize_heap = (requested) => {
        // Growth is driven by the module itself in standalone mode through memory.grow; a request here means
        // sbrk could not grow: let it, in 64 KiB pages.
        const memory = state.memory();
        const current = WebAssemblyMemoryPrototypeGetBuffer(memory).byteLength;
        const pages = MathFloor((requested - current + 65535) / 65536);
        try {
            memory.grow(pages);
            state.refreshViews();
            return 1;
        } catch {
            return 0;
        }
    };
    env.emscripten_console_error = (ptr) => state.log(state.cString(ptr));
    env.emscripten_err = (ptr) => state.log(state.cString(ptr));
    env.emscripten_out = (ptr) => state.log(state.cString(ptr));
    env._emscripten_system = () => -38;
    env._emscripten_runtime_keepalive_clear = () => {};
    env.emscripten_force_exit = (code) => {
        throw new HostError('ganglion: exit(' + code + ')');
    };
    env.exit = env.emscripten_force_exit;
    env._exit = env.emscripten_force_exit;
    env.pthread_setname_np = () => 0;
    env.pthread_getname_np = () => 0;
    env.__syscall_ftruncate64 = () => -9;
    env.__syscall_recvmsg = () => -38;
    env.__syscall_sendmsg = () => -38;
    env.getentropy = (ptr, len) => {
        const u8 = state.u8();
        if (!cryptoGetRandomValues)
            return -1;
        const chunk = new Uint8Array_(len);
        cryptoGetRandomValues(hostCrypto, chunk);
        for (let i = 0; i < len; i++)
            u8[ptr + i] = chunk[i];
        return 0;
    };
    return env;
}
