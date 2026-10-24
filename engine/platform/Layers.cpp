// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Chitin's compositor, engine half (docs/compositor.md). See Layers.h for the shape; the steps of paint():
//   1. read the tree (spatial/clip/effect nodes) and the list's runs through patch 0049's introspection;
//   2. promote nodes: scroll containers, sticky boxes, roots of running transform animations (2D affine only;
//      scroll and sticky nodes translation-only, with a rectangular scrollport);
//   3. key every run by its nearest promoted node; an opacity/filter/mask/blend effect whose runs fall in several
//      keys moves them all to the keys' common ancestor (a group effect is never split); canvases are their own span;
//      a backdrop-filtered box is its own span (rastered with what is behind it, or left to the carapace's GPU blur);
//   4. cut the commands into spans of one key in paint order: the layers (over budget: one layer);
//   5. per layer, a content hash over its commands and the values of their contexts relative to the layer's node;
//      a layer whose hash changed is damaged where the list's damage is, mapped into its space; one whose hash is the
//      same is not rastered, whatever else moved;
//   6. raster the dirty parts of the needed tiles (a scroll layer's tiles cover the scrollport and one scrollport
//      ahead, each rastered with the scroll offset that puts it inside the scrollport, so the scrollport's clip
//      never cuts a tile), and hand them out as RGBA.

#include "Layers.h"
#include <AK/HashMap.h>
#include <AK/HashTable.h>
#include <AK/OwnPtr.h>
#include <AK/QuickSort.h>
#include <AK/StringBuilder.h>
#include <AK/Time.h>
#include <Compositor/DisplayListPlayerSkia.h>
#include <Compositor/DisplayListRasterCache.h>
#include <LibCompositing/DisplayList/AccumulatedVisualContext.h>
#include <LibCompositing/DisplayList/CanvasSurfaceRegistry.h>
#include <LibCompositing/DisplayList/CompositedContext.h>
#include <LibCompositing/DisplayList/DisplayList.h>
#include <LibCompositing/DisplayList/DisplayListDamage.h>
#include <LibCompositing/DisplayList/DisplayListResourceStorage.h>
#include <LibCompositing/RustFFI.h>
#include <LibCompositing/Scrolling/AsyncScrollingState.h>
#include <LibGfx/Bitmap.h>
#include <LibGfx/Matrix4x4.h>
#include <LibGfx/PaintingSurface.h>
#include <core/SkCanvas.h>
#include <core/SkImage.h>
#include <core/SkPixmap.h>
#include <math.h>

extern "C" void ganglion_host_log(char const*, size_t);

namespace Ganglion::Layers {

using namespace Compositing;

static bool s_debug { false };
void set_debug(bool on) { s_debug = on; }
static void debug_log(StringView text)
{
    if (s_debug)
        ganglion_host_log(text.characters_without_null_termination(), text.length());
}

static constexpr int TILE = 512;
// Tiles ahead of a scroll are rastered while a paint has taken less than this (ms), at least one a paint.
static constexpr double PREFETCH_UNTIL_MS = 6.0;
static constexpr size_t MAX_LAYERS = 32;
static constexpr int MIN_SCROLLPORT = 64;

static Mode s_mode = Mode::Flat;
void set_mode(Mode mode) { s_mode = mode; }
Mode mode() { return s_mode; }

// --- 2D affine maps: x' = a x + c y + e, y' = b x + d y + f -------------------------------------------------
struct Affine {
    double a { 1 }, b { 0 }, c { 0 }, d { 1 }, e { 0 }, f { 0 };
    bool is_translation() const { return a == 1 && b == 0 && c == 0 && d == 1; }
    Affine multiplied(Affine const& o) const // this * o (o first)
    {
        return { a * o.a + c * o.b, b * o.a + d * o.b, a * o.c + c * o.d, b * o.c + d * o.d, a * o.e + c * o.f + e, b * o.e + d * o.f + f };
    }
    Optional<Affine> inverse() const
    {
        double det = a * d - b * c;
        if (det == 0 || !isfinite(det))
            return {};
        Affine r { d / det, -b / det, -c / det, a / det, 0, 0 };
        r.e = -(r.a * e + r.c * f);
        r.f = -(r.b * e + r.d * f);
        return r;
    }
    Gfx::FloatRect map(Gfx::FloatRect const& r) const
    {
        double xs[4] = { r.x(), r.right(), r.x(), r.right() };
        double ys[4] = { r.y(), r.y(), r.bottom(), r.bottom() };
        double x0 = INFINITY, y0 = INFINITY, x1 = -INFINITY, y1 = -INFINITY;
        for (int i = 0; i < 4; ++i) {
            double x = a * xs[i] + c * ys[i] + e, y = b * xs[i] + d * ys[i] + f;
            x0 = min(x0, x), y0 = min(y0, y), x1 = max(x1, x), y1 = max(y1, y);
        }
        return { static_cast<float>(x0), static_cast<float>(y0), static_cast<float>(x1 - x0), static_cast<float>(y1 - y0) };
    }
    bool operator==(Affine const&) const = default;
};

static Optional<Affine> affine_of(Gfx::FloatMatrix4x4 const& m)
{
    if (!Gfx::is_2d_affine_transform(m))
        return {};
    return Affine { m[0, 0], m[1, 0], m[0, 1], m[1, 1], m[0, 3], m[1, 3] };
}

static Gfx::IntRect enclosing(Gfx::FloatRect const& r)
{
    if (r.is_empty() || !isfinite(r.x()) || !isfinite(r.y()) || !isfinite(r.width()) || !isfinite(r.height()))
        return {};
    int x0 = static_cast<int>(floorf(r.x())), y0 = static_cast<int>(floorf(r.y()));
    int x1 = static_cast<int>(ceilf(r.right())), y1 = static_cast<int>(ceilf(r.bottom()));
    return { x0, y0, x1 - x0, y1 - y0 };
}

static Gfx::IntRect united(Gfx::IntRect a, Gfx::IntRect b)
{
    if (a.is_empty())
        return b;
    if (b.is_empty())
        return a;
    return a.united(b);
}

// --- Hashing (FNV-1a, 64 bits) --------------------------------------------------------------------------------
struct Hasher {
    u64 h { 0xcbf29ce484222325ull };
    void bytes(void const* data, size_t size)
    {
        auto const* p = static_cast<u8 const*>(data);
        for (size_t i = 0; i < size; ++i) {
            h ^= p[i];
            h *= 0x100000001b3ull;
        }
    }
    // Long tapes: 8 bytes at a time (the same quality is not needed, only change detection).
    void wide(ReadonlyBytes data)
    {
        size_t i = 0;
        for (; i + 8 <= data.size(); i += 8) {
            u64 v;
            __builtin_memcpy(&v, data.data() + i, 8);
            h = (h ^ v) * 0x100000001b3ull;
            h ^= h >> 29;
        }
        bytes(data.data() + i, data.size() - i);
    }
    template<typename T>
    void value(T const& v) { bytes(&v, sizeof(v)); }
    void affine(Affine const& m)
    {
        float v[6] = { static_cast<float>(m.a), static_cast<float>(m.b), static_cast<float>(m.c), static_cast<float>(m.d), static_cast<float>(m.e), static_cast<float>(m.f) };
        bytes(v, sizeof(v));
    }
};

// --- State ---------------------------------------------------------------------------------------------------
enum class Kind : u8 {
    Root = 0,
    Scroll = 1,
    Sticky = 2,
    Transform = 3,
};

enum SpanFlag : u32 {
    SpanCanvas = 1u << 28,
    SpanBackdrop = 2u << 28,     // rastered with everything below it, in viewport space
    SpanHostBackdrop = 3u << 28, // its backdrop filter is the carapace's
};

struct Tile {
    RefPtr<Gfx::Bitmap> bitmap;
    Gfx::IntRect valid; // the part rastered (layer space); the rest of the tile is clear
};

struct Span {
    u32 key { 0 };     // the promoted spatial node (0: the root)
    u32 flag { 0 };    // SpanFlag | effect or canvas ordinal
    u32 begin_run { 0 }, begin_command { 0 };
    u32 end_run { 0 }, end_command { 0 }; // exclusive
    Vector<u32> runs;
    i32 canvas { -1 }; // a canvas span: the DrawCanvas (index into the list's drawn canvases)
};

struct Layer {
    AK_ALLOC_WITH_KMALLOC;
    u32 id { 0 };
    u32 key { 0 };
    u32 flag { 0 };
    Kind kind { Kind::Root };
    u64 hash { 0 };
    u64 bytes_hash { 0 };
    bool fresh { true };
    bool resplit { false }; // its span covers other commands than last frame
    Affine m;        // local -> viewport, now
    Affine raster_m; // the matrix the tiles were rastered under (non-scroll layers)
    Gfx::IntRect clip; // viewport; empty: none
    bool clip_cuts { false };
    int tw { TILE }, th { TILE };
    HashMap<u64, Tile> tiles;
    Span span;
    Gfx::IntRect region; // local: what the tiles must cover
    Gfx::IntRect scrollport; // viewport, scroll layers: where tiles are rastered
    Gfx::IntRect extent;     // local, scroll layers: the content's ink (the carapace's checkerboard measure)
    float clip_radius { 0 }; // scroll layers: the corner radius of a rounded scrollport (the carapace clips it)
    Gfx::FloatPoint scroll_offset; // device offset of the scroll node when m was taken
    Gfx::FloatPoint last_offset;   // scroll layers: the offset of the paint before (the direction tiles are needed in)
    u32 why { 0 };                 // the last paint's reasons to raster (bits, see paint())
    Array<u32, 4> resplit_runs {}; // run ranges [a0, a1], [b0, b1] across which the span's boundaries moved
    Array<Gfx::IntRect, 2> last_damage {}; // viewport: the list's damage and the resplit's, of the last paint (trace)
    // Host backdrop (HostBackdrop mode): the region (viewport) and the filter.
    Gfx::IntRect backdrop_region;
    float corner_radius { 0 };
    float blur { 0 };
    float saturate { 1 };
    bool seen { false };
    double raster_ms { 0 }; // this frame's raster of this layer (paint ms per layer, the benchmarks)
};

static HashMap<u64, NonnullOwnPtr<Layer>> s_layers;
static Vector<Layer*> s_order;
static u32 s_next_id { 1 };
static Vector<DirtyTile> s_dirty;
static ByteBuffer s_json;
static Stats s_stats;
static HashMap<u32, Gfx::FloatPoint> s_host_offsets;
static HashMap<u32, u32> s_host_seq; // scroll node -> the last carapace scroll (its sequence number) the engine applied
static Vector<u64> s_prev_order_ids;
static bool s_prefetch_pending { false };
struct TransformState {
    Affine local;
    u64 changed_at { 0 };
};
static HashMap<u32, TransformState> s_transforms;
static u64 s_transform_epoch { 0 };
static u64 s_frame { 0 };
bool prefetch_pending() { return s_prefetch_pending; }

void reset()
{
    s_layers.clear();
    s_order.clear();
    s_dirty.clear();
    s_prev_order_ids.clear();
}

Vector<DirtyTile> const& dirty_tiles() { return s_dirty; }
Stats const& last_stats() { return s_stats; }
StringView frame_json() { return { reinterpret_cast<char const*>(s_json.data()), s_json.size() }; }
void set_host_scroll_offset(u32 node, float x, float y) { s_host_offsets.set(node, { x, y }); }
void set_host_scroll_seq(u32 node, u32 seq) { s_host_seq.set(node, seq); }

static u64 pack(int i, int j) { return (static_cast<u64>(static_cast<u32>(i)) << 32) | static_cast<u32>(j); }
static int unpack_i(u64 k) { return static_cast<int>(static_cast<u32>(k >> 32)); }
static int unpack_j(u64 k) { return static_cast<int>(static_cast<u32>(k)); }

// The filter bytes of a backdrop filter as a blur radius (a standard deviation, device pixels) and a saturation,
// if that is all they are: the shapes the carapace draws (blur(r), saturate(s), both in either order).
static bool parse_backdrop(ReadonlyBytes bytes, float& blur, float& saturate)
{
    blur = 0;
    saturate = 1;
    if (bytes.is_empty())
        return false;
    RustFFI::FfiFilterFunction functions[4];
    size_t count = RustFFI::filter_bytes_simple_functions(bytes.data(), bytes.size(), functions, 4);
    if (count == 0 || count > 2)
        return false;
    for (size_t i = 0; i < count; ++i) {
        auto const& fn = functions[i];
        if (fn.kind == RustFFI::FfiFilterFunctionKind::Blur && blur == 0)
            blur = fn.amount;
        else if (fn.kind == RustFFI::FfiFilterFunctionKind::Color && fn.color_operation == Gfx::ColorFilterType::Saturate && saturate == 1)
            saturate = fn.amount;
        else
            return false;
    }
    return true;
}

bool paint(PaintInput const& in)
{
    auto t0 = MonotonicTime::now();
    s_dirty.clear();
    s_stats = {};
    auto const& tree = in.tree;
    auto const& list = in.list;
    void const* tree_handle = tree.rust_handle();
    void const* list_handle = list.rust_handle();

    // 1. The tree and the runs.
    u32 counts[4] {};
    RustFFI::visual_context_tree_layer_node_counts(tree_handle, counts);
    u32 spatial_count = counts[0], clip_count = counts[1], effect_count = counts[2];
    bool sorting = counts[3] != 0;
    Vector<RustFFI::FfiLayerSpatialNodeInfo> spatial;
    Vector<RustFFI::FfiLayerClipNodeInfo> clips;
    Vector<RustFFI::FfiLayerEffectNodeInfo> effects;
    spatial.resize(spatial_count);
    clips.resize(clip_count);
    effects.resize(effect_count);
    for (u32 i = 0; i < spatial_count; ++i)
        RustFFI::visual_context_tree_layer_spatial_node_info(tree_handle, i, &spatial[i]);
    for (u32 i = 0; i < clip_count; ++i)
        RustFFI::visual_context_tree_layer_clip_node_info(tree_handle, i, &clips[i]);
    for (u32 i = 0; i < effect_count; ++i)
        RustFFI::visual_context_tree_layer_effect_node_info(tree_handle, i, &effects[i]);
    u32 run_count = static_cast<u32>(list.run_count());
    Vector<RustFFI::FfiLayerRunInfo> runs;
    runs.resize(run_count);
    for (u32 r = 0; r < run_count; ++r)
        RustFFI::display_list_layer_run_info(list_handle, r, &runs[r]);
    // Canvases: (run, command) of each top-level DrawCanvas; and where each command starts in its run's records.
    struct CommandAt {
        u32 run, command;
    };
    struct CommandScan {
        Vector<CommandAt> canvases;
        Vector<u32> offsets;     // per command, in tape order
        Vector<u32> run_first;   // per run: the index of its first command in `offsets`
        Vector<CommandAt> scroll_bars;
        Vector<Gfx::IntRect> scroll_bar_rects; // in the run's spatial space
        Vector<CommandAt> media;               // DrawVideoFrame, DrawCompositedContext
        Vector<Gfx::IntRect> media_rects;      // in the run's spatial space
    } scan;
    scan.run_first.resize(run_count + 1);
    RustFFI::display_list_layer_for_each_command(list_handle, &scan, [](void* context, u32 run, u32 command, DisplayListCommandType type, Gfx::IntRect rect, u32 offset) {
        auto& scan = *static_cast<CommandScan*>(context);
        if (command == 0)
            scan.run_first[run] = scan.offsets.size();
        scan.offsets.append(offset);
        if (type == DisplayListCommandType::DrawCanvas)
            scan.canvases.append({ run, command });
        if (type == DisplayListCommandType::DrawVideoFrame || type == DisplayListCommandType::DrawCompositedContext) {
            scan.media.append({ run, command });
            scan.media_rects.append(rect);
        }
        if (type == DisplayListCommandType::PaintScrollBar) {
            scan.scroll_bars.append({ run, command });
            scan.scroll_bar_rects.append(rect);
        }
    });
    scan.run_first[run_count] = scan.offsets.size();
    if (s_debug) {
        // Which runs' bytes changed since the last recording, and where (debug: unstable command bytes defeat hashing).
        static Vector<ByteBuffer> s_last_runs;
        Vector<ByteBuffer> now;
        for (u32 r = 0; r < run_count; ++r)
            now.append(MUST(ByteBuffer::copy(ReadonlyBytes { runs[r].records, runs[r].records_size })));
        if (s_last_runs.size() == now.size()) {
            int logged = 0;
            for (u32 r = 0; r < run_count && logged < 6; ++r) {
                if (s_last_runs[r] == now[r])
                    continue;
                size_t at = 0;
                while (at < now[r].size() && at < s_last_runs[r].size() && now[r][at] == s_last_runs[r][at])
                    ++at;
                // The command holding byte `at`.
                u32 command = 0;
                for (u32 c = 0; c < runs[r].command_count; ++c)
                    if (scan.offsets[scan.run_first[r] + c] <= at)
                        command = c;
                debug_log(ByteString::formatted("layers: run {} bytes differ at {} (command {} of {}), sizes {} -> {}", r, at, command, runs[r].command_count, s_last_runs[r].size(), now[r].size()));
                ++logged;
            }
        }
        s_last_runs = move(now);
    }
    auto& canvases = scan.canvases;
    Vector<DrawCanvas> drawn;
    list.for_each_drawn_canvas([&](ContextRef, Gfx::IntRect, DrawCanvas const& command) { drawn.append(command); });
    if (drawn.size() != canvases.size())
        drawn.clear(); // not the same records: no direct canvas copies this frame
    // The bytes of commands [first, last) of a run.
    auto command_bytes = [&](u32 run, u32 first, u32 last) -> ReadonlyBytes {
        auto const& info = runs[run];
        u32 count = info.command_count;
        first = min(first, count);
        last = min(last, count);
        if (first >= last)
            return {};
        size_t begin = scan.offsets[scan.run_first[run] + first];
        size_t end = last == count ? info.records_size : scan.offsets[scan.run_first[run] + last];
        return { info.records + begin, end - begin };
    };

    // Matrices, now.
    Vector<Optional<Affine>> matrix;
    matrix.resize(spatial_count);
    for (u32 i = 0; i < spatial_count; ++i)
        matrix[i] = affine_of(tree.accumulated_matrix(SpatialNodeIndex { i }, in.scroll, AccumulatedVisualContextTree::IncludeVisualViewportTransform::Yes));

    // Is `node` in the subtree of `root`?
    auto in_subtree = [&](u32 node, u32 root) {
        for (u32 n = node, guard = 0; guard < spatial_count + 1; ++guard) {
            if (n == root)
                return true;
            if (n == 0 || n >= spatial_count)
                return false;
            n = spatial[n].parent;
        }
        return false;
    };

    // A transform that changed in the last second (a CSS animation or transition, or script moving it every frame) is
    // promoted as a running transform: the tree shows compositor animations only when LibWeb publishes them to a
    // compositor host, which this embedder does not have.
    ++s_frame;
    if (tree.structural_epoch() != s_transform_epoch) {
        s_transforms.clear();
        s_transform_epoch = tree.structural_epoch();
    }
    Vector<bool> moving;
    moving.resize(spatial_count);
    for (u32 i = 1; i < spatial_count; ++i) {
        if (spatial[i].kind != 3 || !matrix[i].has_value())
            continue;
        auto parent = matrix[spatial[i].parent < spatial_count ? spatial[i].parent : 0];
        auto parent_inverse = parent.has_value() ? parent->inverse() : Optional<Affine> {};
        if (!parent_inverse.has_value())
            continue;
        auto local = parent_inverse->multiplied(*matrix[i]);
        auto it = s_transforms.find(i);
        if (it == s_transforms.end()) {
            s_transforms.set(i, { local, 0 });
            continue;
        }
        if (!(it->value.local == local)) {
            it->value.local = local;
            it->value.changed_at = s_frame;
        }
        moving[i] = it->value.changed_at != 0 && s_frame - it->value.changed_at < 60;
    }

    // 2. Promotion.
    Vector<bool> promoted;
    promoted.resize(spatial_count);
    auto animated = tree.spatial_nodes_in_subtrees_of_transform_animations();
    for (u32 i = 1; i < spatial_count && !sorting; ++i) {
        auto const& info = spatial[i];
        if (!matrix[i].has_value())
            continue;
        if (info.kind == 1 || info.kind == 2)
            promoted[i] = matrix[i]->is_translation();
        else if (info.kind == 3 && i < animated.size() && animated[i] && !(info.parent < animated.size() && animated[info.parent]))
            promoted[i] = true;
        else if (info.kind == 3 && i < moving.size() && moving[i])
            promoted[i] = true;
    }
    // A promoted node under a non-affine ancestor would be positioned wrongly: such subtrees stay in the parent.
    for (u32 i = 1; i < spatial_count; ++i) {
        if (!promoted[i])
            continue;
        for (u32 n = spatial[i].parent, guard = 0; n != 0 && n < spatial_count && guard < spatial_count; n = spatial[n].parent, ++guard) {
            if (!matrix[n].has_value()) {
                promoted[i] = false;
                break;
            }
        }
    }

    // The outer clip of a run relative to a key: the clips on the run's chain whose space is outside the key's subtree.
    // Returns the viewport rect they intersect to, or {} (none); `rect_only` false when one is rounded, a path or a
    // difference.
    // `radius`, when given: the largest corner radius of a rounded rect clip among them whose rect is the result's (a
    // rounded scrollport the carapace clips, docs/scroll.md R1); such a clip then does not count against rect_only.
    auto outer_clip = [&](u32 clip, u32 key, bool& rect_only, float* radius = nullptr) -> Optional<Gfx::FloatRect> {
        rect_only = true;
        struct RoundedClip {
            Gfx::FloatRect rect;
            float radius;
        };
        Vector<RoundedClip> rounded_clips;
        Optional<Gfx::FloatRect> result;
        for (u32 c = clip, guard = 0; c != NumericLimits<u32>::max() && c < clip_count && guard < clip_count + 1; c = clips[c].parent, ++guard) {
            auto const& info = clips[c];
            if (key != 0 && in_subtree(info.spatial, key))
                continue;
            if (key == 0)
                continue;
            bool rounded = info.corner_radii.top_left.horizontal_radius > 0 || info.corner_radii.top_right.horizontal_radius > 0
                || info.corner_radii.bottom_left.horizontal_radius > 0 || info.corner_radii.bottom_right.horizontal_radius > 0;
            auto viewport = tree.transform_rect_to_viewport(SpatialNodeIndex { info.spatial }, info.rect, in.scroll);
            if (info.kind != 1 || info.difference || (rounded && !radius))
                rect_only = false;
            else if (rounded) {
                auto const& r = info.corner_radii;
                float most = max(max(r.top_left.horizontal_radius, r.top_right.horizontal_radius), max(r.bottom_left.horizontal_radius, r.bottom_right.horizontal_radius));
                most = max(most, max(max(r.top_left.vertical_radius, r.top_right.vertical_radius), max(r.bottom_left.vertical_radius, r.bottom_right.vertical_radius)));
                rounded_clips.append({ viewport, most });
            }
            result = result.has_value() ? result->intersected(viewport) : viewport;
        }
        if (radius && result.has_value()) {
            *radius = 0;
            for (auto const& rc : rounded_clips) {
                // Its corners are the port's corners only when its rect is the port; else they fall outside the port (no
                // effect) or inside a side of it (a shape the carapace does not clip: stay in the parent).
                auto e = enclosing(rc.rect), port = enclosing(*result);
                if (e == port)
                    *radius = max(*radius, rc.radius);
                else if (e.contains(port) && (e.x() == port.x() || e.y() == port.y() || e.right() == port.right() || e.bottom() == port.bottom()) && rc.radius > 0)
                    rect_only = false;
            }
        }
        return result;
    };
    HashMap<u32, float> port_radius;

    Vector<u32> key_of;
    auto compute_keys = [&] {
        key_of.clear();
        key_of.resize(spatial_count);
        // Parents can be stored after children: resolve by walking up.
        for (u32 i = 0; i < spatial_count; ++i) {
            u32 n = i;
            for (u32 guard = 0; guard < spatial_count + 1; ++guard) {
                if (n == 0 || n >= spatial_count) {
                    n = 0;
                    break;
                }
                if (promoted[n])
                    break;
                n = spatial[n].parent;
            }
            key_of[i] = n;
        }
    };
    compute_keys();

    // A scroll node needs a rectangular scrollport that leaves room for tiles; else it stays in its parent.
    HashMap<u32, Gfx::IntRect> scrollports;
    for (u32 pass = 0; pass < 2; ++pass) {
        bool changed = false;
        scrollports.clear();
        port_radius.clear();
        for (u32 r = 0; r < run_count; ++r) {
            u32 key = key_of[runs[r].context.spatial.value() < spatial_count ? runs[r].context.spatial.value() : 0];
            if (key == 0 || spatial[key].kind != 1 || scrollports.contains(key))
                continue;
            bool rect_only = true;
            float radius = 0;
            auto clip = outer_clip(runs[r].context.clip.value(), key, rect_only, &radius);
            Gfx::IntRect port = in.frame_rect;
            if (clip.has_value())
                port = enclosing(*clip).intersected(in.frame_rect);
            int inset = static_cast<int>(ceil(radius));
            if (!rect_only || port.width() - 2 * inset < MIN_SCROLLPORT || port.height() - 2 * inset < MIN_SCROLLPORT) {
                promoted[key] = false;
                changed = true;
                continue;
            }
            scrollports.set(key, port);
            port_radius.set(key, radius);
        }
        if (!changed)
            break;
        compute_keys();
    }

    // 3. Keys per run, group effects, backdrops.
    Vector<u32> run_key;
    run_key.resize(run_count);
    for (u32 r = 0; r < run_count; ++r) {
        auto s = runs[r].context.spatial.value();
        run_key[r] = s < spatial_count ? key_of[s] : 0;
    }
    auto meaningful = [&](u32 e) {
        auto const& info = effects[e];
        if (info.kind == 2)
            return true; // a mask
        if (info.kind != 1)
            return false;
        return info.opacity < 1.0f || !info.blend_normal || info.filter_size > 0 || info.backdrop_filter_size > 0;
    };
    auto parent_key = [&](u32 key) -> u32 { return key == 0 ? 0 : key_of[spatial[key].parent < spatial_count ? spatial[key].parent : 0]; };
    auto key_depth = [&](u32 key) { u32 d = 0; for (u32 k = key, g = 0; k != 0 && g < spatial_count; k = parent_key(k), ++g) ++d; return d; };
    auto common_key = [&](u32 a, u32 b) {
        while (key_depth(a) > key_depth(b)) a = parent_key(a);
        while (key_depth(b) > key_depth(a)) b = parent_key(b);
        for (u32 g = 0; a != b && g < spatial_count; ++g) a = parent_key(a), b = parent_key(b);
        return a;
    };
    for (u32 iteration = 0; iteration < 4; ++iteration) {
        HashMap<u32, u32> effect_key; // effect -> common key of its runs
        for (u32 r = 0; r < run_count; ++r) {
            for (u32 e = runs[r].context.effect.value(), guard = 0; e < effect_count && guard < effect_count + 1; e = effects[e].parent, ++guard) {
                if (!meaningful(e))
                    continue;
                auto it = effect_key.find(e);
                if (it == effect_key.end())
                    effect_key.set(e, run_key[r]);
                else
                    it->value = common_key(it->value, run_key[r]);
            }
        }
        bool changed = false;
        for (u32 r = 0; r < run_count; ++r) {
            u32 key = run_key[r];
            for (u32 e = runs[r].context.effect.value(), guard = 0; e < effect_count && guard < effect_count + 1; e = effects[e].parent, ++guard) {
                if (!meaningful(e))
                    continue;
                key = common_key(key, effect_key.get(e).value_or(key));
            }
            if (key != run_key[r]) {
                run_key[r] = key;
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    // A run that reads what is behind it: a backdrop filter or a blend mode on its chain (the innermost such effect).
    Vector<u32> run_flag;
    run_flag.resize(run_count);
    Vector<i32> run_backdrop_effect;
    run_backdrop_effect.resize(run_count);
    for (u32 r = 0; r < run_count; ++r) {
        run_backdrop_effect[r] = -1;
        for (u32 e = runs[r].context.effect.value(), guard = 0; e < effect_count && guard < effect_count + 1; e = effects[e].parent, ++guard) {
            auto const& info = effects[e];
            if (info.kind == 1 && (info.backdrop_filter_size > 0 || !info.blend_normal)) {
                run_backdrop_effect[r] = static_cast<i32>(e);
                break;
            }
        }
        if (run_backdrop_effect[r] < 0)
            continue;
        auto const& info = effects[run_backdrop_effect[r]];
        float blur = 0, saturate = 1;
        bool host = s_mode == Mode::HostBackdrop && info.backdrop_filter_size > 0 && info.blend_normal && info.opacity >= 1.0f && info.filter_size == 0
            && parse_backdrop({ info.backdrop_filter, info.backdrop_filter_size }, blur, saturate);
        // Only the innermost backdrop effect, and only when it is the run's effect or directly above meaningless ones.
        run_flag[r] = (host ? SpanHostBackdrop : SpanBackdrop) | (static_cast<u32>(run_backdrop_effect[r]) & 0x0fffffff);
        if (!host)
            run_key[r] = 0; // rastered in viewport space with everything below
    }

    // 4. Spans in paint order.
    Vector<Span> spans;
    auto canvas_index = 0u;
    auto open_span = [&](u32 key, u32 flag, u32 run, u32 command) {
        if (!spans.is_empty()) {
            auto& last = spans.last();
            if (last.key == key && last.flag == flag && (last.flag & 0xf0000000) != SpanCanvas)
                return;
            last.end_run = run;
            last.end_command = command;
        }
        Span span;
        span.key = key;
        span.flag = flag;
        span.begin_run = run;
        span.begin_command = command;
        spans.append(move(span));
    };
    size_t next_canvas = 0;
    for (u32 r = 0; r < run_count; ++r) {
        u32 key = run_key[r];
        u32 flag = run_flag[r];
        // Canvases are their own span when their run has no effect worth keeping together (else they stay in place).
        bool canvas_ok = flag == 0;
        if (canvas_ok) {
            for (u32 e = runs[r].context.effect.value(), guard = 0; e < effect_count && guard < effect_count + 1; e = effects[e].parent, ++guard)
                if (meaningful(e))
                    canvas_ok = false;
        }
        while (next_canvas < canvases.size() && canvases[next_canvas].run < r)
            ++next_canvas;
        u32 command = 0;
        open_span(key, flag, r, 0);
        spans.last().runs.append(r);
        while (canvas_ok && next_canvas < canvases.size() && canvases[next_canvas].run == r) {
            u32 at = canvases[next_canvas].command;
            if (at > command)
                open_span(key, flag, r, command); // continues the current span
            open_span(key, SpanCanvas | (++canvas_index & 0x0fffffff), r, at);
            spans.last().runs.append(r);
            spans.last().canvas = static_cast<i32>(next_canvas);
            open_span(key, flag, r, at + 1);
            spans.last().runs.append(r);
            command = at + 1;
            ++next_canvas;
        }
    }
    if (!spans.is_empty()) {
        spans.last().end_run = run_count;
        spans.last().end_command = 0;
    }
    // Drop spans with no commands (a canvas at the end of its run leaves one).
    spans.remove_all_matching([&](Span const& s) {
        if (s.begin_run > s.end_run)
            return true;
        if (s.begin_run == s.end_run && s.begin_command >= s.end_command)
            return true;
        if (s.end_run == s.begin_run + 1 && s.end_command == 0 && s.begin_command >= runs[s.begin_run].command_count)
            return true;
        return false;
    });
    // Merge neighbours of the same key and flag again (a dropped empty span can leave two side by side).
    for (size_t i = 1; i < spans.size();) {
        auto& a = spans[i - 1];
        auto& b = spans[i];
        if (a.key == b.key && a.flag == b.flag && (a.flag & 0xf0000000) != SpanCanvas) {
            a.end_run = b.end_run;
            a.end_command = b.end_command;
            for (auto r : b.runs)
                if (a.runs.is_empty() || a.runs.last() != r)
                    a.runs.append(r);
            spans.remove(i);
            continue;
        }
        ++i;
    }
    if (sorting || spans.size() > MAX_LAYERS || spans.is_empty()) {
        s_stats.flattened = true;
        Span all;
        all.key = 0;
        all.flag = 0;
        all.begin_run = 0;
        all.begin_command = 0;
        all.end_run = run_count;
        all.end_command = 0;
        for (u32 r = 0; r < run_count; ++r)
            all.runs.append(r);
        spans.clear();
        spans.append(move(all));
    }
    s_stats.split_ms = (MonotonicTime::now() - t0).to_nanoseconds() / 1e6;

    // 5. Layers: identity (key, flag kind, ordinal), geometry, content hash.
    for (auto& [_, layer] : s_layers)
        layer->seen = false;
    s_order.clear();
    HashMap<u64, u32> ordinals;
    bool scroll_changed_anywhere = in.last_scroll == nullptr;
    if (in.last_scroll) {
        auto a = in.last_scroll->device_offsets();
        auto b = in.scroll.device_offsets();
        if (a.size() != b.size())
            scroll_changed_anywhere = true;
        else
            for (size_t i = 0; i < a.size(); ++i)
                if (a[i] != b[i])
                    scroll_changed_anywhere = true;
    }
    for (auto& span : spans) {
        u32 flag_kind = span.flag & 0xf0000000;
        u64 identity_base = (static_cast<u64>(span.key) << 32) | flag_kind;
        u32 ordinal = ordinals.get(identity_base).value_or(0);
        ordinals.set(identity_base, ordinal + 1);
        u64 identity = identity_base ^ (static_cast<u64>(ordinal) * 0x9E3779B97F4A7C15ull);
        auto it = s_layers.find(identity);
        if (it == s_layers.end()) {
            auto layer = make<Layer>();
            layer->id = s_next_id++;
            s_layers.set(identity, move(layer));
            it = s_layers.find(identity);
        }
        auto& layer = *it->value;
        layer.seen = true;
        Kind kind = span.key == 0 ? Kind::Root : spatial[span.key].kind == 1 ? Kind::Scroll : spatial[span.key].kind == 2 ? Kind::Sticky : Kind::Transform;
        if (layer.kind != kind || layer.key != span.key) {
            layer.tiles.clear();
            layer.fresh = true;
        }
        layer.kind = kind;
        layer.key = span.key;
        layer.flag = span.flag;
        // Other commands than last frame (the split moved): the list's damage does not say so, raster all of it.
        // Only the runs between the old and the new boundaries can have come in or gone out (indices of the new list; a
        // run that moved in index only is rastered again for nothing, a bounded cost): their ink is the damage, with
        // the list's own (docs/scroll.md, D2; before, the whole layer was rastered again whenever its range moved, as
        // YouTube's results list does on every append).
        if (!layer.fresh && (layer.span.begin_run != span.begin_run || layer.span.begin_command != span.begin_command || layer.span.end_run != span.end_run || layer.span.end_command != span.end_command)) {
            layer.resplit = true;
            layer.resplit_runs = { min(layer.span.begin_run, span.begin_run), max(layer.span.begin_run, span.begin_run), min(layer.span.end_run, span.end_run), max(layer.span.end_run, span.end_run) };
        }
        layer.span = span;
        auto m = span.key == 0 ? Affine {} : matrix[span.key].value_or(Affine {});
        layer.m = m;
        layer.scroll_offset = span.key == 0 ? Gfx::FloatPoint {} : in.scroll.device_offset_for_index(SpatialNodeIndex { span.key });
        s_order.append(&layer);
    }

    // The list's damage (content only: both lists at the new offsets), computed when some layer's content changed.
    Optional<Gfx::IntRect> list_damage;
    bool list_damage_known = false;
    auto damage = [&]() -> Optional<Gfx::IntRect> {
        if (list_damage_known)
            return list_damage;
        list_damage_known = true;
        if (!in.last_list || !in.last_tree || in.force_full)
            return list_damage = {};
        Gfx::IntRect big { -(1 << 20), -(1 << 20), 1 << 21, 1 << 21 };
        auto old_scroll = in.scroll;
        if (in.last_tree->spatial_node_count() != tree.spatial_node_count()) {
            old_scroll = *in.last_scroll;
        } else if (in.last_scroll) {
            // Only a promoted scroller's content moves on the carapace (its layer moves). A scroller that is not a layer
            // (a rounded scrollport, too small, under a rounded clip) moves its content inside the tiles of the layer
            // around it: compared at its old offset, the old and new pixels are damage (docs/scroll.md, finding B1).
            for (u32 i = 1; i < spatial_count; ++i)
                if (spatial[i].kind == 1 && !promoted[i])
                    old_scroll.set_device_offset_for_index(SpatialNodeIndex { i }, in.last_scroll->device_offset_for_index(SpatialNodeIndex { i }));
        }
        auto d = compute_display_list_damage(*in.last_list, *in.last_tree, old_scroll, list, tree, in.scroll, big);
        if (in.media_changed && d.has_value()) {
            Gfx::IntRect media = *d;
            for (size_t k = 0; k < scan.media.size(); ++k) {
                auto s = runs[scan.media[k].run].context.spatial.value();
                media = united(media, enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { s < spatial_count ? s : 0 }, scan.media_rects[k].to_type<float>(), in.scroll)));
            }
            d = media;
        }
        list_damage = d;
        return list_damage;
    };

    Gfx::IntRect viewport_damage; // what changed on screen this frame (for backdrop layers)
    int prefetch_done = 0;
    s_prefetch_pending = false;
    Gfx::IntRect frame = in.frame_rect;
    u64 pixels_kept = 0;

    for (size_t index = 0; index < s_order.size(); ++index) {
        auto& layer = *s_order[index];
        auto const& span = layer.span;
        auto t_layer = MonotonicTime::now();
        u32 flag_kind = span.flag & 0xf0000000;
        bool backdrop_flat = flag_kind == SpanBackdrop;
        bool host_backdrop = flag_kind == SpanHostBackdrop;
        auto inverse = layer.m.inverse().value_or(Affine {});

        // Hash over the span's commands and the values of their contexts relative to the layer.
        Hasher hasher;
        Hasher bytes_hasher; // the commands themselves: only when the list was recorded again
        hasher.value(span.begin_run);
        hasher.value(span.begin_command);
        hasher.value(span.end_run);
        hasher.value(span.end_command);
        Gfx::IntRect ink_viewport;
        bool clip_cuts = false;
        Gfx::IntRect clip_rect;
        bool clip_set = false;
        for (auto r : span.runs) {
            auto const& run = runs[r];
            u32 s = run.context.spatial.value() < spatial_count ? run.context.spatial.value() : 0;
            if (in.recorded || layer.fresh) {
                u32 first = r == span.begin_run ? span.begin_command : 0;
                u32 last = r == span.end_run ? span.end_command : NumericLimits<u32>::max();
                bytes_hasher.wide(command_bytes(r, first, last));
                bytes_hasher.value(run.context);
            }
            auto run_matrix = matrix[s].value_or(Affine {});
            hasher.affine(inverse.multiplied(run_matrix));
            // Clips: inner clips by value relative to the layer; outer clips of a scroll layer not at all (tiles are
            // placed inside them); other outer clips by where they fall on the layer.
            for (u32 c = run.context.clip.value(), guard = 0; c < clip_count && guard < clip_count + 1; c = clips[c].parent, ++guard) {
                auto const& info = clips[c];
                bool inner = span.key == 0 || in_subtree(info.spatial, span.key);
                if (inner) {
                    hasher.value(info.kind);
                    hasher.value(info.rect);
                    hasher.value(info.corner_radii);
                    hasher.value(info.difference);
                    hasher.affine(inverse.multiplied(matrix[info.spatial < spatial_count ? info.spatial : 0].value_or(Affine {})));
                    continue;
                }
                auto viewport = tree.transform_rect_to_viewport(SpatialNodeIndex { info.spatial }, info.rect, in.scroll);
                if (layer.kind != Kind::Scroll)
                    hasher.value(inverse.map(viewport));
                auto rect = enclosing(viewport);
                clip_rect = clip_set ? clip_rect.intersected(rect) : rect;
                clip_set = true;
            }
            for (u32 e = run.context.effect.value(), guard = 0; e < effect_count && guard < effect_count + 1; e = effects[e].parent, ++guard) {
                auto const& info = effects[e];
                hasher.value(info.kind);
                hasher.value(info.opacity);
                hasher.value(info.blend_normal);
                if (info.filter_size)
                    hasher.bytes(info.filter, info.filter_size);
                if (info.backdrop_filter_size)
                    hasher.bytes(info.backdrop_filter, info.backdrop_filter_size);
                hasher.value(info.backdrop_region);
            }
            ink_viewport = united(ink_viewport, enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { s }, run.ink_bounds.to_type<float>(), in.scroll)));
        }
        u64 bytes_hash = (in.recorded || layer.fresh) ? bytes_hasher.h : layer.bytes_hash; // else the commands are the last frame's
        hasher.value(bytes_hash);
        u64 hash = hasher.h;
        bool content_changed = layer.fresh || hash != layer.hash || in.force_full || in.media_changed;

        // Geometry.
        layer.clip = clip_set && layer.kind != Kind::Root ? clip_rect : Gfx::IntRect {};
        if (backdrop_flat) {
            layer.m = {};
            inverse = {};
        }
        Gfx::IntRect needed;
        Gfx::IntRect visible_for_stats; // scroll layers: the scrollport in layer space
        Gfx::IntRect host_visible;      // scroll layers: the scrollport at the carapace's offset, in layer space
        Gfx::FloatPoint motion;         // scroll layers: which way what is on screen moves through the layer
        bool clip_moved = false;
        if (layer.kind == Kind::Scroll && !backdrop_flat) {
            auto port = scrollports.get(span.key).value_or(frame);
            layer.scrollport = port;
            layer.clip_radius = port_radius.get(span.key).value_or(0);
            // Under a rounded port the tiles are rastered inset by the radius (inside its straight part), so its corners
            // never cut a tile; the carapace clips the corners (docs/scroll.md R1).
            int inset = static_cast<int>(ceil(layer.clip_radius));
            int tw = min(TILE, port.width() - 2 * inset), th = min(TILE, port.height() - 2 * inset);
            if (tw != layer.tw || th != layer.th) {
                layer.tiles.clear();
                layer.tw = tw;
                layer.th = th;
                content_changed = true;
            }
            auto extent = enclosing(inverse.map(ink_viewport.to_type<float>()));
            auto visible = enclosing(inverse.map(port.to_type<float>()));
            // One scrollport ahead on every side (and around the carapace's own offset, when it scrolls ahead).
            auto ahead = visible.inflated(port.height() * 2, port.width() * 2);
            motion = layer.last_offset - layer.scroll_offset;
            layer.last_offset = layer.scroll_offset;
            if (auto host = s_host_offsets.get(span.key); host.has_value()) {
                auto shift = layer.scroll_offset - *host;
                host_visible = visible.translated(static_cast<int>(shift.x()), static_cast<int>(shift.y()));
                if (shift.x() != 0 || shift.y() != 0)
                    motion = shift;
                ahead = ahead.united(visible.translated(static_cast<int>(shift.x()), static_cast<int>(shift.y())).inflated(port.height() * 2, port.width() * 2));
            }
            // Whole tiles, so a tile is rastered once and never grows as the window moves.
            auto align_down = [](int v, int step) { return static_cast<int>(floor(static_cast<double>(v) / step)) * step; };
            int ax0 = align_down(ahead.x(), tw), ay0 = align_down(ahead.y(), th);
            int ax1 = align_down(ahead.right() - 1, tw) + tw, ay1 = align_down(ahead.bottom() - 1, th) + th;
            ahead = { ax0, ay0, ax1 - ax0, ay1 - ay0 };
            needed = extent.intersected(ahead);
            layer.extent = extent;
            layer.clip = port;
            visible_for_stats = visible;
        } else {
            layer.tw = TILE;
            layer.th = TILE;
            Gfx::IntRect visible_ink = backdrop_flat ? frame : ink_viewport.intersected(frame);
            if (backdrop_flat) {
                i32 e = run_backdrop_effect[span.runs.first()];
                if (e >= 0) {
                    auto const& info = effects[e];
                    auto region = enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { info.spatial }, info.backdrop_region.to_type<float>(), in.scroll));
                    layer.backdrop_region = region.intersected(frame);
                    layer.corner_radius = info.backdrop_corner_radii.top_left.horizontal_radius;
                    parse_backdrop({ info.backdrop_filter, info.backdrop_filter_size }, layer.blur, layer.saturate);
                    if (backdrop_flat)
                        visible_ink = ink_viewport.united(region).intersected(frame);
                }
            }
            needed = enclosing(inverse.map(visible_ink.to_type<float>()));
            if (layer.kind == Kind::Root)
                needed = backdrop_flat ? visible_ink : (index == 0 ? frame : visible_ink);
            // Non-scroll layers whose outer clip cut their content were rastered with the clip where it was.
            if (layer.kind != Kind::Root && clip_set && !clip_rect.contains(ink_viewport.intersected(frame)))
                clip_cuts = true;
            // Their pixels were cut where the clip was: moved, all of what shows now is rastered again (the list's damage
            // sees no change in a scroll and would leave the part the clip had cut away unpainted; docs/scroll.md, B2).
            if (layer.kind != Kind::Root && (clip_cuts || layer.clip_cuts) && !(layer.m == layer.raster_m)) {
                content_changed = true;
                clip_moved = true;
            }
        }
        // A backdrop the carapace draws: its region (viewport) and filter, whatever kind the layer is.
        if (host_backdrop && s_debug)
            debug_log(ByteString::formatted("layers: host backdrop layer {} runs {} first effect {}", layer.id, span.runs.size(), span.runs.is_empty() ? -2 : run_backdrop_effect[span.runs.first()]));
        if (host_backdrop && !span.runs.is_empty()) {
            i32 e = run_backdrop_effect[span.runs.first()];
            if (e >= 0) {
                auto const& info = effects[e];
                auto region = enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { info.spatial }, info.backdrop_region.to_type<float>(), in.scroll));
                layer.backdrop_region = region.intersected(frame);
                layer.corner_radius = info.backdrop_corner_radii.top_left.horizontal_radius;
                parse_backdrop({ info.backdrop_filter, info.backdrop_filter_size }, layer.blur, layer.saturate);
                if (s_debug)
                    debug_log(ByteString::formatted("layers: backdrop of {}: effect {} spatial {} region {} -> {}", layer.id, e, info.spatial, info.backdrop_region, region));
            }
        }
        layer.clip_cuts = clip_cuts;
        if (backdrop_flat && (scroll_changed_anywhere || !viewport_damage.intersected(layer.backdrop_region.inflated(64, 64)).is_empty()))
            content_changed = true;
        layer.region = needed;

        // Which parts to raster: the damage in this layer's space, or everything.
        Optional<Gfx::IntRect> local_damage;
        bool all = layer.fresh || in.force_full || backdrop_flat || clip_moved;
        Optional<Gfx::IntRect> resplit_damage;
        if (layer.resplit && !all) {
            Gfx::IntRect r;
            auto add = [&](u32 from, u32 to) {
                for (u32 k = from; k <= to && k < run_count; ++k) {
                    u32 sp = runs[k].context.spatial.value() < spatial_count ? runs[k].context.spatial.value() : 0;
                    r = united(r, enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { sp }, runs[k].ink_bounds.to_type<float>(), in.scroll)));
                }
            };
            add(layer.resplit_runs[0], layer.resplit_runs[1]);
            add(layer.resplit_runs[2], layer.resplit_runs[3]);
            resplit_damage = r;
        }
        // Why it rastered (the scroll trace, docs/scroll.md): 1 new, 2 resplit, 4 forced (video, frames), 8 clip moved,
        // 16 backdrop, 32 content changed (damage only), 64 a video or frame document changed (their boxes).
        layer.why = (layer.fresh ? 1 : 0) | (layer.resplit ? 2 : 0) | (in.force_full ? 4 : 0) | (clip_moved ? 8 : 0) | (backdrop_flat ? 16 : 0) | (content_changed ? 32 : 0) | (in.media_changed ? 64 : 0);
        if (layer.resplit)
            content_changed = true;
        layer.resplit = false;
        layer.last_damage = {};
        if (content_changed && !all) {
            auto d = damage();
            if (!d.has_value()) {
                all = true;
            } else {
                auto v = resplit_damage.has_value() ? united(*d, *resplit_damage) : *d;
                layer.last_damage = { *d, resplit_damage.value_or({}) };
                if (!v.is_empty())
                    local_damage = enclosing(inverse.map(v.to_type<float>())).inflated(2, 2);
            }
        }
        // Scroll bars this layer paints for a scroller that moved: their own rects (the thumb moves along the track).
        if (in.last_scroll && !all) {
            for (size_t b = 0; b < scan.scroll_bars.size(); ++b) {
                auto at = scan.scroll_bars[b];
                bool in_span = (at.run > span.begin_run || (at.run == span.begin_run && at.command >= span.begin_command))
                    && (at.run < span.end_run || (at.run == span.end_run && at.command < span.end_command));
                if (!in_span)
                    continue;
                auto node = runs[at.run].scroll_bar_node;
                if (node == 0 || in.last_scroll->device_offset_for_index(SpatialNodeIndex { node }) == in.scroll.device_offset_for_index(SpatialNodeIndex { node }))
                    continue;
                u32 s = runs[at.run].context.spatial.value() < spatial_count ? runs[at.run].context.spatial.value() : 0;
                auto rect = enclosing(inverse.map(tree.transform_rect_to_viewport(SpatialNodeIndex { s }, scan.scroll_bar_rects[b].to_type<float>(), in.scroll))).inflated(2, 2);
                local_damage = local_damage.has_value() ? local_damage->united(rect) : rect;
            }
        }
        if (s_debug)
            debug_log(ByteString::formatted("layers: {} {} key {} hash {} changed {} all {} damage {} needed {}", layer.id, to_underlying(layer.kind), span.key, hash != layer.hash, content_changed, all, local_damage, needed));
        // A canvas drawn 1:1 under a translation, with no clip or effect of its own: its tiles are copied straight from
        // the canvas's pixels (a replay would snapshot and draw the whole canvas into every tile).
        struct FastCanvas {
            sk_sp<SkImage> image;
            SkPixmap pixmap;
            Gfx::IntRect dst; // layer space
            bool bgra { false };
        };
        Optional<FastCanvas> fast_canvas;
        if (flag_kind == SpanCanvas && span.canvas >= 0 && static_cast<size_t>(span.canvas) < drawn.size() && in.canvases) {
            auto const& command = drawn[span.canvas];
            auto const& run = runs[span.begin_run];
            u32 s = run.context.spatial.value() < spatial_count ? run.context.spatial.value() : 0;
            auto rel = inverse.multiplied(matrix[s].value_or(Affine {}));
            bool inner_clip = false;
            for (u32 c = run.context.clip.value(), guard = 0; c < clip_count && guard < clip_count + 1; c = clips[c].parent, ++guard)
                if (span.key == 0 || in_subtree(clips[c].spatial, span.key))
                    inner_clip = true;
            auto const* surface = in.canvases->canvas_surface(command.canvas_id);
            if (rel.is_translation() && !inner_clip && surface && rel.e == floor(rel.e) && rel.f == floor(rel.f)) {
                FastCanvas f;
                f.image = surface->sk_image_snapshot<sk_sp<SkImage>>();
                f.dst = command.dst_rect.translated(static_cast<int>(rel.e), static_cast<int>(rel.f));
                if (f.image && f.image->peekPixels(&f.pixmap) && f.pixmap.width() == f.dst.width() && f.pixmap.height() == f.dst.height()
                    && (f.pixmap.colorType() == kRGBA_8888_SkColorType || f.pixmap.colorType() == kBGRA_8888_SkColorType)
                    && f.pixmap.alphaType() != kUnpremul_SkAlphaType) {
                    f.bgra = f.pixmap.colorType() == kBGRA_8888_SkColorType;
                    fast_canvas = move(f);
                }
            }
        }

        // Tiles: keep those near what is needed, add the missing ones, raster what changed.
        Vector<u64> drop;
        auto keep = layer.kind == Kind::Scroll ? needed.inflated(layer.th * 2, layer.tw * 2) : needed;
        for (auto& [key, tile] : layer.tiles) {
            Gfx::IntRect rect { unpack_i(key) * layer.tw, unpack_j(key) * layer.th, layer.tw, layer.th };
            if (!rect.intersects(keep))
                drop.append(key);
        }
        for (auto key : drop)
            layer.tiles.remove(key);
        if (!needed.is_empty()) {
            int i0 = static_cast<int>(floor(static_cast<double>(needed.x()) / layer.tw));
            int j0 = static_cast<int>(floor(static_cast<double>(needed.y()) / layer.th));
            int i1 = static_cast<int>(floor(static_cast<double>(needed.right() - 1) / layer.tw));
            int j1 = static_cast<int>(floor(static_cast<double>(needed.bottom() - 1) / layer.th));
            // Tiles in priority order (docs/scroll.md, A1): those on screen at the engine's or the carapace's offset first,
            // then the ones ahead by distance from what is on screen, the side the scroll is moving to counting a third
            // (Chrome's prepaint skews the same way).
            Vector<Array<int, 3>> order;
            auto near = host_visible.is_empty() ? visible_for_stats : visible_for_stats.united(host_visible);
            for (int j = j0; j <= j1; ++j) {
                for (int i = i0; i <= i1; ++i) {
                    Gfx::IntRect tile_rect { i * layer.tw, j * layer.th, layer.tw, layer.th };
                    int priority = 0;
                    if (layer.kind == Kind::Scroll && !near.is_empty() && !tile_rect.intersects(visible_for_stats) && !(!host_visible.is_empty() && tile_rect.intersects(host_visible))) {
                        auto gap = [](int lo, int hi, int near_lo, int near_hi) { return hi <= near_lo ? hi - near_lo : lo >= near_hi ? lo - near_hi : 0; };
                        int gx = gap(tile_rect.x(), tile_rect.right(), near.x(), near.right());
                        int gy = gap(tile_rect.y(), tile_rect.bottom(), near.y(), near.bottom());
                        auto weigh = [](int g, float dir) { return (g > 0 && dir > 0) || (g < 0 && dir < 0) ? abs(g) / 3.0f : static_cast<float>(abs(g)); };
                        priority = 1 + static_cast<int>(weigh(gx, motion.x()) + weigh(gy, motion.y()));
                    }
                    order.append({ i, j, priority });
                }
            }
            quick_sort(order, [](auto const& a, auto const& b) { return a[2] < b[2]; });
            for (auto const& place : order) {
                {
                    int i = place[0], j = place[1];
                    Gfx::IntRect tile_rect { i * layer.tw, j * layer.th, layer.tw, layer.th };
                    Gfx::IntRect dirty;
                    auto key = pack(i, j);
                    auto it = layer.tiles.find(key);
                    // A scroll layer's tiles off screen are rastered ahead, a few per paint, so a step of scrolling never
                    // pays for many at once; the next paint continues (prefetch_pending).
                    bool prefetch = place[2] > 0;
                    // Ahead: at least one tile a paint, then while the paint is under its budget.
                    bool over = prefetch_done > 0 && (MonotonicTime::now() - t0).to_nanoseconds() / 1e6 >= PREFETCH_UNTIL_MS;
                    // A tile ahead that this paint's damage hits, over budget: marked invalid and rastered again by
                    // priority in a later paint (first thing once it is on screen); the carapace shows its old pixels
                    // meanwhile, which the damage often does not really change (a page-wide damage when the tree's
                    // contexts do not pair up, YouTube's appends). docs/scroll.md, D3. Before, every damaged tile ahead
                    // was rastered in the same paint.
                    if (prefetch && it != layer.tiles.end() && ((all && content_changed) || (local_damage.has_value() && tile_rect.intersects(*local_damage)))) {
                        if (over) {
                            it->value.valid = {};
                            s_prefetch_pending = true;
                            continue;
                        }
                        ++prefetch_done;
                    }
                    if (prefetch && (it == layer.tiles.end() || !it->value.valid.contains(tile_rect.intersected(needed))) && over) {
                        s_prefetch_pending = true;
                        continue;
                    }
                    if (prefetch && (it == layer.tiles.end() || !it->value.valid.contains(tile_rect.intersected(needed))))
                        ++prefetch_done;
                    if (it == layer.tiles.end()) {
                        auto bitmap = Gfx::Bitmap::create(Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, { layer.tw, layer.th });
                        if (bitmap.is_error())
                            continue;
                        auto fresh = bitmap.release_value();
                        __builtin_memset(fresh->scanline_u8(0), index == 0 ? in.fill : 0, fresh->size_in_bytes());
                        layer.tiles.set(key, Tile { move(fresh), {} });
                        it = layer.tiles.find(key);
                        dirty = tile_rect;
                    } else if (all && content_changed) {
                        dirty = tile_rect;
                    } else if (local_damage.has_value()) {
                        dirty = tile_rect.intersected(*local_damage);
                    }
                    if (all && !dirty.is_empty())
                        dirty = tile_rect;
                    // Only what the layer needs (a tile can reach past the layer's region; that part stays clear until
                    // it is needed: then the tile's rastered part grows to cover it).
                    auto& tile_state = it->value;
                    auto wanted = tile_rect.intersected(needed);
                    dirty = dirty.intersected(needed);
                    if (!wanted.is_empty() && !tile_state.valid.contains(wanted)) {
                        dirty = united(dirty, tile_state.valid.is_empty() ? wanted : wanted.united(tile_state.valid));
                        dirty = dirty.intersected(tile_rect);
                    }
                    if (!dirty.is_empty())
                        tile_state.valid = united(tile_state.valid, dirty).intersected(tile_rect);
                    if (dirty.is_empty()) {
                        pixels_kept += static_cast<u64>(layer.tw) * layer.th;
                        continue;
                    }
                    // Raster `dirty` (layer space) into the tile.
                    auto& bitmap = *it->value.bitmap;
                    Gfx::IntRect in_tile = dirty.translated(-tile_rect.x(), -tile_rect.y());
                    if (fast_canvas.has_value()) {
                        auto t_copy = MonotonicTime::now();
                        DirtyTile out;
                        out.layer = layer.id;
                        out.tile_x = i;
                        out.tile_y = j;
                        out.rect = in_tile;
                        out.rgba.resize(static_cast<size_t>(in_tile.width()) * in_tile.height() * 4);
                        __builtin_memset(out.rgba.data(), 0, out.rgba.size());
                        auto const& f = *fast_canvas;
                        auto part = dirty.intersected(f.dst);
                        for (int y = part.y(); y < part.bottom(); ++y) {
                            auto const* source = static_cast<u8 const*>(f.pixmap.addr(part.x() - f.dst.x(), y - f.dst.y()));
                            auto* target = out.rgba.data() + (static_cast<size_t>(y - dirty.y()) * dirty.width() + (part.x() - dirty.x())) * 4;
                            for (int x = 0; x < part.width(); ++x, source += 4, target += 4) {
                                u8 r = f.bgra ? source[2] : source[0], g = source[1], b = f.bgra ? source[0] : source[2], a = source[3];
                                if (a == 255) {
                                    target[0] = r, target[1] = g, target[2] = b, target[3] = in.alpha;
                                } else if (a != 0) {
                                    target[0] = static_cast<u8>(min(255u, (r * 255u + a / 2) / a));
                                    target[1] = static_cast<u8>(min(255u, (g * 255u + a / 2) / a));
                                    target[2] = static_cast<u8>(min(255u, (b * 255u + a / 2) / a));
                                    target[3] = static_cast<u8>((a * in.alpha + 127) / 255);
                                }
                            }
                        }
                        s_stats.convert_ms += (MonotonicTime::now() - t_copy).to_nanoseconds() / 1e6;
                        ++s_stats.tiles_rastered;
                        if (layer.kind == Kind::Scroll && !visible_for_stats.is_empty() && dirty.intersects(visible_for_stats))
                            ++s_stats.tiles_rastered_visible;
                        s_stats.bytes += out.rgba.size();
                        s_stats.tile_pixels += static_cast<u64>(in_tile.width()) * in_tile.height();
                        auto on_screen = enclosing(layer.m.map(dirty.to_type<float>()));
                        if (layer.kind == Kind::Scroll)
                            on_screen = on_screen.intersected(layer.scrollport);
                        viewport_damage = united(viewport_damage, on_screen.intersected(frame));
                        s_dirty.append(move(out));
                        continue;
                    }
                    bool base = index == 0;
                    for (int y = in_tile.y(); y < in_tile.bottom(); ++y)
                        __builtin_memset(bitmap.scanline_u8(y) + static_cast<size_t>(in_tile.x()) * 4, base ? in.fill : 0, static_cast<size_t>(in_tile.width()) * 4);
                    auto surface = Gfx::PaintingSurface::wrap_bitmap(bitmap);
                    auto& canvas = surface->canvas();
                    canvas.save();
                    canvas.clipRect(SkRect::MakeXYWH(in_tile.x(), in_tile.y(), in_tile.width(), in_tile.height()));
                    auto scroll = in.scroll;
                    if (layer.kind == Kind::Scroll && !backdrop_flat) {
                        // Put the tile at the scrollport's corner: the scroll node's offset that does it.
                        int inset = static_cast<int>(ceil(layer.clip_radius));
                        auto port = layer.scrollport.shrunken(2 * inset, 2 * inset);
                        auto here = layer.m.map(tile_rect.to_type<float>());
                        auto shift = Gfx::FloatPoint { static_cast<float>(port.x()) - here.x(), static_cast<float>(port.y()) - here.y() };
                        scroll.set_device_offset_for_index(SpatialNodeIndex { span.key }, layer.scroll_offset + shift);
                        resolve_sticky_offsets(tree, scroll);
                        canvas.translate(-port.x(), -port.y());
                    } else {
                        canvas.translate(-tile_rect.x(), -tile_rect.y());
                        auto const& v = inverse;
                        SkMatrix sk;
                        sk.setAll(v.a, v.c, v.e, v.b, v.d, v.f, 0, 0, 1);
                        canvas.concat(sk);
                    }
                    if (backdrop_flat)
                        in.player.set_replay_range(Compositor::DisplayListPlayer::ReplayRange { 0, 0, span.end_run, span.end_command });
                    else
                        in.player.set_replay_range(Compositor::DisplayListPlayer::ReplayRange { span.begin_run, span.begin_command, span.end_run, span.end_command });
                    in.player.set_skip_backdrop_filters(host_backdrop);
                    in.player.execute(list, tree, in.resources, in.raster_cache, scroll, surface, in.canvases, in.children);
                    in.player.set_skip_backdrop_filters(false);
                    canvas.restore();
                    in.player.flush(*surface);
                    ++s_stats.tiles_rastered;
                    if (layer.kind == Kind::Scroll && !visible_for_stats.is_empty() && dirty.intersects(visible_for_stats))
                        ++s_stats.tiles_rastered_visible;
                    // Out as RGBA, not premultiplied (ImageData); the alpha scaled by the frame alpha mark.
                    auto t_convert = MonotonicTime::now();
                    DirtyTile out;
                    out.layer = layer.id;
                    out.tile_x = i;
                    out.tile_y = j;
                    out.rect = in_tile;
                    out.rgba.resize(static_cast<size_t>(in_tile.width()) * in_tile.height() * 4);
                    auto* target = out.rgba.data();
                    u32 const alpha_bits = static_cast<u32>(in.alpha) << 24;
                    for (int y = in_tile.y(); y < in_tile.bottom(); ++y) {
                        auto const* source = bitmap.scanline_u8(y) + static_cast<size_t>(in_tile.x()) * 4;
                        int width = in_tile.width();
                        for (int x = 0; x < width; ++x, source += 4, target += 4) {
                            // Little-endian words: BGRA in memory is 0xAARRGGBB, RGBA out is 0xAABBGGRR.
                            u32 v;
                            __builtin_memcpy(&v, source, 4);
                            u32 a = v >> 24;
                            if (a == 255) {
                                u32 out_word = (v & 0x0000ff00u) | ((v & 0xffu) << 16) | ((v >> 16) & 0xffu) | alpha_bits;
                                __builtin_memcpy(target, &out_word, 4);
                                continue;
                            }
                            if (a == 0) {
                                __builtin_memset(target, 0, 4);
                                continue;
                            }
                            target[0] = static_cast<u8>(min(255u, (source[2] * 255u + a / 2) / a));
                            target[1] = static_cast<u8>(min(255u, (source[1] * 255u + a / 2) / a));
                            target[2] = static_cast<u8>(min(255u, (source[0] * 255u + a / 2) / a));
                            target[3] = static_cast<u8>((a * in.alpha + 127) / 255);
                        }
                    }
                    s_stats.convert_ms += (MonotonicTime::now() - t_convert).to_nanoseconds() / 1e6;
                    s_stats.bytes += out.rgba.size();
                    s_stats.tile_pixels += static_cast<u64>(in_tile.width()) * in_tile.height();
                    // What changed on screen (for backdrop layers above).
                    auto on_screen = enclosing(layer.m.map(dirty.to_type<float>()));
                    if (layer.kind == Kind::Scroll)
                        on_screen = on_screen.intersected(layer.scrollport);
                    viewport_damage = united(viewport_damage, on_screen.intersected(frame));
                    s_dirty.append(move(out));
                }
            }
        }
        if (content_changed && !all && local_damage.has_value() && layer.kind != Kind::Scroll)
            viewport_damage = united(viewport_damage, enclosing(layer.m.map(local_damage->to_type<float>())).intersected(frame));
        // A moved layer changes what is behind the layers above it.
        if (!layer.fresh && !(layer.m == layer.raster_m))
            viewport_damage = united(viewport_damage, enclosing(layer.m.map(layer.region.to_type<float>())).intersected(frame));
        layer.hash = hash;
        layer.bytes_hash = bytes_hash;
        layer.raster_ms = (MonotonicTime::now() - t_layer).to_nanoseconds() / 1e6;
        layer.fresh = false;
        layer.raster_m = layer.m;
        s_stats.tiles += layer.tiles.size();
    }
    (void)pixels_kept;
    // Layers no longer present are gone.
    Vector<u64> gone;
    for (auto& [identity, layer] : s_layers)
        if (!layer->seen)
            gone.append(identity);
    for (auto identity : gone)
        s_layers.remove(identity);
    s_stats.layers = s_order.size();
    s_stats.raster_ms = (MonotonicTime::now() - t0).to_nanoseconds() / 1e6 - s_stats.split_ms;

    // 6. The frame message.
    StringBuilder json;
    json.appendff("{{\"w\":{},\"h\":{},\"fill\":{},\"flat\":{},", frame.width(), frame.height(), in.fill, s_stats.flattened);
    // The boxes of videos and same-site frames when one changed (the scroll trace: what media damage costs).
    if (in.media_changed) {
        json.append("\"media\":["sv);
        for (size_t k = 0; k < scan.media.size() && k < 64; ++k) {
            auto sp = runs[scan.media[k].run].context.spatial.value();
            auto r = enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { sp < spatial_count ? sp : 0 }, scan.media_rects[k].to_type<float>(), in.scroll));
            json.appendff("{}[{},{},{},{}]", k ? "," : "", r.x(), r.y(), r.width(), r.height());
        }
        json.append("],"sv);
    }
    json.append("\"layers\":["sv);
    bool first = true;
    for (auto* layer_ptr : s_order) {
        auto& layer = *layer_ptr;
        if (!first)
            json.append(',');
        first = false;
        char const* kind = layer.kind == Kind::Root ? "root" : layer.kind == Kind::Scroll ? "scroll" : layer.kind == Kind::Sticky ? "sticky" : "transform";
        u32 flag_kind = layer.flag & 0xf0000000;
        if (flag_kind == SpanCanvas)
            kind = layer.kind == Kind::Root ? "canvas" : kind;
        if (flag_kind == SpanBackdrop)
            kind = "backdrop";
        auto const& m = layer.m;
        json.appendff("{{\"id\":{},\"kind\":\"{}\",\"node\":{},\"m\":[{},{},{},{},{},{}],\"tw\":{},\"th\":{},\"ms\":{:.3},\"why\":{}", layer.id, kind, layer.key, m.a, m.b, m.c, m.d, m.e, m.f, layer.tw, layer.th, layer.raster_ms, layer.why);
        if (!layer.clip.is_empty())
            json.appendff(",\"clip\":[{},{},{},{}]", layer.clip.x(), layer.clip.y(), layer.clip.width(), layer.clip.height());
        if (layer.why)
            json.appendff(",\"dmg\":[{},{},{},{},{},{},{},{}]", layer.last_damage[0].x(), layer.last_damage[0].y(), layer.last_damage[0].width(), layer.last_damage[0].height(),
                layer.last_damage[1].x(), layer.last_damage[1].y(), layer.last_damage[1].width(), layer.last_damage[1].height());
        if (layer.kind == Kind::Scroll) {
            json.appendff(",\"offset\":[{},{}]", layer.scroll_offset.x(), layer.scroll_offset.y());
            if (!layer.extent.is_empty())
                json.appendff(",\"ext\":[{},{},{},{}]", layer.extent.x(), layer.extent.y(), layer.extent.width(), layer.extent.height());
            if (layer.clip_radius > 0)
                json.appendff(",\"rr\":{}", layer.clip_radius);
        }
        if (flag_kind == SpanCanvas)
            json.append(",\"canvas\":true"sv);
        // The scroll nodes the layer moves with (its own and every scroll ancestor), for the carapace's threaded scroll;
        // a sticky layer's constraints (device px, as LibWeb's resolve_sticky_offsets reads them).
        json.append(",\"chain\":["sv);
        {
            bool first_link = true;
            for (u32 n = layer.key, guard = 0; n != 0 && n < spatial_count && guard < spatial_count; n = spatial[n].parent, ++guard) {
                if (spatial[n].kind != 1)
                    continue;
                json.appendff("{}{}", first_link ? "" : ",", n);
                first_link = false;
            }
        }
        json.append("]"sv);
        if (layer.kind == Kind::Sticky && layer.key < spatial_count) {
            auto const& st = spatial[layer.key];
            auto entry = in.scroll.device_offset_for_index(SpatialNodeIndex { layer.key });
            auto inset = [](float v) -> ByteString { return isnan(v) ? ByteString("null"sv) : ByteString::formatted("{}", v); };
            json.appendff(",\"sticky\":[{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}]", st.sticky_scroller, st.sticky_parent,
                st.sticky_position_relative_to_scroller.x(), st.sticky_position_relative_to_scroller.y(), st.sticky_border_box_size.width(), st.sticky_border_box_size.height(),
                st.sticky_scrollport_size.width(), st.sticky_scrollport_size.height(), st.sticky_containing_block_region.x(), st.sticky_containing_block_region.y(),
                st.sticky_containing_block_region.width(), st.sticky_containing_block_region.height(),
                inset(st.sticky_insets[0]), inset(st.sticky_insets[1]), inset(st.sticky_insets[2]), inset(st.sticky_insets[3]), entry.x(), entry.y());
        }
        if (flag_kind == SpanHostBackdrop)
            json.appendff(",\"backdrop\":{{\"region\":[{},{},{},{}],\"radius\":{},\"blur\":{},\"saturate\":{}}}", layer.backdrop_region.x(), layer.backdrop_region.y(), layer.backdrop_region.width(), layer.backdrop_region.height(), layer.corner_radius, layer.blur, layer.saturate);
        json.append(",\"tiles\":["sv);
        bool first_tile = true;
        for (auto& [key, tile] : layer.tiles) {
            json.appendff("{}[{},{}]", first_tile ? "" : ",", unpack_i(key), unpack_j(key));
            first_tile = false;
        }
        json.append("]}"sv);
    }
    json.append("]"sv);
    // Threaded scroll (docs/compositor.md "Threaded scroll"): the scroll nodes with their offset range (device px,
    // scroll offset = -device offset), what wheels hit (in paint order), and where wheels must stay on the main thread
    // (non-passive wheel listeners, nested documents, snap containers). `hseq`: the last carapace scroll applied.
    {
        auto async = async_scrolling_state_from_display_list(list);
        auto viewport_rect = [&](ContextRef context, Gfx::FloatRect rect) {
            auto s = context.spatial.value();
            return enclosing(tree.transform_rect_to_viewport(SpatialNodeIndex { s < spatial_count ? s : 0 }, rect, in.scroll));
        };
        json.append(",\"scroll\":{\"nodes\":["sv);
        bool first_node = true;
        for (auto const& node : async.scroll_nodes) {
            u32 index = node.node_id.scroll_node_index.value();
            bool snaps = any_of(async.snap_containers, [&](auto const& c) { return c.node_id.scroll_node_index.value() == index; });
            u32 parent = node.parent_node_id.has_value() ? node.parent_node_id->scroll_node_index.value() : 0;
            auto offset = in.scroll.device_offset_for_index(node.node_id.scroll_node_index);
            auto port = scrollports.get(index).value_or(frame);
            json.appendff("{}[{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}]", first_node ? "" : ",", index, parent, port.x(), port.y(), port.width(), port.height(),
                node.min_scroll_offset.x(), node.min_scroll_offset.y(), node.max_scroll_offset.x(), node.max_scroll_offset.y(),
                -offset.x(), -offset.y(), node.can_be_wheel_scrolled_horizontally ? 1 : 0, node.can_be_wheel_scrolled_vertically ? 1 : 0,
                (node.is_viewport ? 1 : 0) | (snaps ? 2 : 0) | (promoted.size() > index && promoted[index] ? 4 : 0), s_host_seq.get(index).value_or(0));
            first_node = false;
        }
        json.append("],\"targets\":["sv);
        bool first_target = true;
        for (auto const& target : async.wheel_hit_test_targets) {
            auto r = viewport_rect(target.context, target.rect);
            json.appendff("{}[{},{},{},{},{}]", first_target ? "" : ",", r.x(), r.y(), r.width(), r.height(), target.target_node_id.has_value() ? target.target_node_id->scroll_node_index.value() : 0);
            first_target = false;
        }
        json.append("],\"blocking\":["sv);
        bool first_block = true;
        for (auto const& region : async.blocking_wheel_event_regions) {
            auto r = viewport_rect(region.context, region.rect);
            json.appendff("{}[{},{},{},{}]", first_block ? "" : ",", r.x(), r.y(), r.width(), r.height());
            first_block = false;
        }
        for (auto const& region : async.main_thread_wheel_event_regions) {
            auto r = viewport_rect(region.context, region.rect);
            json.appendff("{}[{},{},{},{}]", first_block ? "" : ",", r.x(), r.y(), r.width(), r.height());
            first_block = false;
        }
        bool covering = async.has_blocking_wheel_event_region_covering_viewport;
        if (auto const& metadata = list.async_scrolling_metadata(); metadata.has_value())
            covering = covering || metadata->has_blocking_wheel_event_region_covering_viewport;
        json.appendff("],\"blockAll\":{}}}", covering);
    }
    json.append(",\"dirty\":["sv);
    for (size_t i = 0; i < s_dirty.size(); ++i) {
        auto const& d = s_dirty[i];
        json.appendff("{}[{},{},{},{},{},{},{}]", i ? "," : "", d.layer, d.tile_x, d.tile_y, d.rect.x(), d.rect.y(), d.rect.width(), d.rect.height());
    }
    json.append("]}"sv);
    s_json = MUST(ByteBuffer::copy(json.string_view().bytes()));
    return true;
}

}
