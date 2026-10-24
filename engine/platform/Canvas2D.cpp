// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// See Canvas2D.h. The replay mirrors Ladybird's Services/Compositor/CanvasHost.cpp (BSD-2-Clause) minus WebGL
// and the process boundary.

#include "Canvas2D.h"
#include <AK/HashMap.h>
#include <Compositor/DisplayListRasterCache.h>
#include <LibCompositing/DisplayList/Canvas2DCommandStream.h>
#include <LibCompositing/DisplayList/DisplayList.h>
#include <LibCompositing/DisplayList/DisplayListResourceStorage.h>
#include <LibGfx/Bitmap.h>
#include <LibGfx/CanvasCommandPlayer.h>
#include <LibGfx/PaintingSurface.h>
#include <LibWeb/HTML/Canvas/RemoteCanvas2DTransport.h>
#include <core/SkTextBlob.h>

namespace Ganglion {

namespace {

struct Context {
    NonnullOwnPtr<Gfx::CanvasCommandPlayer> player;
    NonnullRefPtr<Gfx::PaintingSurface> presented;
    bool uncommitted { false };
};

struct State {
    Compositing::CanvasSurfaceRegistry registry;
    HashMap<Compositing::CanvasId, Context> contexts;
    NonnullRefPtr<Compositing::Canvas2DCommandStream> stream { adopt_ref(*new Compositing::Canvas2DCommandStream) };
    Compositing::DisplayListResourceStorage text_resources;
    Compositor::DisplayListRasterCache text_blobs;
};

State& state()
{
    static State* s = new State; // lives as long as the module
    return *s;
}

OwnPtr<Gfx::CanvasCommandPlayer> make_player(State& s, Gfx::IntSize size, bool alpha)
{
    if (size.is_empty() || static_cast<i64>(size.width()) * static_cast<i64>(size.height()) > Gfx::max_canvas_area)
        return nullptr;
    auto format = alpha ? Gfx::BitmapFormat::BGRA8888 : Gfx::BitmapFormat::BGRx8888;
    // A 2D source resolves to its live draw surface: the shared stream replays in recording order.
    auto surface_resolver = [&s](u64 id) -> Gfx::PaintingSurface const* {
        auto it = s.contexts.find(Compositing::CanvasId { id });
        if (it == s.contexts.end())
            return s.registry.canvas_surface(Compositing::CanvasId { id }); // a WebGL canvas: its presented surface
        return it->value.player->surface().ptr();
    };
    auto blob_resolver = [&s](u64 font_id, ReadonlySpan<Gfx::CanvasGlyph> glyphs) {
        if (!s.text_resources.has_font(Compositing::FontResourceId { font_id }))
            return sk_sp<SkTextBlob> {};
        Vector<Compositing::DisplayListGlyph> list;
        list.ensure_capacity(glyphs.size());
        for (auto const& glyph : glyphs)
            list.unchecked_append({ .position = glyph.position, .glyph_id = glyph.glyph_id });
        return s.text_blobs.text_blob(s.text_resources, Compositing::FontResourceId { font_id }, 1, list, 0, Compositor::TextRasterizationMode::Unhinted);
    };
    auto player = make<Gfx::CanvasCommandPlayer>(RefPtr<Gfx::SkiaBackendContext> {}, size, format, Gfx::AlphaType::Premultiplied, move(surface_resolver), move(blob_resolver));
    // "the bitmap of such a context starts off as opaque black instead of transparent black"
    if (!alpha)
        player->clear(Gfx::Color::Black);
    return player;
}

void present(State& s, Compositing::CanvasId id, Context& context)
{
    context.presented->copy_from_surface(*context.player->surface());
    s.registry.set_canvas_surface(id, context.presented);
    context.uncommitted = false;
}

void flush(State& s)
{
    if (s.stream->is_empty())
        return;
    auto fonts = s.stream->take_fonts();
    auto segments = s.stream->take_segments();
    Compositing::DisplayListResourceSet resources;
    for (auto const& font : fonts) {
        if (!s.text_resources.has_font(font.id))
            s.text_resources.set_font(font.id, font.font);
        resources.fonts.set(font.id);
    }
    s.text_blobs.evict(s.text_resources.retain_only(resources));
    for (auto const& segment : segments) {
        auto it = s.contexts.find(segment.canvas_id);
        if (it == s.contexts.end())
            continue; // destroyed while its commands were pending
        auto& context = it->value;
        if (!segment.commands.is_empty()) {
            context.player->play(segment.commands);
            context.uncommitted = true;
        }
        if (segment.present && context.uncommitted)
            present(s, segment.canvas_id, context);
    }
}

class Transport final : public Web::HTML::RemoteCanvas2DTransport {
public:
    ~Transport() override { destroy_context(); }

    bool create_context(Gfx::IntSize size, bool alpha) override
    {
        auto& s = state();
        auto player = make_player(s, size, alpha);
        if (!player)
            return false;
        auto presented = Gfx::PaintingSurface::create_with_size(size, Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, {});
        presented->copy_from_surface(*player->surface());
        auto id = s.registry.create_canvas_surface(presented);
        s.contexts.set(id, Context { player.release_nonnull(), move(presented) });
        m_id = id;
        return true;
    }

    Optional<Compositing::CanvasId> canvas_id() const override { return m_id; }

    void destroy_context() override
    {
        if (!m_id.has_value())
            return;
        auto& s = state();
        s.contexts.remove(*m_id);
        s.registry.remove_canvas_surface(*m_id);
        m_id.clear();
    }

    Compositing::Canvas2DCommandStream& shared_stream() override { return *state().stream; }
    void flush_shared_stream() override { flush(state()); }

    RefPtr<Gfx::Bitmap> read_back_pixels(Gfx::IntRect const& rect, Gfx::AlphaType alpha_type) override
    {
        if (!m_id.has_value())
            return nullptr;
        auto& s = state();
        auto it = s.contexts.find(*m_id);
        if (it == s.contexts.end())
            return nullptr;
        auto surface = it->value.player->surface();
        auto clipped = rect.intersected(surface->rect());
        if (clipped.is_empty())
            return nullptr;
        // Unpremultiplied pixels are for ImageData, which stores them as RGBA8888; the surface converts.
        auto format = alpha_type == Gfx::AlphaType::Unpremultiplied ? Gfx::BitmapFormat::RGBA8888 : Gfx::BitmapFormat::BGRA8888;
        auto bitmap = Gfx::Bitmap::create(format, alpha_type, clipped.size());
        if (bitmap.is_error())
            return nullptr;
        surface->flush();
        surface->read_into_bitmap(*bitmap.value(), clipped.location());
        return bitmap.release_value();
    }

private:
    Optional<Compositing::CanvasId> m_id;
};

}

void install_canvas_2d()
{
    Web::HTML::RemoteCanvas2DTransport::local_factory() = [] { return RefPtr<Web::HTML::RemoteCanvas2DTransport> { adopt_ref(*new Transport) }; };
}

void flush_canvas_2d()
{
    flush(state());
}

bool canvas_2d_pending()
{
    return !state().stream->is_empty();
}

Compositing::CanvasSurfaceRegistry const& canvas_surfaces()
{
    return state().registry;
}

Compositing::CanvasSurfaceRegistry& mutable_canvas_surfaces()
{
    return state().registry;
}

}
