// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Canvas 2D in the engine. LibWeb records a context's drawing as canvas commands and hands them to a
// compositor process, which replays them on a surface it owns and shows that surface when a frame draws the
// canvas. The engine has no compositor process, so this is its half of that: a transport that replays the
// commands in-process (Gfx::CanvasCommandPlayer), the surface registry the frame's display list player
// resolves DrawCanvas against, and the read-back getImageData and toDataURL use.

#pragma once

#include <LibCompositing/DisplayList/CanvasSurfaceRegistry.h>

namespace Ganglion {

// Gives 2D contexts a transport (RemoteCanvas2DTransport::local_factory). Once, before any page script.
void install_canvas_2d();

// Replays the commands recorded since the last flush. A frame is painted after this.
void flush_canvas_2d();

// Whether drawing is waiting to be replayed: a frame is owed (LibWeb asks the compositor for one itself).
bool canvas_2d_pending();

// The presented surfaces of the page's canvases, for the display list player.
Compositing::CanvasSurfaceRegistry const& canvas_surfaces();

// The same registry, for the other canvas kinds that present surfaces (WebGL.cpp).
Compositing::CanvasSurfaceRegistry& mutable_canvas_surfaces();

}
