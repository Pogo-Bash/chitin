// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The engine half of Chitin's compositor (docs/compositor.md): the recorded display list is split into layers
// (spans of commands in paint order, keyed by the scroll, sticky or animated-transform node they move with, and
// canvases), each layer is rastered on the CPU into 512 px tiles in its own space, only the tiles a layer's own
// damage touches are rastered again, and the carapace composites the tiles (harness/carapace/compositor.mjs).

#pragma once

#include <AK/StringView.h>
#include <AK/Types.h>
#include <AK/Vector.h>
#include <LibCompositing/DisplayList/CompositedContext.h>
#include <LibGfx/Rect.h>

namespace Compositing {
class DisplayList;
class AccumulatedVisualContextTree;
class ScrollStateSnapshot;
class DisplayListResourceStorage;
class CanvasSurfaceRegistry;
}

namespace Compositor {
class DisplayListRasterCache;
class DisplayListPlayerSkia;
}

namespace Ganglion::Layers {

// Flat: one frame, as before (the debug and reference path). Layers: the carapace composites tiles, and a
// backdrop-filtered box is rastered here with what is behind it (its layer covers its region). HostBackdrop: as
// Layers, but a blur/saturate backdrop filter is the carapace's (WebGL2), and the box's own layer leaves it out.
enum class Mode : int {
    Flat = 0,
    Layers = 1,
    HostBackdrop = 2,
};

struct PaintInput {
    Compositing::DisplayList const& list;
    Compositing::AccumulatedVisualContextTree const& tree;
    Compositing::ScrollStateSnapshot const& scroll;
    // The previous frame's list, tree and scroll state, for damage (null on the first frame).
    Compositing::DisplayList const* last_list;
    Compositing::AccumulatedVisualContextTree const* last_tree;
    Compositing::ScrollStateSnapshot const* last_scroll;
    bool recorded;   // the list was recorded again (else only offsets may have changed)
    bool force_full;    // something the lists do not show changed (a new frame, a reset, the clear colour): raster all
    // A video's frame or a same-site frame's document changed (the list does not show it): damage is their boxes
    // (the DrawVideoFrame / DrawCompositedContext commands), not every layer (docs/scroll.md, D1).
    bool media_changed;
    Gfx::IntRect frame_rect;
    Compositing::DisplayListResourceStorage const& resources;
    Compositor::DisplayListRasterCache& raster_cache;
    Compositor::DisplayListPlayerSkia& player;
    Compositing::CanvasSurfaceRegistry const* canvases;
    Compositing::CompositedContextResolver const* children;
    u8 fill;  // the root layer's fill before raster, and its alpha (the provenance marks, docs/provenance.md)
    u8 alpha;
};

struct DirtyTile {
    u32 layer;
    int tile_x, tile_y; // the tile's grid position
    Gfx::IntRect rect;  // the changed part, in the tile's own pixels
    Vector<u8> rgba;    // RGBA, not premultiplied (ImageData), rect.width() * rect.height() * 4 bytes
};

struct Stats {
    double raster_ms { 0 };
    double split_ms { 0 };
    double convert_ms { 0 }; // of raster_ms: BGRA premultiplied -> RGBA for the host
    u32 layers { 0 };
    u32 tiles { 0 };
    u32 tiles_rastered { 0 };
    u32 tiles_rastered_visible { 0 }; // of a scroll layer, on screen: what scrolling within the tiles must not need
    u64 bytes { 0 };
    u64 tile_pixels { 0 };
    bool flattened { false }; // over budget or unsplittable: one layer
};

void set_mode(Mode);
void set_debug(bool);
Mode mode();
// Forgets every layer and tile (a new document, a resize): the next paint sends everything.
void reset();
// Splits, finds damage per layer, rasters the dirty tiles. Returns false if nothing could be painted.
bool paint(PaintInput const&);
// The layer tree of the last paint as JSON for the host (docs/compositor.md "Frame message").
StringView frame_json();
Vector<DirtyTile> const& dirty_tiles();
Stats const& last_stats();
// Tiles ahead are still to be rastered: the host asks for another paint.
bool prefetch_pending();
// Dirty tiles as the tiles' own BGRA premultiplied rows (the WebGL2 carapace swizzles), not RGBA straight alpha.
void set_raw_tiles(bool);
bool raw_tiles();
// The carapace's scroll offsets (P3): the device offset of a scroll node as the user last saw it. Tiles are rastered
// ahead around it as well as around the engine's own offset.
void set_host_scroll_offset(u32 node, float x, float y);
void set_host_scroll_seq(u32 node, u32 seq);

}
