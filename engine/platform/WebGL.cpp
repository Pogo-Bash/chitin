// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// See WebGL.h. Two halves: OpenGLContext for wasm (Ladybird's Services/Compositor/OpenGLContext.cpp is EGL and
// ANGLE; here a context is a handle to a host WebGL context the glue made), and the transport, which mirrors
// Ladybird's CanvasHost (BSD-2-Clause) WebGL methods minus the process boundary.

#include "WebGL.h"
#include "Canvas2D.h"
#include <AK/HashMap.h>
#include <AK/String.h>
#include <Compositor/HostWebGLContext.h>
#include <Compositor/OpenGLContext.h>
#include <LibGfx/Bitmap.h>
#include <LibGfx/PaintingSurface.h>
#include <LibWeb/WebGL/RemoteWebGLTransport.h>
#include <stdlib.h>

#define GANGLION_EXPORT extern "C" __attribute__((used, visibility("default")))

// The host side (glue/engine/58-webgl.js). A handle names one host context; 0 is none.
extern "C" {
int ganglion_host_webgl_create(int version, int depth, int stencil, int antialias, int width, int height, int alpha, int premultiplied_alpha);
void ganglion_host_webgl_destroy(int handle);
void ganglion_host_webgl_make_current(int handle);
void ganglion_host_webgl_resize(int handle, int width, int height);
void ganglion_host_webgl_clear_default(int handle);
// The host's WebGL extension names, '\n'-separated, into a buffer the engine frees (ganglion_free).
char* ganglion_host_webgl_extensions(int handle);
// The default framebuffer as BGRA premultiplied, top row first, into `pixels` (`pitch` bytes per row).
void ganglion_host_webgl_read_frame(int handle, unsigned char* pixels, int pitch, int width, int height);
}

namespace Ganglion {
static int s_last_created_handle = 0;
}

namespace Compositor {

struct OpenGLContext::Impl {
    AK_ALLOC_WITH_KMALLOC;

    int handle { 0 };
    RefPtr<Gfx::Bitmap> frame;
};

OwnPtr<OpenGLContext> OpenGLContext::create(RefPtr<Gfx::SkiaBackendContext> skia_backend_context, WebGLVersion version, DrawingBufferOptions options)
{
    // The size comes with set_size(); the host canvas starts at 1x1.
    int handle = ganglion_host_webgl_create(version == WebGLVersion::WebGL2 ? 2 : 1, options.depth, options.stencil, options.antialias, 1, 1, options.alpha, options.premultiplied_alpha);
    if (!handle)
        return {};
    Ganglion::s_last_created_handle = handle;
    return make<OpenGLContext>(move(skia_backend_context), Impl { .handle = handle, .frame = nullptr }, version, options);
}

OpenGLContext::OpenGLContext(RefPtr<Gfx::SkiaBackendContext> skia_backend_context, Impl impl, WebGLVersion version, DrawingBufferOptions options)
    : m_skia_backend_context(move(skia_backend_context))
    , m_impl(make<Impl>(move(impl)))
    , m_webgl_version(version)
    , m_drawing_buffer_options(options)
{
}

OpenGLContext::~OpenGLContext()
{
    ganglion_host_webgl_destroy(m_impl->handle);
}

void OpenGLContext::make_current()
{
    ganglion_host_webgl_make_current(m_impl->handle);
}

void OpenGLContext::notify_content_will_change()
{
    if (m_painting_surface)
        m_painting_surface->notify_content_will_change();
}

void OpenGLContext::clear_buffer_to_default_values()
{
    ganglion_host_webgl_clear_default(m_impl->handle);
}

void OpenGLContext::allocate_painting_surface_if_needed()
{
    if (m_painting_surface || m_size.is_empty())
        return;
    auto bitmap = Gfx::Bitmap::create(Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, m_size);
    if (bitmap.is_error())
        return;
    m_impl->frame = bitmap.release_value();
    m_painting_surface = Gfx::PaintingSurface::create_with_size(m_size, Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, {});
}

void OpenGLContext::present()
{
    allocate_painting_surface_if_needed();
    if (!m_impl->frame)
        return;
    auto& frame = *m_impl->frame;
    ganglion_host_webgl_read_frame(m_impl->handle, frame.scanline_u8(0), static_cast<int>(frame.pitch()), frame.width(), frame.height());
    m_painting_surface->notify_content_will_change();
    m_painting_surface->write_from_bitmap(frame);
}

void OpenGLContext::set_size(Gfx::IntSize const& size)
{
    if (size == m_size)
        return;
    m_size = size;
    ganglion_host_webgl_resize(m_impl->handle, size.width(), size.height());
    m_painting_surface = nullptr;
    m_impl->frame = nullptr;
}

RefPtr<Gfx::PaintingSurface> OpenGLContext::surface()
{
    allocate_painting_surface_if_needed();
    return m_painting_surface;
}

u32 OpenGLContext::default_framebuffer() const
{
    return 0;
}

u32 OpenGLContext::default_renderbuffer() const
{
    return 0;
}

Vector<String> OpenGLContext::get_supported_opengl_extensions()
{
    Vector<String> names;
    auto* list = ganglion_host_webgl_extensions(m_impl->handle);
    if (!list)
        return names;
    for (auto name : StringView { list, __builtin_strlen(list) }.split_view('\n'))
        names.append(MUST(String::from_utf8(name)));
    free(list);
    return names;
}

}

namespace Ganglion {

namespace {

using namespace Compositing::WebGL;

class Transport;
HashMap<int, Transport*>& transports_by_handle()
{
    static auto* map = new HashMap<int, Transport*>;
    return *map;
}

class Transport final : public Web::WebGL::RemoteWebGLTransport {
public:
    ~Transport() override { destroy_context(); }

    CreateResult create_context(WebGLVersion version, Gfx::IntSize size, bool depth, bool stencil, bool antialias, bool alpha, bool premultiplied_alpha) override
    {
        VERIFY(!m_context);
        CreateResult result;
        m_context = Compositor::HostWebGLContext::create(nullptr, version, { .depth = depth, .stencil = stencil, .antialias = antialias, .alpha = alpha, .premultiplied_alpha = premultiplied_alpha }, size);
        if (!m_context)
            return result;
        m_handle = s_last_created_handle;
        transports_by_handle().set(m_handle, this);
        m_id = mutable_canvas_surfaces().allocate_canvas_id();
        result.success = true;
        // The host is a WebGL implementation: its extension names are WebGL names (LibWeb's host list).
        result.webgl_extensions = m_context->gl_context().get_supported_opengl_extensions();
        return result;
    }

    Optional<Compositing::CanvasId> canvas_id() const override { return m_id; }

    void destroy_context() override
    {
        if (m_id.has_value())
            mutable_canvas_surfaces().remove_canvas_surface(*m_id);
        m_id.clear();
        m_context = nullptr;
        if (m_handle)
            transports_by_handle().remove(m_handle);
        m_handle = 0;
    }

    void set_shared_command_buffer(Core::AnonymousBuffer const& buffer) override
    {
        if (!m_context)
            return;
        if (auto shared = WebGLSharedCommandBuffer::adopt_received_buffer(buffer); shared.has_value())
            m_context->set_shared_command_buffer(shared.release_value());
    }

    void send_commands_from_shared_buffer(u64 offset, u64 size_in_bytes, u64 flush_sequence_number, Vector<Gfx::DecodedImageFrame> const& bitmaps) override
    {
        if (!m_context)
            return;
        auto commands = m_context->shared_command_buffer_range(offset, size_in_bytes);
        if (!commands.has_value() || m_context->execute_commands(*commands, bitmaps).is_error()) {
            lose();
            return;
        }
        m_context->store_executed_flush_sequence_number(flush_sequence_number);
    }

    // Commands run as they are sent, so everything published has executed.
    bool wait_until_published_commands_executed() override { return m_context != nullptr; }

    void send_commands(ByteBuffer const& commands, Vector<Gfx::DecodedImageFrame> const& bitmaps) override
    {
        if (!m_context)
            return;
        if (m_context->execute_commands(commands.bytes(), bitmaps).is_error())
            lose();
    }

    void present_canvas(bool preserve_drawing_buffer) override
    {
        if (!m_context || !m_id.has_value())
            return;
        auto surface = m_context->prepare_for_compositing(preserve_drawing_buffer);
        if (surface.is_error())
            return;
        mutable_canvas_surfaces().set_canvas_surface(*m_id, surface.release_value());
    }

    void clear_drawing_buffer() override
    {
        if (m_context)
            m_context->clear_drawing_buffer();
    }

    ByteBuffer sync_call(ByteBuffer request) override
    {
        if (!m_context)
            return {};
        auto reply = m_context->execute_sync_call(request);
        if (reply.is_error())
            return {};
        return reply.release_value();
    }

    ReadPixelsResult read_pixels_robust_angle(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, GLsizei buf_size, Core::AnonymousBuffer pixels) override
    {
        if (!m_context)
            return {};
        return m_context->read_pixels_robust_angle(x, y, width, height, format, type, buf_size, move(pixels));
    }

    bool read_buffer_sub_data(GLenum target, Compositing::WebGL::GLintptr offset, Compositing::WebGL::GLintptr size, Core::AnonymousBuffer data) override
    {
        if (!m_context)
            return false;
        return m_context->read_buffer_sub_data(target, offset, size, move(data));
    }

    Gfx::ShareableBitmap read_back_drawing_buffer(Gfx::IntRect const& rect) override
    {
        if (!m_context)
            return {};
        return m_context->read_back_drawing_buffer(rect);
    }

    // The host context was lost or restored (its webglcontextlost / webglcontextrestored events).
    void host_loss_change(bool restored)
    {
        if (on_context_loss_change)
            on_context_loss_change(restored);
    }

private:
    // A malformed stream is the engine's own bug, not a peer's; the context is lost rather than the page.
    void lose()
    {
        dbgln("WebGL: command stream rejected; context lost");
        destroy_context();
        if (on_context_loss_change)
            on_context_loss_change(false);
    }

    OwnPtr<Compositor::HostWebGLContext> m_context;
    Optional<Compositing::CanvasId> m_id;
    int m_handle { 0 };
};

}

// From the glue, outside of any WebGL call: the host context `handle` was lost (0) or restored (1).
GANGLION_EXPORT void ganglion_webgl_context_event(int handle, int restored)
{
    auto transport = transports_by_handle().get(handle);
    if (!transport.has_value())
        return;
    // A restored host context is not this transport's any more: the page's context is re-created.
    (*transport)->host_loss_change(restored != 0);
}

void install_webgl()
{
    Web::WebGL::RemoteWebGLTransport::local_factory() = [] { return RefPtr<Web::WebGL::RemoteWebGLTransport> { adopt_ref(*new Transport) }; };
}

}
