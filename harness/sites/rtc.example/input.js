// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
'use strict';
const log = window.inputLog = [];
const c = document.getElementById('c');
const name = (e) => (e ? e.name + ': ' + e.message : 'none');
window.moves = [];
// Without a gesture: both refused, with the errors and events Chrome gives.
const early = window.early = {};
c.requestPointerLock().then(() => { early.lock = 'resolved'; }, (e) => { early.lock = name(e); });
document.documentElement.requestFullscreen().then(() => { early.fs = 'resolved'; }, (e) => { early.fs = name(e); });
document.addEventListener('pointerlockerror', (e) => log.push('pointerlockerror ' + e.bubbles));
document.addEventListener('fullscreenerror', (e) => log.push('fullscreenerror ' + e.bubbles));
document.addEventListener('pointerlockchange', (e) => log.push('pointerlockchange ' + e.bubbles + ' ' + (document.pointerLockElement === c)));
document.addEventListener('fullscreenchange', () => log.push('fullscreenchange ' + (document.fullscreenElement === document.documentElement) + ' ' + document.fullscreenElement?.matches(':fullscreen')));
c.addEventListener('click', () => {
    if (document.pointerLockElement === c)
        return;
    c.requestPointerLock().then(() => log.push('lock resolved ' + (document.pointerLockElement === c)), (e) => log.push('lock rejected ' + name(e)));
});
c.addEventListener('mousemove', (e) => { if (document.pointerLockElement === c) window.moves.push([e.movementX, e.movementY, e.target === c]); });
document.addEventListener('keydown', (e) => {
    if (e.key === 'f')
        document.documentElement.requestFullscreen().then(() => log.push('fullscreen resolved ' + (innerWidth > 400)), (err) => log.push('fullscreen rejected ' + name(err)));
    else if (e.key === 'x')
        document.exitFullscreen().then(() => log.push('exit resolved'), (err) => log.push('exit rejected ' + name(err)));
    else if (e.key === 'u')
        document.exitPointerLock();
});
window.pads = () => { const p = navigator.getGamepads(); return [Object.prototype.toString.call(p), p.length]; };
document.getElementById('s').textContent = 'ready';
