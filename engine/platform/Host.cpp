// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The segment host of Ganglion: what the Worker's glue calls (ganglion_* exports) and what the engine asks
// of the host (ganglion_host_* imports). One page, one top-level traversable, documents parsed from the
// bytes the host fetched; subresources through the embedder network loader; images decoded by the host;
// frames rasterized on the CPU with Skia into a bitmap the host copies out (docs/phase1.md).

#include "Bridge.h"
#include "Canvas2D.h"
#include "WebGL.h"
#include "Fonts.h"
#include "Layers.h"
#include "Media.h"
#include "EventLoop.h"
#include "Network.h"
#include <AK/Format.h>
#include <AK/Time.h>
#include <AK/StringBuilder.h>
#include <Compositor/DisplayListPlayerSkia.h>
#include <core/SkCanvas.h>
#include <core/SkPaint.h>
#include <core/SkTextBlob.h>
#include <Compositor/DisplayListRasterCache.h>
#include <LibCompositing/DisplayList/CompositedContext.h>
#include <LibCompositing/DisplayList/DisplayListDamage.h>
#include <LibCompositing/RustFFI.h>
#include <LibCompositing/DisplayList/AccumulatedVisualContext.h>
#include <LibCompositing/DisplayList/DisplayListResourceStorage.h>
#include <LibCompositing/Scrolling/AsyncScrollingState.h>
#include <LibWeb/Painting/Scrolling.h>
#include <LibCore/AnonymousBuffer.h>
#include <LibCore/EventLoop.h>
#include <LibCore/ThreadEventQueue.h>
#include <LibGC/Heap.h>
#include <LibGfx/Bitmap.h>
#include <LibGfx/Font/FontDatabase.h>
#include <LibGfx/Font/SystemFallbackFonts.h>
#include <LibGfx/Font/PathFontProvider.h>
#include <LibGfx/Font/Typeface.h>
#include <LibGfx/TextLayout.h>
#include <LibGfx/Font/Font.h>
#include <harfbuzz/hb.h>
#include <harfbuzz/hb-ot.h>
#include <LibGfx/PaintingSurface.h>
#include <LibGfx/Palette.h>
#include <LibGfx/SystemTheme.h>
#include <LibHTTP/Cookie/Cookie.h>
#include <LibHTTP/Cookie/ParsedCookie.h>
#include <LibHTTP/HeaderList.h>
#include <LibWeb/HTML/PolicyContainers.h>
#include <LibWeb/HTML/Scripting/WindowEnvironmentSettingsObject.h>
#include <LibWeb/SecureContexts/AbstractOperations.h>
#include <LibWebCommon/HTML/CrossOrigin/OpenerPolicy.h>
#include <LibURL/URL.h>
#include <LibJS/Runtime/Realm.h>
#include <LibJS/Runtime/VM.h>
#include <LibURL/Parser.h>
#include <LibWeb/HTML/Scripting/SimilarOriginWindowAgent.h>
#include <LibWeb/Bindings/MainThreadVM.h>
#include <LibWeb/Gamepad/GamepadRegistry.h>
#include <LibWebCommon/Gamepad/GamepadSharedState.h>
#include <LibWebCommon/Gamepad/GamepadStateBuffer.h>
#include <LibWeb/Bindings/PrincipalHostDefined.h>
#include <LibWeb/CSS/FontComputer.h>
#include <LibWeb/DOM/Document.h>
#include <LibWeb/SVG/SVGDecodedImageData.h>
#include <LibWeb/Fetch/Infrastructure/HTTP/Requests.h>
#include <LibWeb/HTML/EventLoop/EventLoop.h>
#include <LibWeb/HTML/HTMLDocument.h>
#include <LibWeb/HTML/LocalTraversableNavigable.h>
#include <LibWeb/HTML/SessionHistoryEntry.h>
#include <LibWeb/HTML/HistoryExecutor.h>
#include <LibWeb/HTML/HTMLScriptElement.h>
#include <LibWeb/IndexedDB/Internal/Algorithms.h>
#include <LibWeb/IndexedDB/Internal/Persistence.h>
#include <LibWeb/HTML/LocalNavigable.h>
#include <LibWeb/HTML/NavigableContainer.h>
#include <LibWeb/HTML/Navigation.h>
#include <LibWebCommon/HTML/HistoryOperation.h>
#include <LibWebCommon/HTML/NavigationPopulationRequest.h>
#include <LibWeb/CSS/Screen.h>
#include <LibWeb/HTML/Navigator.h>
#include <LibWeb/HTML/NetworkInformation.h>
#include <LibWeb/HTML/Location.h>
#include <LibWeb/HTML/Window.h>
#include <LibTextCodec/Decoder.h>
#include <LibWeb/HTML/Parser/HTMLEncodingDetection.h>
#include <LibWeb/HTML/Parser/HTMLParser.h>
#include <LibWeb/HTML/Scripting/Environments.h>
#include <LibWeb/HTML/Scripting/TemporaryExecutionContext.h>
#include <LibWeb/Layout/RenderDocument.h>
#include <LibWeb/Loader/LoadRequest.h>
#include <LibWeb/Loader/ResourceLoader.h>
#include <LibWeb/UIEvents/PointerEvent.h>
#include <LibWebCommon/Loader/SiteCompatibility.h>
#include <LibWeb/Page/Page.h>
#include <LibWeb/Painting/DocumentPaintState.h>
#include <LibWeb/Painting/PaintFacts.h>
#include <LibWeb/Platform/EventLoopPlugin.h>
#include <LibWeb/HTML/AttributeNames.h>
#include <LibWeb/HTML/Navigable.h>
#include <LibWeb/Platform/FontPlugin.h>
#include <LibWeb/Platform/ImageCodecPlugin.h>
#include <LibWebCommon/MimeSniff/MimeType.h>
#include <LibWeb/Fetch/Infrastructure/FetchTimingInfo.h>
#include <LibWeb/Fetch/Infrastructure/HTTP/MIME.h>
#include <LibWeb/Fetch/Infrastructure/HTTP/Responses.h>
#include <LibWeb/HighResolutionTime/TimeOrigin.h>
#include <LibWeb/NavigationTiming/PerformanceNavigationTiming.h>
#include <stdlib.h>
#include <string.h>
#include <unicode/udata.h>
#include <unicode/utypes.h>

#define GANGLION_EXPORT extern "C" __attribute__((used, visibility("default")))

namespace Web::HTML {
// patches/ladybird/0019: defined in LibWeb/HTML/Parser/HTMLParser.cpp, declared here to keep it out of the header.
void set_speculative_parsing_enabled(bool);
}

// --- What the host provides (wasm imports) ------------------------------------------------------------

extern "C" {
void ganglion_host_log(char const* text, size_t length);
// Returns 1 when the host answers the fetch itself (the harness's stand-in for the test sites), 0 when the
// engine should fetch it over its own network.
// `request` is the rest of the request as text, one item per line: method, mode, destination, credentials ("include" or
// "omit"), "navigate" or "-", then one "name: value" line per header; `body` is the request body. Page service workers
// (docs/architecture.md) need all of it for FetchEvent.request. A host that claims a fetch may hand it back to the engine's
// own network later with ganglion_fetch_network (a service worker that did not call respondWith).
int ganglion_host_fetch(uint32_t id, char const* url, size_t url_length, char const* request, size_t request_length, uint8_t const* body, size_t body_length);
// The outcome of ganglion_net_request: status, the response's headers ("name: value" lines), the body, and an error
// message (empty on success).
void ganglion_host_net_done(uint32_t id, uint32_t status, char const* headers, size_t headers_length, uint8_t const* body, size_t body_length, char const* error, size_t error_length);
// A tunnel (ganglion_tunnel_open, a page's WebSocket): the 101 and its headers, bytes behind it, and its end (an empty error is a
// normal end of the stream; also called, without an open, when the upgrade failed).
void ganglion_host_tunnel_open(uint32_t id, uint32_t status, char const* reason, size_t reason_length, char const* headers, size_t headers_length);
void ganglion_host_tunnel_data(uint32_t id, uint8_t const* bytes, size_t length);
void ganglion_host_tunnel_close(uint32_t id, char const* error, size_t error_length);
// The outcome of ganglion_navigate: the final URL (after redirects), the status, and an error message
// (empty on success).
void ganglion_host_navigated(char const* url, size_t url_length, uint32_t status, char const* error, size_t error_length);
// Before a document's scripts run: whether it is cross-origin isolated (its window's crossOriginIsolated), so the glue offers
// SharedArrayBuffer on the page's global or not, as Chrome does.
void ganglion_host_isolation(int isolated);
void ganglion_host_decode_image(uint32_t id, uint8_t const* bytes, size_t length);
void ganglion_host_navigate(char const* url, size_t length);
void ganglion_host_title(uint16_t const* title, size_t length);
void ganglion_host_request_frame(void);
// A classic script ran: call ganglion_microtask_turn_end from a host task after the page's microtasks (HTMLScriptElement, patch 0023).
void ganglion_host_microtask_turn_end_request(void);
// localStorage changed since the host last took it (once, until it takes the data), and the data: for each entry the
// key's length and the value's length as two 16-bit halves each, low first, then the key's and the value's code units.
void ganglion_host_storage_changed(void);
void ganglion_host_storage_data(uint16_t const* data, size_t length);
// Whether a frame at `url` in the document at `document_url` is on another site: the carapace shows such a frame as a
// nested segment (docs/architecture.md), so this engine never loads it. The glue's rule for sites, one place for
// both (glue/engine/50-frames.js, harness/carapace/guard.mjs).
int ganglion_host_frame_is_remote(char const* url, size_t url_length, char const* document_url, size_t document_url_length);
// Cookies (docs/cookies.md, glue/cookies.js): the Cookie header for a request or document.cookie (context "script"), written
// into a buffer the host allocates with ganglion_alloc (*out; its length is returned; *out stays null for none), freed here;
// and Set-Cookie lines ("\n"-separated) or one document.cookie string to store.
size_t ganglion_host_cookie_get(char const* url, size_t url_length, char const* context, size_t context_length, char** out);
void ganglion_host_cookie_set(char const* url, size_t url_length, char const* context, size_t context_length, char const* lines, size_t lines_length);
// IndexedDB persistence (docs/architecture.md "IndexedDB across reloads"): a journal entry for what a committed transaction or a
// deleted database changed, which the segment appends to its origin's storage and replays at the next start.
void ganglion_host_idb_persist(unsigned char const* bytes, size_t length);
// Real-time input (docs/webrtc.md, "Fullscreen, pointer lock, gamepads"): the page asked for fullscreen (1) or to leave it (0); for
// the pointer lock (1, 2 with unadjusted movement) or to release it (0); a gamepad effect (kind 0 dual-rumble, 1 trigger-rumble,
// 2 reset) on a host gamepad. The carapace answers with ganglion_fullscreen_changed, ganglion_pointer_lock_result.
void ganglion_host_fullscreen(int enter);
void ganglion_host_pointer_lock(int kind);
void ganglion_host_gamepad_effect(uint32_t handle, int kind, int strong, int weak, int duration);
}

// --- Provenance slots (docs/provenance.md) --------------------------------------------------------------
//
// NOTICE. The 128 bytes below are Chitin's provenance marks. tools/provenance-stamp.py overwrites the 96 bytes
// after the marker in every build, with values derived from a private key and the build id, and the engine
// reads some of them for ordinary work: the alpha of a painted frame, how many rounds the event loop pump
// runs, the colour a frame starts from. They identify the work and the build, never a person or a machine,
// they carry no user data, and nothing is sent anywhere. A copy that zeroes or strips them keeps running,
// but paints transparent frames, never finishes loading pages, and starts frames black.

extern "C" {
// Layout after the 32-byte marker: [0,8) alpha pair, [8,16) pump pair, [16,24) fill pair, [24,56) tag,
// [56] build id length, [57,64) reserved, [64,96) build id (ASCII).
__attribute__((used, aligned(16))) volatile uint8_t ganglion_provenance_slots[128] = {
    'G', 'A', 'N', 'G', 'L', 'I', 'O', 'N', '/', 'P', 'R', 'O', 'V', 'E', 'N', 'A',
    'N', 'C', 'E', '/', 'S', 'L', 'O', 'T', 'S', '/', 'v', '1', 0, 0, 0, 0,
    // the unstamped defaults: alpha pair, pump pair, fill pair, then the tag and build id (zero)
    0x5a, 0xa5, 0, 0, 0, 0, 0, 0,
    0x40, 0x00, 0, 0, 0, 0, 0, 0,
    0x3c, 0xc3, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
};
}

namespace Ganglion {

static u8 const* provenance_slots() { return const_cast<u8 const*>(ganglion_provenance_slots) + 32; }
static u8 provenance_alpha() { return provenance_slots()[0] ^ provenance_slots()[1]; }
static int provenance_pump_rounds() { return static_cast<u8>(provenance_slots()[8] - provenance_slots()[9]); }
static u8 provenance_fill() { return provenance_slots()[16] ^ provenance_slots()[17]; }
static StringView provenance_build_id()
{
    auto length = provenance_slots()[56];
    if (length == 0 || length > 32)
        return "unstamped"sv;
    return StringView { reinterpret_cast<char const*>(provenance_slots()) + 64, length };
}

static void host_log(StringView text)
{
    ganglion_host_log(text.characters_without_null_termination(), text.length());
}

// --- Theme ----------------------------------------------------------------------------------------------

#include "DefaultTheme.gen.h"

static Core::AnonymousBuffer make_theme()
{
    auto buffer = MUST(Core::AnonymousBuffer::create_with_size(sizeof(Gfx::SystemTheme)));
    auto* theme = buffer.data<Gfx::SystemTheme>();
    HashMap<StringView, StringView> colors;
    bool in_colors = false;
    for (auto line : StringView { default_theme_ini, sizeof(default_theme_ini) - 1 }.lines()) {
        if (line.starts_with('[')) {
            in_colors = line == "[Colors]"sv;
            continue;
        }
        auto equals = line.find('=');
        if (!in_colors || !equals.has_value())
            continue;
        colors.set(line.substring_view(0, *equals), line.substring_view(*equals + 1));
    }
    auto color_of = [&](StringView name) {
        auto value = colors.get(name);
        auto color = value.has_value() ? Gfx::Color::from_string(*value) : Optional<Gfx::Color> {};
        return color.value_or(Gfx::Color::Black).value();
    };
#define __ENUMERATE_COLOR_ROLE(role) theme->color[(int)Gfx::ColorRole::role] = color_of(#role##sv);
    ENUMERATE_COLOR_ROLES(__ENUMERATE_COLOR_ROLE)
#undef __ENUMERATE_COLOR_ROLE
    theme->metric[(int)Gfx::MetricRole::BorderThickness] = 4;
    theme->metric[(int)Gfx::MetricRole::TitleHeight] = 19;
    theme->metric[(int)Gfx::MetricRole::TitleButtonWidth] = 15;
    theme->metric[(int)Gfx::MetricRole::TitleButtonHeight] = 15;
    return buffer;
}

// --- Fonts: the host feeds font files; LibGfx's PathFontProvider holds them -----------------------------


// --- Images: decoded by the host (createImageBitmap / ImageDecoder), delivered as BGRA frames ----------

class ImageCodecPlugin final : public Web::Platform::ImageCodecPlugin {
public:
    virtual NonnullRefPtr<Core::Promise<Web::Platform::DecodedImage>> decode_image(ReadonlyBytes bytes, Function<ErrorOr<void>(Web::Platform::DecodedImage&)> on_resolved, Function<void(Error&)> on_rejected) override
    {
        auto promise = Core::Promise<Web::Platform::DecodedImage>::construct();
        if (on_resolved)
            promise->on_resolution = move(on_resolved);
        if (on_rejected)
            promise->on_rejection = move(on_rejected);
        auto id = m_next_id++;
        m_pending.set(id, promise);
        ganglion_host_decode_image(id, bytes.data(), bytes.size());
        return promise;
    }
    virtual void request_animation_frames(i64 session_id, u32 start_frame_index, u32 count) override
    {
        auto frames = m_sessions.get(session_id);
        if (!frames.has_value()) {
            if (on_animation_decode_failed)
                on_animation_decode_failed(session_id);
            return;
        }
        Vector<NonnullRefPtr<Gfx::Bitmap>> bitmaps;
        for (u32 i = 0; i < count; ++i)
            bitmaps.append((*frames)[(start_frame_index + i) % frames->size()]);
        if (on_animation_frames_decoded)
            on_animation_frames_decoded(session_id, move(bitmaps));
    }
    virtual void stop_animation_decode(i64 session_id) override { m_sessions.remove(session_id); }

    void decoded(u32 id, u32 width, u32 height, u32 frame_count, u8 const* pixels, u32 const* durations)
    {
        auto promise = m_pending.take(id);
        if (!promise.has_value())
            return;
        Web::Platform::DecodedImage image;
        image.frame_count = frame_count;
        image.is_animated = frame_count > 1;
        image.loop_count = 0;
        // A session id means "streamed animation" to LibWeb (AnimatedBitmapDecodedImageData, a repeating timer that
        // repaints the page); a still image must carry 0 or every <img> keeps the page repainting.
        image.session_id = frame_count > 1 ? id : 0;
        Vector<NonnullRefPtr<Gfx::Bitmap>> bitmaps;
        for (u32 frame = 0; frame < frame_count; ++frame) {
            auto bitmap = Gfx::Bitmap::create(Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, { static_cast<int>(width), static_cast<int>(height) });
            if (bitmap.is_error()) {
                auto error = bitmap.release_error();
                (*promise)->reject(move(error));
                return;
            }
            auto const* source = pixels + static_cast<size_t>(frame) * width * height * 4;
            for (u32 y = 0; y < height; ++y)
                __builtin_memcpy(bitmap.value()->scanline_u8(y), source + static_cast<size_t>(y) * width * 4, static_cast<size_t>(width) * 4);
            image.frames.empend(bitmap.value(), durations ? durations[frame] : 0);
            image.all_durations.append(durations ? durations[frame] : 0);
            bitmaps.append(bitmap.release_value());
        }
        if (frame_count > 1)
            m_sessions.set(id, move(bitmaps));
        (*promise)->resolve(move(image));
    }
    void failed(u32 id)
    {
        if (auto promise = m_pending.take(id); promise.has_value()) {
            auto error = Error::from_string_literal("The host could not decode the image");
            (*promise)->reject(move(error));
        }
    }

private:
    u32 m_next_id { 1 };
    HashMap<u32, NonnullRefPtr<Core::Promise<Web::Platform::DecodedImage>>> m_pending;
    HashMap<i64, Vector<NonnullRefPtr<Gfx::Bitmap>>> m_sessions;
};

// --- The page client -------------------------------------------------------------------------------------

class PageClient final : public Web::PageClient {
    GC_CELL(PageClient, Web::PageClient);
    GC_DECLARE_ALLOCATOR(PageClient);

public:
    PageClient(Core::AnonymousBuffer theme, int width, int height, double dpr)
        : m_palette(Gfx::PaletteImpl::create_with_anonymous_buffer(move(theme)))
        , m_width(width)
        , m_height(height)
        , m_dpr(dpr)
    {
    }

    virtual Web::PageId id() const override { return Web::PageId { 1 }; }
    virtual Web::Page& page() override { return *m_page; }
    virtual Web::Page const& page() const override { return *m_page; }
    virtual bool is_connection_open() const override { return true; }
    virtual Gfx::Palette palette() const override { return m_palette; }
    // The host browser's screen (the segment document's `screen`, ganglion_set_screen) once known; until then the viewport.
    virtual Web::DevicePixelRect screen_rect() const override;
    virtual Optional<Web::DevicePixelRect> available_screen_rect() const override;
    virtual u32 screen_color_depth() const override;
    virtual Optional<u8> screen_orientation_type() const override;
    virtual u16 screen_orientation_angle() const override;
    virtual double zoom_level() const override { return 1; }
    virtual double device_pixel_ratio() const override { return m_dpr; }
    virtual double device_pixels_per_css_pixel() const override { return m_dpr; }
    // The host browser's prefers-color-scheme (the segment document's matchMedia, harness/segment/segment.js), as Chrome answers it.
    virtual Web::CSS::PreferredColorScheme preferred_color_scheme() const override;
    virtual Web::CSS::PreferredContrast preferred_contrast() const override { return Web::CSS::PreferredContrast::NoPreference; }
    virtual Web::CSS::PreferredMotion preferred_motion() const override { return Web::CSS::PreferredMotion::NoPreference; }
    virtual size_t screen_count() const override;
    // The host browser's navigator.connection (ganglion_set_network_information).
    virtual NetworkInformationValues network_information() const override;
    // The host's audio output rate (ganglion_set_audio_output, Media.cpp), the default of an AudioContext's sampleRate.
    virtual float audio_output_sample_rate() const override;
    virtual Queue<Web::QueuedInputEvent>& input_event_queue() override { return m_input_events; }
    virtual void report_finished_handling_input_event(Web::PageId, u64, Web::EventResult) override { }
    virtual Web::HTML::CrossProcessId allocate_cross_process_id() override { return { 1, m_next_cross_process_id++ }; }
    virtual void request_frame() override;
    virtual void request_file(Web::FileRequest) override { }
    virtual bool is_headless() const override { return false; }
    // Web storage (localStorage, sessionStorage): in memory, one area per endpoint, since a segment is one
    // site. localStorage is persisted by the host (docs/phase2.md section 5): the host restores it before the first
    // document (ganglion_storage_restore) and takes it when it has changed (ganglion_host_storage_changed, then
    // ganglion_storage_flush). The quota is the 5 MiB browsers give an origin, counted in UTF-16 code units of keys
    // and values.
    struct StorageArea {
        Vector<Utf16String> keys;
        HashMap<Utf16String, Utf16String> values;
        size_t code_units { 0 };
    };
    static StorageArea& local_storage_area();
    static bool& local_storage_dirty();
    void local_storage_changed(Web::StorageAPI::StorageEndpointType endpoint)
    {
        if (endpoint == Web::StorageAPI::StorageEndpointType::SessionStorage || local_storage_dirty())
            return;
        local_storage_dirty() = true;
        ganglion_host_storage_changed();
    }
    StorageArea m_session_storage;
    static constexpr size_t storage_quota_code_units = 5 * 1024 * 1024;

    StorageArea& storage_area(Web::StorageAPI::StorageEndpointType endpoint)
    {
        return endpoint == Web::StorageAPI::StorageEndpointType::SessionStorage ? m_session_storage : local_storage_area();
    }
    virtual Optional<Utf16String> page_did_request_storage_item(Web::StorageAPI::StorageEndpointType endpoint, Web::HTML::EnvironmentId const&, Utf16String const& key) override
    {
        auto value = storage_area(endpoint).values.get(key);
        if (!value.has_value())
            return {};
        return Utf16String { *value };
    }
    virtual WebView::StorageSetResult page_did_set_storage_item(Web::StorageAPI::StorageEndpointType endpoint, Web::HTML::EnvironmentId const&, Utf16String const& key, Utf16String const& value) override
    {
        auto& area = storage_area(endpoint);
        Optional<Utf16String> old_value;
        if (auto existing = area.values.get(key); existing.has_value())
            old_value = Utf16String { *existing };
        size_t after = area.code_units + key.length_in_code_units() + value.length_in_code_units() - (old_value.has_value() ? key.length_in_code_units() + old_value->length_in_code_units() : 0);
        if (after > storage_quota_code_units)
            return WebView::StorageOperationError::QuotaExceededError;
        if (!old_value.has_value())
            area.keys.append(key);
        area.values.set(key, value);
        area.code_units = after;
        local_storage_changed(endpoint);
        return old_value;
    }
    virtual void page_did_remove_storage_item(Web::StorageAPI::StorageEndpointType endpoint, Web::HTML::EnvironmentId const&, Utf16String const& key) override
    {
        auto& area = storage_area(endpoint);
        auto old_value = area.values.take(key);
        if (!old_value.has_value())
            return;
        area.code_units -= key.length_in_code_units() + old_value->length_in_code_units();
        area.keys.remove_first_matching([&](auto const& k) { return k == key; });
        local_storage_changed(endpoint);
    }
    virtual Vector<Utf16String> page_did_request_storage_keys(Web::StorageAPI::StorageEndpointType endpoint, Web::HTML::EnvironmentId const&) override
    {
        return storage_area(endpoint).keys;
    }
    // Cookies (docs/cookies.md): the jar is the host's (glue/cookies.js), shared with the carapace's store; document.cookie
    // reads it here and writes it through ganglion_document_set_cookie (patch 0041), with the raw string.
    virtual HTTP::Cookie::VersionedCookie page_did_request_cookie(Optional<Web::HTML::EnvironmentId> const&, URL::URL const& url, HTTP::Cookie::Source source) override
    {
        if (source != HTTP::Cookie::Source::NonHttp)
            return { {}, MUST(String::from_byte_string(Net::cookie_header(url, "subresource\nGET"sv))) };
        auto serialized = url.to_byte_string();
        char* out = nullptr;
        auto length = ganglion_host_cookie_get(serialized.characters(), serialized.length(), "script", 6, &out);
        if (!out)
            return { {}, String {} };
        auto text = String::from_utf8(StringView { out, length });
        free(out);
        return { {}, text.is_error() ? String {} : text.release_value() };
    }
    // The Cookie Store API's reads: the cookies document.cookie would see, as name and value ("cookiestore": NUL-separated pairs).
    virtual Vector<HTTP::Cookie::Cookie> page_did_request_all_cookies_cookiestore(Web::HTML::EnvironmentId const&, URL::URL const& url) override
    {
        Vector<HTTP::Cookie::Cookie> list;
        auto serialized = url.to_byte_string();
        char* out = nullptr;
        auto length = ganglion_host_cookie_get(serialized.characters(), serialized.length(), "cookiestore", 11, &out);
        if (!out)
            return list;
        auto parts = StringView { out, length }.split_view('\0', SplitBehavior::KeepEmpty);
        for (size_t i = 0; i + 1 < parts.size(); i += 2) {
            HTTP::Cookie::Cookie cookie;
            auto name = String::from_utf8(parts[i]);
            auto value = String::from_utf8(parts[i + 1]);
            if (name.is_error() || value.is_error())
                continue;
            cookie.name = name.release_value();
            cookie.value = value.release_value();
            list.append(move(cookie));
        }
        free(out);
        return list;
    }
    // The Cookie Store API's writes (and document.cookie without patch 0041): the parsed cookie written out again.
    virtual void page_did_set_cookie(Optional<Web::HTML::EnvironmentId> const&, URL::URL const& url, HTTP::Cookie::ParsedCookie const& parsed, HTTP::Cookie::Source source) override
    {
        StringBuilder text;
        text.appendff("{}={}", parsed.name, parsed.value);
        if (parsed.domain.has_value())
            text.appendff("; Domain={}", *parsed.domain);
        if (parsed.path.has_value())
            text.appendff("; Path={}", *parsed.path);
        if (parsed.expiry_time_from_max_age_attribute.has_value())
            text.appendff("; Max-Age={}", (*parsed.expiry_time_from_max_age_attribute - UnixDateTime::now()).to_seconds());
        else if (parsed.expiry_time_from_expires_attribute.has_value())
            text.appendff("; Max-Age={}", (*parsed.expiry_time_from_expires_attribute - UnixDateTime::now()).to_seconds());
        if (parsed.secure_attribute_present)
            text.append("; Secure"sv);
        if (parsed.http_only_attribute_present)
            text.append("; HttpOnly"sv);
        if (parsed.same_site_attribute == HTTP::Cookie::SameSite::Strict)
            text.append("; SameSite=Strict"sv);
        else if (parsed.same_site_attribute == HTTP::Cookie::SameSite::Lax)
            text.append("; SameSite=Lax"sv);
        else if (parsed.same_site_attribute == HTTP::Cookie::SameSite::None)
            text.append("; SameSite=None"sv);
        auto serialized = url.to_byte_string();
        auto line = text.to_byte_string();
        auto context = source == HTTP::Cookie::Source::NonHttp ? "script"sv : "subresource\nGET"sv;
        ganglion_host_cookie_set(serialized.characters(), serialized.length(), context.characters_without_null_termination(), context.length(), line.characters(), line.length());
    }
    virtual u64 page_did_request_storage_usage(Web::HTML::EnvironmentId const&) override
    {
        return (local_storage_area().code_units + m_session_storage.code_units) * 2;
    }
    virtual void page_did_clear_storage(Web::StorageAPI::StorageEndpointType endpoint, Web::HTML::EnvironmentId const&) override
    {
        auto& area = storage_area(endpoint);
        area.keys.clear();
        area.values.clear();
        area.code_units = 0;
        local_storage_changed(endpoint);
    }

    virtual void page_did_change_title(Utf16String const& title) override
    {
        auto view = title.utf16_view();
        Vector<u16> units;
        units.ensure_capacity(view.length_in_code_units());
        for (size_t i = 0; i < view.length_in_code_units(); ++i)
            units.unchecked_append(view.code_unit_at(i));
        ganglion_host_title(units.data(), units.size());
    }
    // A navigation the page asks for (a link, a form, location changes): the host loads the new page
    // itself, the way it loaded this one (docs/phase1.md, "Navigation").
    // A navigation of a child navigable (an iframe) stays in this engine: it plays the UI process's part below
    // (docs/architecture.md, "Same-site iframes"), the top-level one is the host's.
    virtual void request_navigation_start(Web::HTML::LocalNavigable& navigable, Web::NavigationTarget target, URL::URL const& url, Utf16String navigation_id, Optional<Web::HTML::NavigationStartRequest> start_request) override
    {
        if (target == Web::NavigationTarget::IFrame) {
            start_child_navigation(navigable, url, move(navigation_id), move(start_request));
            return;
        }
        // The page asked: its origin and its activation are the navigation's initiator (Fetch Metadata).
        if (auto document = navigable.active_document()) {
            auto window = document->window();
            Net::set_next_navigation_initiator(url, document->origin(), window && window->has_transient_activation());
        }
        auto text = url.to_string();
        ganglion_host_navigate(text.bytes_as_string_view().characters_without_null_termination(), text.bytes_as_string_view().length());
    }
    virtual void request_navigation_population(Web::HTML::LocalNavigable&, Web::NavigationTarget, Web::HTML::NavigationPopulationRequest) override { }
    virtual void navigation_params_creation_finished(Web::HTML::LocalNavigable&, Web::HTML::NavigationPopulationRequest, Web::HTML::NavigationPopulationResult) override;
    virtual void page_did_request_child_navigable_unload(Web::HTML::CrossProcessId) override;
    static void start_child_navigation(Web::HTML::LocalNavigable&, URL::URL const&, Utf16String navigation_id, Optional<Web::HTML::NavigationStartRequest>);
    virtual void history_navigation_params_creation_finished(Web::HTML::CrossProcessId, Web::HTML::HistoryNavigationPopulation) override { }
    // The session history of the page's document (docs/frameworks.md, "Session history"): Ladybird keeps it in the UI
    // process and this is that process's share, for the entries of one document (pushState, replaceState, fragment
    // navigations) and their traversal. Defined below the host state.
    virtual void page_did_request_history_operation(Web::HTML::CrossProcessId, Web::HistoryOperationParameters) override;
    // The Fullscreen API's window step and the pointer lock go to the carapace, which owns the host's (docs/webrtc.md).
    virtual void page_did_request_fullscreen_window() override { ganglion_host_fullscreen(1); }
    virtual void page_did_request_exit_fullscreen() override { ganglion_host_fullscreen(0); }
    virtual void page_did_request_pointer_lock(bool unadjusted_movement) override { ganglion_host_pointer_lock(unadjusted_movement ? 2 : 1); }
    virtual void page_did_request_pointer_unlock() override { ganglion_host_pointer_lock(0); }
    virtual void page_did_play_gamepad_effect(Web::Gamepad::GamepadHandle handle, Web::Gamepad::GamepadEffect const& effect) override
    {
        effect.visit(
            [&](Web::Gamepad::GamepadDualRumbleEffect const& e) { ganglion_host_gamepad_effect(handle, 0, e.strong_magnitude, e.weak_magnitude, static_cast<int>(e.duration)); },
            [&](Web::Gamepad::GamepadTriggerRumbleEffect const& e) { ganglion_host_gamepad_effect(handle, 1, e.left_trigger_magnitude, e.right_trigger_magnitude, static_cast<int>(e.duration)); });
    }
    virtual void page_did_request_stop_gamepad_effects(Web::Gamepad::GamepadHandle handle) override { ganglion_host_gamepad_effect(handle, 2, 0, 0, 0); }

    virtual void visit_edges(Visitor& visitor) override
    {
        Base::visit_edges(visitor);
        visitor.visit(m_page);
    }

    void set_size(int width, int height, double dpr)
    {
        m_width = width;
        m_height = height;
        m_dpr = dpr;
    }

    Gfx::Palette m_palette;

    GC::Ptr<Web::Page> m_page;
    Queue<Web::QueuedInputEvent> m_input_events;
    u64 m_next_cross_process_id { 1 };
    int m_width;
    int m_height;
    double m_dpr;
};

GC_DEFINE_ALLOCATOR(PageClient);

// --- The host state --------------------------------------------------------------------------------------

PageClient::StorageArea& PageClient::local_storage_area()
{
    static PageClient::StorageArea area;
    return area;
}

bool& PageClient::local_storage_dirty()
{
    static bool dirty = false;
    return dirty;
}

struct PendingFetch {
    GC::Root<Web::ResourceLoader::OnHeadersReceived> on_headers;
    GC::Root<Web::ResourceLoader::OnDataReceived> on_data;
    GC::Root<Web::ResourceLoader::OnComplete> on_complete;
    // The request was for a mirror URL of the document's own site (unmirror): see answer_mirror_of_own_site.
    bool mirror_of_own_site { false };
    // The request as it would go on the wire, kept while the host holds the fetch (ganglion_fetch_network).
    Optional<Net::RequestSpec> spec;
    // The jar's context for the request when its credentials mode includes cookies (docs/cookies.md); none when it does not.
    Optional<ByteString> cookie_context;
};

struct HostScreen {
    bool known { false };
    int width { 0 }, height { 0 }, avail_left { 0 }, avail_top { 0 }, avail_width { 0 }, avail_height { 0 };
    u32 color_depth { 24 };
    int orientation_type { -1 }; // an OrientationType's index, -1 unknown
    u16 orientation_angle { 0 };
    bool extended { false }; // more than one screen (Screen.isExtended)
};

struct HostNetwork {
    char effective_type[8] { '4', 'g', 0 };
    double rtt { 50 };
    double downlink { 10 };
    bool save_data { false };
};

struct Host {
    bool color_scheme_dark { false }; // prefers-color-scheme (ganglion_set_color_scheme)
    HostScreen screen; // the host browser's screen (ganglion_set_screen)
    HostNetwork network; // the host browser's navigator.connection (ganglion_set_network_information)
    EventLoopManager event_loop_manager;
    Core::EventLoop* event_loop { nullptr };
    FontProvider* font_provider { nullptr };
    Web::Platform::FontPlugin* font_plugin { nullptr };
    ImageCodecPlugin* image_codec { nullptr };
    GC::Root<PageClient> client;
    GC::Root<Web::Page> page;
    GC::Root<Web::HTML::LocalTraversableNavigable> traversable;
    HashMap<u32, PendingFetch> fetches;
    u32 next_fetch_id { 1 };
    Compositing::DisplayListResourceStorage resources;
    Compositor::DisplayListRasterCache raster_cache;
    Compositor::DisplayListPlayerSkia player { RefPtr<Gfx::SkiaBackendContext> {} };
    RefPtr<Gfx::Bitmap> frame;
    Vector<u8> rgba; // the painted rect (or the whole frame) as RGBA for the host's ImageData
    int width { 0 };
    int height { 0 };
    double dpr { 1 };
    u64 frames_painted { 0 };
    bool page_ready { false };
    // Something asked for a frame since the last paint (PageClient::request_frame, input, scrolling).
    bool paint_requested { true };
    // The last painted frame, for damage: its list, tree and scroll state (DisplayListDamage.h).
    RefPtr<Compositing::DisplayList> last_display_list;
    Optional<Compositing::AccumulatedVisualContextTree> last_tree;
    Compositing::ScrollStateSnapshot last_scroll_state;
    // What the last paint changed: the rect repainted, after the frame's pixels were moved by the blit.
    Gfx::IntRect dirty;
    Gfx::IntPoint blit;
    u64 rasters { 0 };
    u64 full_rasters { 0 };
    u64 blits { 0 };
    // The compositor (Layers.h): set when the next layered paint must send everything (a mode change, a resize).
    bool layers_reset { true };
    bool animations_running { false }; // a visual animation is running: paint at every tick
    // The last paint's cost in ms: layout (update_layout), recording, raster (player + flush), conversion.
    double last_layout_ms { 0 };
    double last_record_ms { 0 };
    double last_raster_ms { 0 };
    double last_convert_ms { 0 };
    RefPtr<Gfx::Typeface const> first_typeface; // for the raster micro-benchmark (debug bit 4)
    // The document's session history: one entry per same-document navigation, the current one. A cross-document
    // navigation is a new segment (the carapace's), so a document starts with a single entry.
    Vector<Web::HTML::SessionHistoryEntryDescriptor> history_entries;
    size_t history_current { 0 };
    // The entries of each child navigable (an iframe) that navigated: the list in step order, and the active one. The
    // top-level list above has an entry for every step; a step only a child took repeats the top-level entry before it,
    // which is the same entry in the joint session history.
    struct ChildHistory {
        Vector<Web::HTML::SessionHistoryEntryDescriptor> entries;
        size_t current { 0 };
    };
    HashMap<Web::HTML::CrossProcessId, ChildHistory> child_histories;
};

static Host* s_host;

static Host& host()
{
    VERIFY(s_host);
    return *s_host;
}

static GC::Ref<Web::DOM::Document> active_document();

// For the font provider's Han preference (Fonts.cpp): the lang of the top-level document's root element.
ByteString document_language()
{
    if (!s_host || !host().traversable || !host().traversable->active_document())
        return {};
    auto* root = host().traversable->active_document()->document_element();
    if (!root)
        return {};
    auto lang = root->get_attribute(Web::HTML::AttributeNames::lang);
    return lang.has_value() ? lang->to_byte_string() : ByteString {};
}

// --- Session history ---------------------------------------------------------------------------------------

// The descriptor of the navigable's active entry (pushState and the other same-document navigations make their new
// entry the active one before they ask for the operation), numbered by its place in the list.
static Web::HTML::SessionHistoryEntryDescriptor describe_active_entry(size_t index)
{
    auto entry = host().traversable->active_session_history_entry();
    VERIFY(entry);
    // A new entry has no step yet (the UI process numbers them); the list position is the step here.
    entry->set_step(static_cast<i32>(index));
    auto descriptor = Web::HTML::create_session_history_entry_descriptor(*entry);
    return descriptor;
}

// What history.length and history.index say, set on the document the way the UI process's job sets them.
static void publish_history_length_and_index(GC::Ref<GC::Function<void()>> then)
{
    auto& h = host();
    if (auto navigable = Web::HTML::local_navigable_with_id(h.traversable->id()))
        navigable->update_nonchanging_navigable_history_step_state({ h.history_entries.size(), h.history_current }, then);
    else
        then->function()();
    h.traversable->set_session_history_entry_count(h.history_entries.size());
}

// --- Child navigables: the UI process's part ----------------------------------------------------------------------
//
// Ladybird keeps the browsing contexts, the session history and the loading of a navigation in the UI process; the
// renderer asks it, and it answers. There is no UI process here, so Host.cpp answers for the documents of this one
// page, as it does for the history of the top-level document (above). An iframe is a child navigable of the page:
//   - creating one asks for a history operation that appends its initial entry; until it is answered the navigable is
//     not "ready for navigation" and its container delays the parent's load event (answered in
//     page_did_request_history_operation);
//   - navigating one asks to start the navigation (start_child_navigation), which checks that unloading is not
//     canceled, builds the population request and lets the renderer fetch and create the navigation params;
//     navigation_params_creation_finished hands the result back to the renderer to populate the document; finalizing
//     the navigation is a history operation (finalize_cross_document_navigation);
//   - removing one asks the UI process to unload its documents, deepest first (page_did_request_child_navigable_unload).
// A frame on another site is not loaded at all: the carapace shows it as a nested segment (docs/architecture.md). Its
// navigation is dropped, the container stops delaying the parent's load event, and the frame stays at about:blank.

static bool frame_is_remote(Web::HTML::LocalNavigable& navigable, URL::URL const& url)
{
    auto container_document = navigable.container_document();
    if (!container_document)
        return false;
    auto frame_url = url.to_byte_string();
    auto document_url = container_document->url().to_byte_string();
    return ganglion_host_frame_is_remote(frame_url.characters(), frame_url.length(), document_url.characters(), document_url.length()) != 0;
}

void PageClient::start_child_navigation(Web::HTML::LocalNavigable& navigable, URL::URL const& url, Utf16String navigation_id, Optional<Web::HTML::NavigationStartRequest> start_request)
{
    // A javascript: URL is run by the page itself; the UI process only records it.
    if (!start_request.has_value())
        return;
    auto ref = GC::Ref { navigable };
    // Not inside the call: the navigate algorithm parked the rest of its steps just before asking, and the UI process
    // answers in a later task.
    Web::Platform::EventLoopPlugin::the().deferred_invoke(GC::create_function(ref->heap(), [ref, url, navigation_id, start_request = move(start_request)]() mutable {
        if (ref->has_been_destroyed())
            return;
        if (frame_is_remote(*ref, url)) {
            ref->resume_navigation_params_creation(navigation_id, {});
            return;
        }
        ref->run_navigation_unload_check(navigation_id, Web::HTML::UnloadPromptShown::No,
            GC::create_function(ref->heap(), [ref, navigation_id, start_request = move(start_request)](bool should_continue) mutable {
                if (!should_continue) {
                    ref->resume_navigation_params_creation(navigation_id, {});
                    return;
                }
                auto request = Web::HTML::create_navigation_population_request(start_request.release_value(), host().client->allocate_cross_process_id());
                ref->resume_navigation_params_creation(navigation_id, move(request));
            }));
    }));
}

// The renderer fetched the response (steps 1 to 4 of attempting to populate the history entry's document); the body is in
// the descriptor, read in full. The UI process would pick the process to host the document; this is it.
void PageClient::navigation_params_creation_finished(Web::HTML::LocalNavigable& navigable, Web::HTML::NavigationPopulationRequest request, Web::HTML::NavigationPopulationResult result)
{
    auto ref = GC::Ref { navigable };
    Web::Platform::EventLoopPlugin::the().deferred_invoke(GC::create_function(ref->heap(), [ref, request = move(request), result = move(result)]() mutable {
        if (ref->has_been_destroyed()) {
            host().client->navigation_population_failed(ref->id(), request.navigation_id);
            return;
        }
        ref->continue_navigation_at_population(move(request), move(result));
    }));
}

struct UnloadCount : public RefCounted<UnloadCount> {
    size_t remaining { 0 };
};

// "Unload a document and its descendants", for the descendants: each navigable's document is unloaded after its own
// descendants', and `done` runs when all of them have been.
static void unload_descendants_of(GC::Ref<Web::HTML::LocalNavigable> navigable, Web::HTML::ChildNavigableDestruction destruction, GC::Ref<GC::Function<void()>> done)
{
    auto children = navigable->child_navigables();
    if (children.is_empty()) {
        done->function()();
        return;
    }
    auto count = adopt_ref(*new UnloadCount);
    count->remaining = children.size();
    for (auto& child : children) {
        auto child_ref = GC::Ref { *child };
        unload_descendants_of(child_ref, destruction, GC::create_function(child_ref->heap(), [child_ref, destruction, count, done] {
            child_ref->run_ui_descendant_unload_task(destruction, Web::HTML::StopHostingAfterUnload::No, GC::create_function(child_ref->heap(), [count, done] {
                if (--count->remaining == 0)
                    done->function()();
            }));
        }));
    }
}

void PageClient::page_did_request_child_navigable_unload(Web::HTML::CrossProcessId navigable_id)
{
    // The container already marked the navigable destroyed; it is still in the registry until the destruction ends.
    auto navigable = Web::HTML::local_navigable_with_id(navigable_id);
    if (!navigable)
        return;
    auto ref = GC::Ref { *navigable };
    unload_descendants_of(ref, Web::HTML::ChildNavigableDestruction::Yes, GC::create_function(ref->heap(), [ref] {
        Web::HTML::NavigableContainer::continue_destroying_the_child_navigable(*ref);
    }));
}

// Applies a child's cross-document navigation to the joint session history and activates its document: "finalize a
// cross-document navigation" (HTML) as the UI process runs it, with the renderer's jobs for the parts that need the
// live navigable and document. A frame's first load replaces its initial about:blank entry; a later one pushes a step.
template<typename Complete>
static void finalize_cross_document_navigation(GC::Ref<Web::Page> page, Web::HTML::CrossProcessId operation_id, Web::FinalizeCrossDocumentNavigationHistoryOperationParameters const& parameters, Complete complete)
{
    auto& heap = page->heap();
    page->history_executor().handle_ui_history_operation_started(operation_id, GC::create_function(heap, [page, operation_id, parameters, complete](Web::HistoryOperationReadyResult ready) {
        // Superseded, or the document went away: the renderer says how the operation ends.
        if (auto const* result = ready.get_pointer<Web::HTML::HistoryStepResult>()) {
            complete(*result, {});
            return;
        }
        auto& h = host();
        auto& heap = page->heap();
        auto navigable_id = parameters.navigable_id;
        auto navigable = Web::HTML::local_navigable_with_id(navigable_id);
        if (!navigable || navigable->has_been_destroyed() || navigable->is_top_level_traversable() || !navigable->active_session_history_entry()) {
            complete(Web::HTML::HistoryStepResult::NoMatchingEntry, {});
            return;
        }
        if (h.history_entries.is_empty())
            h.history_entries.append(describe_active_entry(0));

        auto& child = h.child_histories.ensure(navigable_id, [&] {
            Host::ChildHistory initial;
            auto active = navigable->active_session_history_entry();
            if (!active->step_value().has_value())
                active->set_step(static_cast<i32>(h.history_current));
            initial.entries.append(Web::HTML::create_session_history_entry_descriptor(*active));
            return initial;
        });

        bool replace = parameters.history_handling == Web::HTML::HistoryHandlingBehavior::Replace;
        i32 step = replace ? child.entries[child.current].step : static_cast<i32>(h.history_current) + 1;
        auto descriptor = Web::HTML::create_session_history_entry_descriptor(parameters.history_entry, step);
        if (replace) {
            // Step 9.2.3: a replacement from the same origin keeps the entry's Navigation API key.
            auto const& old = child.entries[child.current];
            if (descriptor.document_state.origin.has_value() && old.document_state.origin.has_value() && descriptor.document_state.origin->is_same_origin(*old.document_state.origin))
                descriptor.navigation_api_key = old.navigation_api_key;
        }
        auto navigation_type = replace ? Web::Bindings::NavigationType::Replace : Web::Bindings::NavigationType::Push;

        page->history_executor().run_ui_changing_navigable_history_job(operation_id, navigable_id, descriptor, parameters.user_involvement, navigation_type, Web::HTML::TraversalYieldsTo::Nothing, {},
            GC::create_function(heap, [page, operation_id, navigable, navigable_id, replace, step, descriptor, complete](Web::HTML::ChangingNavigableHistoryStepJobDisposition disposition, Web::HTML::UnloadDisplayedDocument unload) {
                if (disposition != Web::HTML::ChangingNavigableHistoryStepJobDisposition::Ready) {
                    complete(Web::HTML::HistoryStepResult::Applied, {});
                    return;
                }
                auto& h = host();
                auto& heap = page->heap();
                auto& child = h.child_histories.get(navigable_id).value();
                if (replace) {
                    child.entries[child.current] = descriptor;
                } else {
                    // Step 9.1: clear the forward session history, then the new step is the last.
                    auto before = static_cast<i32>(h.history_current);
                    h.history_entries.shrink(h.history_current + 1);
                    for (auto& other : h.child_histories) {
                        auto& entries = other.value.entries;
                        entries.remove_all_matching([&](auto const& entry) { return entry.step > before; });
                        if (other.value.current >= entries.size())
                            other.value.current = entries.is_empty() ? 0 : entries.size() - 1;
                    }
                    // The top-level document has no entry of its own at the new step: its entry before it is the one there.
                    h.history_entries.append(h.history_entries[h.history_current]);
                    h.history_current = h.history_entries.size() - 1;
                    child.entries.append(descriptor);
                    child.current = child.entries.size() - 1;
                    publish_history_length_and_index(GC::create_function(heap, [] { }));
                }
                Vector<Web::HTML::SessionHistoryEntryDescriptor> entries;
                for (auto const& entry : child.entries)
                    entries.append(entry);
                auto apply = GC::create_function(heap, [page, operation_id, navigable_id, step, unload, entries = move(entries), complete]() mutable {
                    auto& h = host();
                    page->history_executor().apply_ui_changing_navigable_continuation(operation_id, navigable_id, { h.history_entries.size(), h.history_current }, move(entries), unload,
                        GC::create_function(page->heap(), [complete, step](Optional<Web::HTML::HostedNavigableState>, Optional<Web::HTML::SessionHistoryEntryPersistedState>) {
                            host().traversable->set_session_history_entry_count(host().history_entries.size());
                            complete(Web::HTML::HistoryStepResult::Applied, step);
                        }));
                });
                if (unload == Web::HTML::UnloadDisplayedDocument::No) {
                    apply->function()();
                    return;
                }
                // Deactivating the displayed document: its descendants are unloaded first, then the continuation
                // unloads the document itself and activates the new one.
                page->history_executor().prepare_ui_changing_navigable_for_unload(operation_id, navigable_id, GC::create_function(heap, [navigable, apply] {
                    unload_descendants_of(*navigable, Web::HTML::ChildNavigableDestruction::No, apply);
                }));
            }));
    }));
}

// Traverses a child navigable to its entry `index`, the joint session history's step `target` (docs/architecture.md "Frame
// realms": history per navigable). The entry's document is gone (a frame's earlier document is not kept), and this host
// has no UI-process half to populate it again (history_navigation_params_creation_finished does nothing): the child is
// navigated to the entry's URL with replacement, which rewrites that entry (finalize_cross_document_navigation, "replace":
// the step of the current entry), after the current step and the child's current entry are moved to the target. The
// documents' history.length and history.index follow; popstate and the entry's persisted state are not restored.
template<typename Complete>
static void traverse_child(GC::Ref<Web::Page> page, Web::HTML::CrossProcessId navigable_id, size_t index, size_t target, Web::HTML::UserNavigationInvolvement user_involvement, Complete complete)
{
    auto& h = host();
    auto navigable = Web::HTML::local_navigable_with_id(navigable_id);
    auto child = h.child_histories.find(navigable_id);
    if (!navigable || navigable->has_been_destroyed() || !navigable->active_document() || child == h.child_histories.end()) {
        complete(Web::HTML::HistoryStepResult::Applied, {});
        return;
    }
    auto url = child->value.entries[index].url;
    child->value.current = index;
    h.history_current = target;
    auto step = static_cast<i32>(target);
    publish_history_length_and_index(GC::create_function(page->heap(), [] { }));
    (void)navigable->navigate({ .url = url, .source_document = *navigable->active_document(), .history_handling = Web::Bindings::NavigationHistoryBehavior::Replace, .user_involvement = user_involvement });
    complete(Web::HTML::HistoryStepResult::Applied, step);
}

void PageClient::page_did_request_history_operation(Web::HTML::CrossProcessId operation_id, Web::HistoryOperationParameters parameters)
{
    auto& h = host();
    auto page = GC::Ref { *m_page };
    auto complete = [page, operation_id](Web::HTML::HistoryStepResult result, Optional<i32> step) {
        page->history_executor().complete_ui_history_operation(operation_id, result, step);
    };
    auto& heap = page->heap();
    parameters.visit(
        [&](Web::FinalizeSameDocumentNavigationHistoryOperationParameters const& p) {
            if (!h.traversable->active_session_history_entry()) {
                complete(Web::HTML::HistoryStepResult::NoMatchingEntry, {});
                return;
            }
            if (h.history_entries.is_empty()) {
                h.history_entries.append(describe_active_entry(0));
                h.history_current = 0;
            } else if (p.history_handling == Web::HTML::HistoryHandlingBehavior::Replace) {
                h.history_entries[h.history_current] = describe_active_entry(h.history_current);
            } else {
                // Push: the forward entries go, the new one is the last.
                h.history_entries.shrink(h.history_current + 1);
                h.history_entries.append(describe_active_entry(h.history_entries.size()));
                h.history_current = h.history_entries.size() - 1;
            }
            auto step = static_cast<i32>(h.history_current);
            publish_history_length_and_index(GC::create_function(heap, [complete, step] { complete(Web::HTML::HistoryStepResult::Applied, step); }));
        },
        [&](Web::TraverseByDeltaHistoryOperationParameters const& p) {
            auto target = static_cast<i64>(h.history_current) + p.delta;
            if (p.delta == 0 || target < 0 || target >= static_cast<i64>(h.history_entries.size())) {
                complete(Web::HTML::HistoryStepResult::Applied, {});
                return;
            }
            // The joint session history: a step that only a child navigable took (the top-level entry there is the one
            // before it) is that child's to traverse. The child whose entry at the target step is not its current one goes.
            if (h.history_entries[target].step == h.history_entries[h.history_current].step) {
                for (auto& child : h.child_histories) {
                    Optional<size_t> index;
                    for (size_t i = 0; i < child.value.entries.size(); i++) {
                        if (child.value.entries[i].step <= target)
                            index = i;
                    }
                    if (index.has_value() && *index != child.value.current) {
                        traverse_child(page, child.key, *index, static_cast<size_t>(target), p.user_involvement, complete);
                        return;
                    }
                }
            }
            auto navigable_id = h.traversable->id();
            auto descriptor = h.history_entries[target];
            auto user_involvement = p.user_involvement;
            // apply the traverse history step: the job activates the entry (url, state, popstate, hashchange), the
            // continuation records it as current.
            page->history_executor().run_ui_changing_navigable_history_job(operation_id, navigable_id, move(descriptor), user_involvement, Web::Bindings::NavigationType::Traverse, Web::HTML::TraversalYieldsTo::Nothing, {},
                GC::create_function(heap, [page, heap = GC::Ref { heap }, complete, operation_id, navigable_id, target](Web::HTML::ChangingNavigableHistoryStepJobDisposition disposition, Web::HTML::UnloadDisplayedDocument unload) {
                                        auto& h = host();
                    if (disposition != Web::HTML::ChangingNavigableHistoryStepJobDisposition::Ready) {
                        complete(Web::HTML::HistoryStepResult::Applied, {});
                        return;
                    }
                    h.history_current = static_cast<size_t>(target);
                    Vector<Web::HTML::SessionHistoryEntryDescriptor> entries;
                    for (auto const& entry : h.history_entries)
                        entries.append(entry);
                    page->history_executor().apply_ui_changing_navigable_continuation(operation_id, navigable_id, { h.history_entries.size(), h.history_current }, move(entries), unload,
                        GC::create_function(heap, [complete, step = static_cast<i32>(target)](Optional<Web::HTML::HostedNavigableState>, Optional<Web::HTML::SessionHistoryEntryPersistedState>) {
                            host().traversable->set_session_history_entry_count(host().history_entries.size());
                            complete(Web::HTML::HistoryStepResult::Applied, step);
                        }));
                }));
        },
        [&](Web::NavigableCreationHistoryOperationParameters const&) {
            // The UI process appends the child's initial entry at the parent's step and answers with that step. Until
            // it does, the child is not ready for navigation, and its container holds the parent's load event back
            // (HTML "currently delays the load event"): without this answer no page with an iframe ever finished
            // loading. The answer comes in a later task, as the UI process's does.
            auto step = static_cast<i32>(h.history_current);
            Web::Platform::EventLoopPlugin::the().deferred_invoke(GC::create_function(heap, [complete, step] {
                complete(Web::HTML::HistoryStepResult::Applied, step);
            }));
        },
        [&](Web::NavigableDestructionHistoryOperationParameters const& p) {
            h.child_histories.remove(p.navigable_id);
            complete(Web::HTML::HistoryStepResult::Applied, {});
        },
        [&](Web::FlushSessionHistoryTraversalQueueOperationParameters const&) {
            // A barrier in the UI process's queue; this queue runs each operation to its end, so it is already past.
            complete(Web::HTML::HistoryStepResult::Applied, {});
        },
        [&](Web::FinalizeCrossDocumentNavigationHistoryOperationParameters const& p) {
            finalize_cross_document_navigation(page, operation_id, p, complete);
        },
        [&](auto const&) {
            // Reloads, the Navigation API's traversals, closing: not in this engine yet. As before there was a session
            // history here, nothing answers them.
        });
}


// A script of the page's that imports a module relatively is run from a name in the segment's mirror of the site's address space
// (http://<segment>.localhost:<port>/__chitin/o/https/<host>/<path>, harness/segment/worker.js runScript), so its relative imports
// stay in the mirror and the service worker maps them back. A module that came that way has import.meta.url in the mirror, and a
// URL it derives (Vite's preload of a stylesheet, new URL('./a.png', import.meta.url)) reaches the engine as a mirror URL: the engine
// fetches the site's URL it stands for.
static URL::URL unmirror(URL::URL const& url)
{
    constexpr auto prefix = "/__chitin/o/https/"sv;
    if (url.scheme() != "http"sv || !url.host().has_value() || !url.serialize_path().starts_with(prefix))
        return url;
    auto host = url.serialized_host();
    if (!host.ends_with(".localhost"sv))
        return url;
    auto rest = url.serialize_path().substring_view(prefix.length());
    StringBuilder builder;
    builder.append("https://"sv);
    builder.append(rest);
    if (url.query().has_value())
        builder.appendff("?{}", *url.query());
    auto parsed = URL::Parser::basic_parse(builder.string_view());
    return parsed.has_value() ? *parsed : url;
}

// A request for the mirror URL of a file of the document's own site is cross-origin as far as LibWeb can tell (the mirror is
// http://<segment>.localhost, the document https://<site>), so a CORS-mode request for it (Vite's preload of a stylesheet sets
// crossOrigin) fails the CORS check. The file is the site's own, which the page may read; say so in the response. A mirror URL of
// another site gets no such header: that is a cross-origin read and the server's own headers decide.
static bool mirror_of_own_site(URL::URL const& original, URL::URL const& unmirrored)
{
    if (original.to_string() == unmirrored.to_string())
        return false;
    auto document = active_document();
    return document->origin().is_same_origin(unmirrored.origin());
}

static void allow_own_site_mirror(HTTP::HeaderList& headers)
{
    headers.append(HTTP::Header::isomorphic_encode("Access-Control-Allow-Origin"sv, "*"sv));
}

static void submit_to_network(u32 id);
static ByteString chrome_default_header(StringView name, ByteString const& value);
static ByteString s_identity_user_agent;
// The site-compatibility list (docs/surface.md, webcompat/*.json): Ladybird's SiteCompatibilityData, set by the host before the
// loader exists and handed to it as it is created.
static Optional<Web::SiteCompatibilityData> s_site_compatibility;

static void install_network()
{
    Web::ResourceLoader::initialize(GC::Heap::the());
    if (s_site_compatibility.has_value())
        Web::ResourceLoader::the().set_site_compatibility_data(s_site_compatibility.release_value());
    if (!s_identity_user_agent.is_empty())
        Web::ResourceLoader::the().set_user_agent(MUST(String::from_byte_string(s_identity_user_agent)));
    else
        Web::ResourceLoader::the().set_user_agent(MUST(String::formatted("Mozilla/5.0 (WebAssembly) Chitin/{} Ganglion (Ladybird)", provenance_build_id())));
    Web::ResourceLoader::the().set_embedder_network_loader([](Web::LoadRequest const& request, GC::Root<Web::ResourceLoader::OnHeadersReceived> on_headers, GC::Root<Web::ResourceLoader::OnDataReceived> on_data, GC::Root<Web::ResourceLoader::OnComplete> on_complete) {
        auto& h = host();
        auto id = h.next_fetch_id++;
        h.fetches.set(id, PendingFetch { move(on_headers), move(on_data), move(on_complete) });
        auto request_url = unmirror(*request.url());
        auto url = request_url.to_string();
        bool own_site_mirror = mirror_of_own_site(*request.url(), request_url);
        h.fetches.get(id).value().mirror_of_own_site = own_site_mirror;
        auto view = url.bytes_as_string_view();
        Net::RequestSpec spec;
        spec.method = request.method();
        spec.url = request_url;
        // The User-Agent LibWeb chose is the one for the URL it fetched; for an own-site mirror that is the mirror's, so the
        // site-compatibility list is asked again for the site's own URL.
        auto loader_user_agent = Web::ResourceLoader::the().user_agent_for_url(*request.url()).to_byte_string();
        for (auto const& header : request.headers().headers()) {
            if (header.name.equals_ignoring_ascii_case("user-agent"sv) && header.value == loader_user_agent)
                spec.headers.append({ header.name, Web::ResourceLoader::the().user_agent_for_url(request_url).to_byte_string() });
            else if (header.name.equals_ignoring_ascii_case("accept"sv) || header.name.equals_ignoring_ascii_case("accept-language"sv))
                spec.headers.append({ header.name, chrome_default_header(header.name, header.value) });
            else
                spec.headers.append({ header.name, header.value });
        }
        // Chrome sends Upgrade-Insecure-Requests on every document navigation, a frame's too (LibWeb only on top-level ones).
        if (request.is_navigation_request() && !request.headers().contains("Upgrade-Insecure-Requests"sv))
            spec.headers.append({ "Upgrade-Insecure-Requests", "1" });
        spec.body = MUST(ByteBuffer::copy(request.body()));
        {
            // RFC 9218 priority from the fetch's destination and priority hint (Network.cpp priority_for).
            auto destination = request.destination().has_value() ? Web::Fetch::Infrastructure::request_destination_to_string(*request.destination()) : ""sv;
            auto hint = request.priority() == Web::Fetch::Infrastructure::Request::Priority::High ? "high"sv : request.priority() == Web::Fetch::Infrastructure::Request::Priority::Low ? "low"sv : "auto"sv;
            auto priority = Net::priority_for(destination, hint, request.is_navigation_request());
            spec.urgency = priority.urgency;
            spec.incremental = priority.incremental;
        }
        // Cookies go on the wire only (submit_to_network): a page's service worker never sees them in its FetchEvent.
        if (request.include_credentials() == HTTP::Cookie::IncludeCredentials::Yes) {
            auto destination = request.destination();
            StringView kind = "subresource"sv;
            if (request.is_navigation_request())
                kind = destination.has_value() && (*destination == Web::Fetch::Infrastructure::Request::Destination::Document) ? "navigate-top"sv : "navigate-frame"sv;
            h.fetches.get(id).value().cookie_context = ByteString::formatted("{}\n{}", kind, spec.method);
        }
        StringBuilder described;
        described.append(spec.method);
        described.append('\n');
        described.append(Web::Fetch::Infrastructure::request_mode_to_string(request.request_mode()));
        described.append('\n');
        described.append(request.destination().has_value() ? Web::Fetch::Infrastructure::request_destination_to_string(*request.destination()) : ""sv);
        described.append('\n');
        described.append(request.include_credentials() == HTTP::Cookie::IncludeCredentials::Yes ? "include"sv : "omit"sv);
        described.append('\n');
        described.append(request.is_navigation_request() ? "navigate"sv : "-"sv);
        described.append('\n');
        // The request's client: its document's URL (LibWeb's source URL: the client's responsible document, the request's
        // own URL for a document). A page's service worker tells a frame's requests from the page's by it (FetchEvent.clientId).
        if (request.source_url().has_value())
            described.append(unmirror(*request.source_url()).to_string());
        described.append('\n');
        for (auto const& header : spec.headers)
            described.appendff("{}: {}\n", header.name, header.value);
        auto described_bytes = described.to_byte_string();
        h.fetches.get(id).value().spec = move(spec);
        if (ganglion_host_fetch(id, view.characters_without_null_termination(), view.length(), described_bytes.characters(), described_bytes.length(), request.body().data(), request.body().size()))
            return;
        submit_to_network(id);
    });
}

// Fetch's default Accept values and the Accept-Language LibWeb makes from the languages, as Chrome 154 sends them: Chrome
// has its own image and document Accept, and weighs the languages (en-US,en;q=0.9). A page's own values pass unchanged.
static ByteString chrome_default_header(StringView name, ByteString const& value)
{
    if (name.equals_ignoring_ascii_case("accept"sv)) {
        if (value == "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5"sv)
            return "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
        if (value == "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"sv)
            return "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
        return value;
    }
    if (value.contains(';') || value.is_empty())
        return value;
    StringBuilder b;
    auto languages = value.split_view(',');
    for (size_t i = 0; i < languages.size(); ++i) {
        if (i)
            b.append(',');
        b.append(languages[i].trim_whitespace());
        if (i)
            b.appendff(";q=0.{}", max(1, 10 - static_cast<int>(i)));
    }
    // Chrome adds the base language of a single regional one: en-US -> en-US,en;q=0.9.
    if (languages.size() == 1) {
        if (auto dash = languages[0].find('-'); dash.has_value())
            b.appendff(",{};q=0.9", languages[0].substring_view(0, *dash));
    }
    return b.to_byte_string();
}

// The engine's own network (Network.cpp) for a fetch the loader holds: TCP from the host, TLS and HTTP here. The Fetch
// callbacks run inside an execution context, as ganglion_fetch_done runs them.
static void submit_to_network(u32 id)
{
    auto& h = host();
    {
        auto pending = h.fetches.get(id);
        if (!pending.has_value() || !pending->spec.has_value())
            return;
    }
    {
        struct Callbacks : public RefCounted<Callbacks> {
            PendingFetch fetch;
            Requests::RequestTimingInfo timing;
        };
        auto callbacks = adopt_ref(*new Callbacks);
        callbacks->fetch = h.fetches.take(id).release_value();
        auto spec = callbacks->fetch.spec.release_value();
        auto failed_url = spec.url.to_byte_string();
        auto cookie_url = spec.url;
        if (callbacks->fetch.cookie_context.has_value()) {
            if (auto cookies = Net::cookie_header(spec.url, *callbacks->fetch.cookie_context); !cookies.is_empty())
                spec.headers.append({ "Cookie", move(cookies) });
        }
        Net::Sink sink;
        sink.on_headers = [callbacks, cookie_url](u32 status, ByteString const& reason, NonnullRefPtr<HTTP::HeaderList> headers) {
            if (callbacks->fetch.cookie_context.has_value())
                Net::store_cookies(cookie_url, *headers, *callbacks->fetch.cookie_context);
            // As Chrome's network service does, Set-Cookie never goes further than the jar (no page API may read it anyway).
            headers->delete_("Set-Cookie"sv);
            if (callbacks->fetch.mirror_of_own_site)
                allow_own_site_mirror(*headers);
            Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
            callbacks->fetch.on_headers->function()(nullptr, headers, status, String::from_byte_string(reason).release_value_but_fixme_should_propagate_errors(), {}, {}, Requests::CacheState::NotCached);
        };
        sink.on_data = [callbacks](ReadonlyBytes bytes) {
            Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
            callbacks->fetch.on_data->function()(Requests::ResponseData::from_bytes(bytes));
        };
        // Resource Timing's phases, as RequestServer reports them: microseconds from the request's own start (LibWeb adds
        // them to the fetch's post-redirect start time, which is when it handed the request over: Net::submit's time).
        sink.on_timing = [callbacks](Net::Timing const& t) {
            auto offset = [&](double ms) -> i64 { return ms <= 0 ? 0 : static_cast<i64>(max(0.0, ms - t.submitted_ms) * 1000.0); };
            auto& out = callbacks->timing;
            out.domain_lookup_start_microseconds = offset(t.connect_start_ms);
            out.domain_lookup_end_microseconds = offset(t.connect_start_ms);
            out.connect_start_microseconds = offset(t.connect_start_ms);
            out.secure_connect_start_microseconds = offset(t.secure_connect_start_ms);
            out.connect_end_microseconds = offset(t.connect_end_ms);
            out.request_start_microseconds = offset(t.request_start_ms);
            out.response_start_microseconds = offset(t.response_start_ms);
            out.response_end_microseconds = offset(t.response_end_ms);
            out.encoded_body_size = static_cast<i64>(t.encoded_body_bytes);
            out.http_version_alpn_identifier = t.h2 ? Requests::ALPNHttpVersion::Http2_TLS : Requests::ALPNHttpVersion::Http1_1;
        };
        sink.on_complete = [callbacks, failed_url = move(failed_url)](bool ok, ByteString const& error) {
            Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
            if (ok) {
                callbacks->fetch.on_complete->function()(true, callbacks->timing, {});
            } else {
                // What Chrome's console says as "Failed to load resource": a request the network could not finish is
                // otherwise silent (a script element only says its result is null).
                dbgln("network: failed to load {}: {}", failed_url, error);
                callbacks->fetch.on_complete->function()(false, {}, StringView { error });
            }
        };
        Net::submit(move(spec), move(sink));
    }
}

static GC::Ref<Web::DOM::Document> active_document()
{
    return *host().traversable->active_document();
}

}

using namespace Ganglion;

// --- Exports ---------------------------------------------------------------------------------------------

GANGLION_EXPORT void* ganglion_alloc(size_t size)
{
    return malloc(size);
}

GANGLION_EXPORT void ganglion_free(void* pointer)
{
    free(pointer);
}

static bool rasterize_svg_image(Compositing::DisplayListResource const&, Compositing::DisplayListResourceStorage const&, Gfx::Bitmap&);

GANGLION_EXPORT void ganglion_init(int width, int height, double dpr)
{
    VERIFY(!s_host);
    s_host = new Host;
    auto& h = host();
    h.width = width;
    h.height = height;
    h.dpr = dpr;
    Core::EventLoopManager::install(h.event_loop_manager);
    h.event_loop = &Core::EventLoop::initialize_for_current_thread();
    Web::Platform::EventLoopPlugin::install(*new Web::Platform::EventLoopPlugin);
    h.font_provider = new FontProvider;
    Ganglion::install_canvas_2d();
    Ganglion::install_webgl();
    Web::SVG::SVGDecodedImageData::set_in_process_rasterizer(rasterize_svg_image);
    Ganglion::install_media();
    Gfx::FontDatabase::the().install_system_font_provider(adopt_own(*h.font_provider));
}

// ICU's common data (icudt78l.dat, the host build's, served beside the fonts): line and grapheme breaking,
// collation and locale data all come from it. The bytes are kept for the lifetime of the engine, as
// udata_setCommonData requires (ICU User Guide, "ICU Data": the data must stay valid). Before ganglion_start.
GANGLION_EXPORT void ganglion_set_icu_data(uint8_t const* bytes, size_t length)
{
    auto* kept = static_cast<uint8_t*>(malloc(length));
    VERIFY(kept);
    memcpy(kept, bytes, length);
    UErrorCode status = U_ZERO_ERROR;
    udata_setCommonData(kept, &status);
    if (U_FAILURE(status))
        host_log(ByteString::formatted("ganglion: ICU rejected the common data ({} bytes): {}", length, u_errorName(status)));
}

GANGLION_EXPORT void ganglion_add_font(uint8_t const* bytes, size_t length)
{
    auto& h = host();
    auto typeface = Gfx::Typeface::try_load_from_temporary_memory({ bytes, length });
    if (typeface.is_error()) {
        host_log(ByteString::formatted("ganglion: a font could not be loaded ({} bytes): {}", length, typeface.error()));
        return;
    }
    auto face = typeface.release_value();
    host_log(ByteString::formatted("ganglion: font {} weight {} slope {}", face->family(), face->weight(), face->slope()));
    if (g_debug & 16) {
        auto font = face->font(12);
        auto* hb_font = font->harfbuzz_font();
        hb_codepoint_t glyph = 0;
        bool has_h = hb_font_get_nominal_glyph(hb_font, 'H', &glyph);
        int x_scale = 0, y_scale = 0;
        hb_font_get_scale(hb_font, &x_scale, &y_scale);
        auto advance = hb_font_get_glyph_h_advance(hb_font, glyph);
        auto* hb_face = hb_font_get_face(hb_font);
        auto upem = hb_face_get_upem(hb_face);
        auto* hmtx = hb_face_reference_table(hb_face, HB_TAG('h', 'm', 't', 'x'));
        unsigned hmtx_len = 0;
        hb_blob_get_data(hmtx, &hmtx_len);
        hb_blob_destroy(hmtx);
        auto* glyf = hb_face_reference_table(hb_face, HB_TAG('g', 'l', 'y', 'f'));
        unsigned glyf_len = 0;
        hb_blob_get_data(glyf, &glyf_len);
        hb_blob_destroy(glyf);
        auto width = font->width("Hello"sv);
        auto run = Gfx::shape_text({}, 0, 0, "Hello"sv, *font, Gfx::GlyphRun::TextType::Common);
        host_log(ByteString::formatted("ganglion: font diag: shape_text glyphs {} width {}", run->glyphs().size(), run->width()));
        auto const& metrics = font->pixel_metrics();
        host_log(ByteString::formatted("ganglion: font diag: H glyph {} ({}) scale {}x{} advance {} upem {} hmtx {} glyf {} width(Hello) {} zero {} ascent {} descent {} x_height {} pixel_size {}",
            glyph, has_h, x_scale, y_scale, advance, upem, hmtx_len, glyf_len, width, metrics.advance_of_ascii_zero, metrics.ascent, metrics.descent, metrics.x_height, font->pixel_size()));
    }
    if (!h.first_typeface)
        h.first_typeface = face;
    h.font_provider->add(move(face));
}

// The fallback fonts' manifest (docs/fonts.md) and the host's languages (navigator.languages joined by commas), before start.
GANGLION_EXPORT void ganglion_set_fallback_fonts(uint8_t const* bytes, size_t length, char const* languages, size_t languages_length)
{
    host().font_provider->set_fallback_manifest({ bytes, length }, { languages, languages_length });
}

// A fallback subset the engine asked for (ganglion_host_load_fallback_font) has arrived. Every document's cascades are
// re-resolved (patch 0036), so the text that had no glyph lays out again with this one.
GANGLION_EXPORT void ganglion_add_fallback_font(uint32_t id, uint8_t const* bytes, size_t length)
{
    auto& h = host();
    if (!h.font_provider->add_fallback_subset(id, { bytes, length }))
        return;
    Gfx::clear_system_fallback_font_cache();
    if (!h.traversable || !h.traversable->active_document())
        return;
    for (auto& navigable : h.traversable->active_document()->inclusive_descendant_navigables()) {
        auto* local = as_if<Web::HTML::LocalNavigable>(*navigable);
        if (local && local->active_document())
            local->active_document()->font_computer().did_change_system_fallback_fonts();
    }
}

// Fallback subsets asked for and installed, for tests.
GANGLION_EXPORT uint32_t ganglion_fallback_font_counts(void)
{
    auto& h = host();
    return (h.font_provider->requested_count() << 16) | h.font_provider->loaded_count();
}

static bool s_vm_ready; // the main thread VM exists (ganglion_start)

// After the fonts: the VM, the realm, the page and its empty document.
GANGLION_EXPORT void ganglion_start(void)
{
    auto& h = host();
    h.font_plugin = new Web::Platform::FontPlugin(false, h.font_provider);
    Web::Platform::FontPlugin::install(*h.font_plugin);
    h.image_codec = new ImageCodecPlugin;
    Web::Platform::ImageCodecPlugin::install(*h.image_codec);
    Web::Bindings::initialize_main_thread_vm(Web::HTML::AgentType::SimilarOriginWindow);
    auto& vm = Web::Bindings::main_thread_vm();
    s_vm_ready = true;
    install_network();
    // No speculative parsing (patch 0019): the host answers every fetch anyway, and the speculative parser's
    // preloads doubled every script fetch and left the real parser waiting on a script it never ran.
    Web::HTML::set_speculative_parsing_enabled(false);
    auto depth = vm.execution_context_stack().size();
    auto realm = Web::Bindings::create_a_principal_javascript_realm();
    VERIFY(realm.ptr());
    Bridge::set_realm(realm.ptr());
    // The helper leaves the realm's execution context pushed (its callers run scripts in it); the event
    // loop's microtask checkpoint needs an empty stack between tasks, so pop back to where we were.
    while (vm.execution_context_stack().size() > depth)
        vm.pop_execution_context();
    auto client = vm.heap().allocate<PageClient>(make_theme(), h.width, h.height, h.dpr);
    h.client = GC::make_root(*client);
    auto page = Web::Page::create(*client);
    client->m_page = page.ptr();
    // The segment is on screen: a hidden document throttles its timers (HTML "timer throttling"), and the
    // traversable gives its documents the page's visibility at creation.
    page->set_system_visibility_state(Web::HTML::VisibilityState::Visible);
    // No page JavaScript until phase 2: with scripting disabled the parser never fetches or runs
    // scripts (HTML "prepare the script element" step 11) and <noscript> content renders.
    page->set_is_scripting_enabled(false);
    h.page = GC::make_root(*page);
    auto traversable = Web::HTML::LocalTraversableNavigable::create_a_new_top_level_traversable(page, nullptr, {});
    page->set_top_level_traversable(traversable);
    h.traversable = GC::make_root(*traversable);
    traversable->set_viewport_size({ h.width, h.height }, Web::InvalidateDisplayList::PaintCommandsAndHitTestList);
    // Scripts run in the document's realm, whose global is the document's Window (the traversable made
    // its own); that is the realm the host's V8 mirrors.
    Bridge::set_realm(&Web::HTML::relevant_realm(*traversable->active_document()));
    h.page_ready = true;
    Web::IndexedDB::set_persistence_sink([](ByteBuffer entry) { ganglion_host_idb_persist(entry.data(), entry.size()); });
}

// The page's workers' environment (docs/architecture.md "Page service workers"): the page's service worker and its workers
// run in runners with no engine, and their IndexedDB calls are made here. In Chrome a worker has a global of its own, so
// its databases work while the page's document does not exist yet (a navigation the worker answers from IndexedDB, as
// anura.pro's does on every reload) and across the page's navigations. Here that global is the Window of an about:blank
// document of the site's origin in a top-level traversable of its own, which nothing navigates or shows; the page's
// documents of that origin share its databases (one storage key).
static GC::Root<Web::HTML::LocalTraversableNavigable> s_worker_traversable;
void* Ganglion::Bridge::worker_environment_global(char const* url, unsigned long url_length)
{
    auto& h = host();
    if (!h.page_ready)
        return nullptr;
    auto parsed = URL::Parser::basic_parse(StringView { url, url_length });
    if (!parsed.has_value())
        return nullptr;
    auto origin = parsed->origin();
    if (origin.is_opaque())
        return nullptr;
    if (!s_worker_traversable || !s_worker_traversable->active_document() || !s_worker_traversable->active_document()->origin().is_same_origin(origin)) {
        auto traversable = Web::HTML::LocalTraversableNavigable::create_a_new_top_level_traversable(*h.page, nullptr, {});
        s_worker_traversable = GC::make_root(*traversable);
        s_worker_traversable->active_document()->set_origin(origin);
    }
    auto document = s_worker_traversable->active_document();
    if (!document || !document->window())
        return nullptr;
    return &Web::HTML::relevant_realm(*document).global_object();
}

// IndexedDB restore: journal entries (concatenated) replayed before the first page runs; 0 when all applied.
GANGLION_EXPORT int ganglion_idb_import(unsigned char const* bytes, size_t length)
{
    auto result = Web::IndexedDB::import_journal({ bytes, length });
    if (result.is_error()) {
        dbgln("ganglion: IndexedDB restore: {}", result.error());
        return 1;
    }
    return 0;
}

// The databases as one snapshot (compaction): a buffer from ganglion_alloc in *out, its length returned.
GANGLION_EXPORT size_t ganglion_idb_export(unsigned char** out)
{
    auto snapshot = Web::IndexedDB::export_snapshot();
    *out = static_cast<unsigned char*>(malloc(snapshot.size() ? snapshot.size() : 1));
    memcpy(*out, snapshot.data(), snapshot.size());
    return snapshot.size();
}

namespace Ganglion {

// Parses `body` into the traversable's document at `url`, as a navigation would.
// The whole body is in memory, so "change the encoding" (HTML, parsing: step 6, restart the parse with the declared encoding) is
// done before the parse instead of by it: when the sniffing algorithm only guessed (no BOM, no charset in the Content-Type, and a
// <meta charset> or http-equiv declaration past the prescan's first 1024 bytes), the declaration is looked for in the head
// and the document starts with that encoding. LibWeb's parser would see the declaration too late to re-decode text it has
// already converted (a charset-less page of UTF-8 came out as windows-1252). Declarations are looked for from each "<meta" up to
// the end of the head (or 64 KiB), each handed to LibWeb's own prescan so its attribute and content parsing decide.
static Optional<ByteString> late_declared_encoding(Web::DOM::Document& document, ReadonlyBytes bytes)
{
    size_t limit = min<size_t>(bytes.size(), 64 * 1024);
    auto lower = [](u8 c) { return (c >= 'A' && c <= 'Z') ? static_cast<u8>(c + 32) : c; };
    auto starts = [&](size_t at, StringView word) {
        if (at + word.length() > limit)
            return false;
        for (size_t k = 0; k < word.length(); ++k)
            if (lower(bytes[at + k]) != static_cast<u8>(word[k]))
                return false;
        return true;
    };
    for (size_t at = 0; at < limit; ++at) {
        if (bytes[at] != '<')
            continue;
        if (starts(at, "</head"sv) || starts(at, "<body"sv))
            break;
        if (!starts(at, "<meta"sv))
            continue;
        auto found = Web::HTML::run_prescan_byte_stream_algorithm(document, bytes.slice(at, min<size_t>(bytes.size() - at, 1024)));
        if (found.has_value())
            return found;
    }
    return {};
}

// The navigation timing entry of a document the host's navigation fetched (Navigation Timing, "create the navigation
// timing entry"): the fetch's phases from Net::fetch_document, times relative to the document's time origin, which is
// when that fetch started, coarsened to 100 microseconds as the page's other timestamps are.
static void create_navigation_timing_entry(GC::Ref<Web::DOM::Document> document, Net::DocumentResult const& nav)
{
    auto origin = document->load_timing_info().navigation_start_time;
    auto capability = Web::HTML::relevant_settings_object(*document).cross_origin_isolated_capability();
    auto at = [&](double ms) -> double { return ms <= 0 ? 0 : origin + Web::HighResolutionTime::coarsen_time(ms - origin, capability); };
    auto const& t = nav.timing;
    auto timing = Web::Fetch::Infrastructure::FetchTimingInfo::create();
    timing->set_start_time(at(nav.started_ms));
    auto post_redirect_start = nav.redirect_count ? t.submitted_ms : nav.started_ms;
    timing->set_post_redirect_start_time(at(post_redirect_start));
    if (nav.redirect_count) {
        timing->set_redirect_start_time(at(nav.started_ms));
        timing->set_redirect_end_time(at(t.submitted_ms));
    }
    // A reused connection has no connect phase: its times are the fetch start, as in Chrome.
    auto connect_start = t.connect_start_ms > 0 ? t.connect_start_ms : post_redirect_start;
    auto connect_end = t.connect_end_ms > 0 ? t.connect_end_ms : post_redirect_start;
    timing->set_final_connection_timing_info(Web::Fetch::Infrastructure::ConnectionTimingInfo {
        .domain_lookup_start_time = at(connect_start),
        .domain_lookup_end_time = at(connect_start),
        .connection_start_time = at(connect_start),
        .connection_end_time = at(connect_end),
        .secure_connection_start_time = at(t.secure_connect_start_ms),
        .alpn_negotiated_protocol = t.h2 ? "h2"sv : "http/1.1"sv,
    });
    timing->set_final_network_request_start_time(at(t.request_start_ms));
    timing->set_final_network_response_start_time(at(t.response_start_ms));
    timing->set_end_time(at(t.response_end_ms));
    Web::Fetch::Infrastructure::Response::BodyInfo body_info;
    body_info.decoded_size = nav.body.size();
    body_info.encoded_size = t.encoded_body_bytes ? t.encoded_body_bytes : nav.body.size();
    if (nav.headers) {
        if (auto values = nav.headers->get_decode_and_split("Server-Timing"sv); values.has_value())
            timing->set_server_timing_headers(values.release_value());
        if (auto mime = Web::Fetch::Infrastructure::extract_mime_type(*nav.headers); mime.has_value())
            body_info.content_type = Utf16String::from_utf8(Web::MimeSniff::minimise_a_supported_mime_type(*mime));
        if (auto codings = nav.headers->get_decode_and_split("Content-Encoding"sv); codings.has_value() && codings->size() == 1) {
            auto coding = codings->first().to_ascii_lowercase();
            if (coding.is_one_of("gzip"sv, "deflate"sv, "br"sv))
                body_info.content_encoding = Utf16String::from_utf8(coding);
        }
    }
    Web::NavigationTiming::PerformanceNavigationTiming::create_navigation_timing_entry(*document, timing, nav.redirect_count,
        Web::Bindings::NavigationTimingType::Navigate, {}, move(body_info), nav.status);
}

static ByteString s_embedder_referrer; // ganglion_set_embedder
// Cross-origin isolation (docs/user-tests/coi.md). A nested segment's: what its parent's iframe earns (ganglion_set_embedder_isolation).
struct EmbedderIsolation {
    bool isolated { false };
    Web::HTML::EmbedderPolicyValue parent_coep { Web::HTML::EmbedderPolicyValue::UnsafeNone };
    URL::Origin parent_origin { URL::Origin::create_opaque() };
};
static Optional<EmbedderIsolation> s_embedder_isolation;
// The headers of the next ganglion_load (a stand-in's or a page service worker's response): "name: value" lines.
static RefPtr<HTTP::HeaderList> s_next_document_headers;

// CORP for a nested navigation (Fetch "cross-origin resource policy internal check", forNavigation true), on the frame
// response's headers, against its parent's origin and embedder policy: true when blocked.
static bool frame_blocked_by_corp(URL::URL const& url, HTTP::HeaderList const& headers, EmbedderIsolation const& embedder)
{
    auto check = [&](Web::HTML::EmbedderPolicyValue coep) {
        Optional<StringView> policy;
        auto header = headers.get("Cross-Origin-Resource-Policy"sv);
        if (header.has_value()) {
            auto value = header->view().trim_whitespace();
            if (value.is_one_of("same-origin"sv, "same-site"sv, "cross-origin"sv))
                policy = value;
        }
        if (!policy.has_value() && coep != Web::HTML::EmbedderPolicyValue::UnsafeNone)
            policy = "same-origin"sv; // require-corp; credentialless with forNavigation
        if (!policy.has_value() || *policy == "cross-origin"sv)
            return false;
        if (*policy == "same-origin"sv)
            return !embedder.parent_origin.is_same_origin(url.origin());
        return !(embedder.parent_origin.is_same_site(url.origin()) && (embedder.parent_origin.scheme() == "https"sv || url.scheme() != "https"sv));
    };
    return check(Web::HTML::EmbedderPolicyValue::UnsafeNone) || check(embedder.parent_coep);
}

// The document's policies from its response (HTML "create and initialize a Document object" steps: the policy container's
// embedder policy, the opener policy of a top-level document), which the single-document model sets on the document it
// reuses. Returns an error message when the response may not be shown in this navigable (a frame's COEP or CORP).
static Optional<ByteString> apply_document_policies(GC::Ref<Web::DOM::Document> document, URL::URL const& url, HTTP::HeaderList const& headers)
{
    bool secure = Web::SecureContexts::is_url_potentially_trustworthy(url) == Web::SecureContexts::Trustworthiness::PotentiallyTrustworthy;
    auto coep = Web::HTML::obtain_an_embedder_policy(headers, secure);
    if (s_embedder_isolation.has_value() && url.scheme() != "about"sv) {
        // A frame (HTML "check a navigation response's adherence to its embedder policy", and CORP with forNavigation): Chrome
        // shows its error page in the frame.
        if (s_embedder_isolation->parent_coep != Web::HTML::EmbedderPolicyValue::UnsafeNone && coep.value == Web::HTML::EmbedderPolicyValue::UnsafeNone)
            return ByteString("Blocked: the frame's parent requires Cross-Origin-Embedder-Policy and the frame has none."sv);
        if (frame_blocked_by_corp(url, headers, *s_embedder_isolation))
            return ByteString("Blocked by Cross-Origin-Resource-Policy."sv);
    }
    auto policy_container = document->policy_container()->clone(document->heap());
    policy_container->embedder_policy = coep;
    document->set_policy_container(policy_container);
    // HTML "obtain an opener policy" (a top-level document's only; COOP is ignored in a frame).
    Web::HTML::OpenerPolicy opener;
    if (secure && !s_embedder_isolation.has_value()) {
        if (auto coop = headers.get("Cross-Origin-Opener-Policy"sv); coop.has_value()) {
            auto value = coop->view();
            if (auto semicolon = value.find(';'); semicolon.has_value())
                value = value.substring_view(0, *semicolon);
            value = value.trim_whitespace();
            if (value == "same-origin"sv)
                opener.value = Web::HTML::is_compatible_with_cross_origin_isolation(coep.value) ? Web::HTML::OpenerPolicyValue::SameOriginPlusCOEP : Web::HTML::OpenerPolicyValue::SameOrigin;
            else if (value == "same-origin-allow-popups"sv)
                opener.value = Web::HTML::OpenerPolicyValue::SameOriginAllowPopups;
            else if (value == "noopener-allow-popups"sv)
                opener.value = Web::HTML::OpenerPolicyValue::NoopenerAllowPopups;
        }
    }
    document->set_opener_policy(opener);
    Web::HTML::set_top_level_cross_origin_isolation_override(s_embedder_isolation.has_value() ? Optional<bool>(s_embedder_isolation->isolated) : Optional<bool> {});
    return {};
}

static void load_error_page(URL::URL const& url, ByteString const& message);

static void load_document(URL::URL const& url, ReadonlyBytes body, StringView mime, Net::DocumentResult const* navigation = nullptr)
{
    {
        auto headers = navigation && navigation->headers ? NonnullRefPtr(*navigation->headers) : s_next_document_headers ? NonnullRefPtr(*s_next_document_headers) : HTTP::HeaderList::create();
        s_next_document_headers = nullptr;
        if (auto blocked = apply_document_policies(active_document(), url, *headers); blocked.has_value()) {
            load_error_page(url, *blocked);
            return;
        }
    }
    auto& h = host();
    auto document = active_document();
    // The traversable starts with a populated about:blank document (html, head, body); the parser builds
    // the whole tree, so it starts empty, as a navigation's fresh document would.
    document->remove_all_children(true);
    // The initial about:blank of a top-level traversable supports light and dark (HTML "create a new top-level browsing
    // context", Ladybird's BrowsingContext), so it follows prefers-color-scheme; the page parsed into it has only what its own
    // <meta name=color-scheme> says (none: light, as in Chrome). Kept, a dark host turned every page without a color-scheme
    // dark (text.npr.org in the corpus).
    document->set_supported_color_schemes(Optional<Vector<Utf16FlyString>> {}, false);
    // The Window and the document outlive the page in this single-realm model (a document per navigation,
    // with its own realm, comes with the anchors of M3). What the previous page hung on them goes now: its
    // timers, its listeners on the window and the document, and, through the bridge, the properties its
    // scripts put on the host's global. Left in place, the next page's scripts met the old page's state:
    // Wikipedia loaded twice found its RLQ already replaced and reported "module already implemented"
    // (owner run 2026-10-11).
    if (auto window = document->window()) {
        window->clear_map_of_active_timers();
        window->remove_all_event_listeners();
    }
    document->remove_all_event_listeners();
    Bridge::document_reset();
    // A second load reuses the document (no session history in phase 1): the parser's end steps assert the
    // page is not showing yet, and readiness goes back to loading so the load events fire again.
    document->set_page_showing(false);
    // The performance timeline is the new page's (Navigation Timing): its time origin is when its navigation started,
    // its entry buffers start empty, and the document's load timing starts over.
    if (auto window = document->window())
        window->reset_performance_timeline();
    Web::DOM::DocumentLoadTimingInfo load_timing;
    // On the coarsening grid, so that times relative to it are too (Chrome's are multiples of 100 us).
    load_timing.navigation_start_time = Web::HighResolutionTime::coarsen_time(navigation ? navigation->started_ms : Web::HighResolutionTime::unsafe_shared_current_time());
    document->set_load_timing_info(load_timing);
    document->reset_default_timeline();
    document->update_readiness(Web::HTML::DocumentReadyState::Loading);
    document->set_url(url);
    document->set_origin(url.origin());
    // A nested segment's first document has its embedder's referrer; a later one (the frame navigating itself) its own.
    document->set_referrer(Utf16String::from_utf8(s_embedder_referrer));
    s_embedder_referrer = {};
    Net::set_document_referrer({});
    // The environment's creation URL follows the page too: the site-compatibility list's expose_experimental_interfaces
    // (docs/surface.md) is keyed by it, and in this single-realm model the environment was created for about:blank.
    Web::HTML::relevant_settings_object(*document).creation_url = url;
    // The traversable's first document is its initial about:blank; the one parsed here is not. While the flag stayed,
    // every pushState counted as a replace (HTML "URL and history update steps", step 2) and the entry list never grew.
    document->set_is_initial_about_blank(false);
    // The navigable's session history entry is what Navigable::navigate() compares a new URL against: with
    // it at the real URL, a fragment-only change (location.hash, a #link) is a same-document navigation
    // handled in process (navigate_to_a_fragment: hashchange, the document URL), not a request to the host.
    if (auto entry = h.traversable->active_session_history_entry())
        entry->set_url(url);
    // The entry's document state describes the document just parsed: a traversal back to one of its entries asserts the
    // state was populated (HTML "apply the history step", step 5) and compares its origin with the displayed entry's.
    if (auto entry = h.traversable->active_session_history_entry(); entry && entry->document_state()) {
        entry->document_state()->set_ever_populated(true);
        entry->document_state()->set_origin(url.origin());
    }
    // The document's latest entry is the entry it is displayed by (set when a navigation activates a document):
    // navigate to a fragment and the traversal steps read it, and expect it once the document is not the initial one.
    if (auto entry = h.traversable->active_session_history_entry())
        document->set_latest_entry(entry);
    // A document starts with one session history entry (its own); its frames' histories went with it.
    h.child_histories.clear();
    h.history_entries.clear();
    if (h.traversable->active_session_history_entry()) {
        h.history_entries.append(describe_active_entry(0));
        h.history_current = 0;
        publish_history_length_and_index(GC::create_function(document->heap(), [] { }));
        // The Navigation API's entry list starts with that entry (HTML "initialize the navigation API entries for a new
        // document"), as it does when a navigation activates a document: pushState and replaceState update it.
        if (auto window = document->window()) {
            auto entry = h.traversable->active_session_history_entry();
            Vector<NonnullRefPtr<Web::HTML::SessionHistoryEntry>> entries;
            entries.append(*entry);
            window->navigation()->initialize_the_navigation_api_entries_for_reconstructed_session_history(entries, *entry);
        }
    }
    document->reset_paint_timing();
    if (navigation)
        create_navigation_timing_entry(document, *navigation);
    document->queue_initial_visibility_state_entry();
    auto mime_type = Web::MimeSniff::MimeType::parse(mime);
    ByteBuffer bytes = MUST(ByteBuffer::copy(body));
    if (!document->has_encoding()) {
        auto sniffed = Web::HTML::run_encoding_sniffing_algorithm(document, bytes, mime_type);
        if (sniffed.confidence == Web::HTML::EncodingConfidence::Tentative) {
            if (auto declared = late_declared_encoding(document, bytes); declared.has_value()) {
                if (auto standardized = TextCodec::get_standardized_encoding(declared.value()); standardized.has_value()) {
                    // The same two exceptions as the spec's change-the-encoding steps 2 and 3.
                    StringView label = standardized.value();
                    if (label.is_one_of_ignoring_ascii_case("UTF-16BE"sv, "UTF-16LE"sv))
                        label = "UTF-8"sv;
                    else if (label.equals_ignoring_ascii_case("x-user-defined"sv))
                        label = "windows-1252"sv;
                    document->set_encoding(Utf16String::from_ascii_without_validation(label.bytes()));
                }
            }
        }
    }
    // The glue offers SharedArrayBuffer to the page as its window's crossOriginIsolated says, before the page's scripts run.
    ganglion_host_isolation(Web::HTML::relevant_settings_object(*document).cross_origin_isolated_capability() == Web::HTML::CanUseCrossOriginIsolatedAPIs::Yes ? 1 : 0);
    auto parser = Web::HTML::HTMLParser::create_with_uncertain_encoding(document, bytes, mime_type);
    parser->run(url);
    h.event_loop_manager.pump();
}

// What the user sees when a navigation fails: the URL and the reason, nothing else fetched.
static void load_error_page(URL::URL const& url, ByteString const& message)
{
    auto html = ByteString::formatted(
        "<!doctype html><html lang=en><meta charset=utf-8><title>Chitin could not load the page</title>"
        "<style>body{{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;color:#2b2420;background:#f4efe6}}"
        "main{{max-width:40em;margin:auto}}h1{{font-size:22px;margin:0 0 12px}}code{{overflow-wrap:anywhere}}p{{margin:8px 0}}.why{{color:#6c584c}}</style>"
        "<main><h1>This page could not be loaded</h1><p><code>{}</code></p><p class=why>{}</p>"
        "<p class=why>Chitin reaches sites through your relay. If the relay is not running, or refuses this site, nothing loads.</p></main>",
        escape_html_entities(url.to_byte_string()), escape_html_entities(message));
    auto error_url = URL::Parser::basic_parse("about:error"sv);
    VERIFY(error_url.has_value());
    load_document(*error_url, html.bytes(), "text/html"sv);
}

}

// Parses the bytes the host fetched for `url` into the traversable's document, as a navigation would.
GANGLION_EXPORT void ganglion_load(char const* url_bytes, size_t url_length, uint8_t const* body, size_t body_length, char const* mime_bytes, size_t mime_length)
{
    auto url = URL::Parser::basic_parse(StringView { url_bytes, url_length });
    if (!url.has_value()) {
        host_log("ganglion: the document URL did not parse"sv);
        return;
    }
    load_document(*url, { body, body_length }, StringView { mime_bytes, mime_length });
}

// Fetches `url` over the engine's network (redirects followed) and loads it, or the error page. The
// outcome goes to the host through ganglion_host_navigated.
// A nested segment's embedder (docs/architecture.md "Nested segments"): what the iframe gives the document it shows, which
// this engine cannot see because the iframe is in another segment. NUL-separated: the referrer (sent with the document fetch
// and document.referrer of the first document), the iframe's name (window.name), then the ancestor origins, nearest first
// (location.ancestorOrigins). Set before the first navigation.
GANGLION_EXPORT void ganglion_set_embedder(char const* text, size_t length)
{
    auto fields = StringView { text, length }.split_view('\0', SplitBehavior::KeepEmpty);
    s_embedder_referrer = fields.size() > 0 ? ByteString(fields[0]) : ByteString {};
    Net::set_document_referrer(s_embedder_referrer);
    if (fields.size() > 1 && !fields[1].is_empty()) {
        if (s_host && host().traversable && host().traversable->active_document()) {
            if (auto window = active_document()->window()) {
                auto name = Utf16String::from_utf8(fields[1]);
                window->set_name(name);
            }
        }
    }
    Vector<String> origins;
    for (size_t i = 2; i < fields.size(); i++)
        origins.append(MUST(String::from_utf8(fields[i])));
    Web::HTML::Location::set_embedder_ancestor_origins(move(origins));
}

// The response headers of the next ganglion_load ("name: value" lines): its COOP and COEP (docs/user-tests/coi.md).
GANGLION_EXPORT void ganglion_set_next_document_headers(char const* text, size_t length)
{
    auto headers = HTTP::HeaderList::create();
    for (auto line : StringView { text, length }.split_view('\n')) {
        auto colon = line.find(':');
        if (!colon.has_value())
            continue;
        headers->append(HTTP::Header::isomorphic_encode(line.substring_view(0, *colon).trim_whitespace(), line.substring_view(*colon + 1).trim_whitespace()));
    }
    s_next_document_headers = move(headers);
}

// A nested segment's cross-origin isolation as its parent's iframe earns it (the parent isolated and its iframe allowing
// "cross-origin-isolated" for the frame's origin), the parent's embedder policy (0 unsafe-none, 1 require-corp,
// 2 credentialless) and origin: the frame's COEP and CORP are checked against them.
GANGLION_EXPORT void ganglion_set_embedder_isolation(int isolated, int parent_coep, char const* parent_origin, size_t parent_origin_length)
{
    auto origin_url = URL::Parser::basic_parse(StringView { parent_origin, parent_origin_length });
    EmbedderIsolation e;
    e.isolated = isolated != 0;
    e.parent_coep = parent_coep == 1 ? Web::HTML::EmbedderPolicyValue::RequireCorp : parent_coep == 2 ? Web::HTML::EmbedderPolicyValue::Credentialless : Web::HTML::EmbedderPolicyValue::UnsafeNone;
    e.parent_origin = origin_url.has_value() ? origin_url->origin() : URL::Origin::create_opaque();
    s_embedder_isolation = move(e);
}

// The embedder policy of a realm's document (0 unsafe-none, 1 require-corp, 2 credentialless); 0 realm: the principal one. A
// page Worker's script without COEP is refused under a document whose COEP is compatible with cross-origin isolation.
GANGLION_EXPORT int ganglion_realm_embedder_policy(uintptr_t realm_pointer)
{
    auto* realm = reinterpret_cast<JS::Realm*>(realm_pointer);
    auto& settings = realm && realm->host_defined() ? Web::HTML::principal_realm_settings_object(*realm) : Web::HTML::relevant_settings_object(*active_document());
    switch (settings.policy_container()->embedder_policy.value) {
    case Web::HTML::EmbedderPolicyValue::RequireCorp:
        return 1;
    case Web::HTML::EmbedderPolicyValue::Credentialless:
        return 2;
    default:
        return 0;
    }
}

GANGLION_EXPORT void ganglion_navigate(char const* url_bytes, size_t url_length)
{
    auto url = URL::Parser::basic_parse(StringView { url_bytes, url_length });
    if (!url.has_value() || !url->scheme().is_one_of("http"sv, "https"sv)) {
        ByteString message = "not an http or https URL";
        ganglion_host_navigated(url_bytes, url_length, 0, message.characters(), message.length());
        return;
    }
    Net::fetch_document(*url, [](Net::DocumentResult result) {
        auto final_url = result.url.to_byte_string();
        if (!result.error.is_empty()) {
            load_error_page(result.url, result.error);
            ganglion_host_navigated(final_url.characters(), final_url.length(), result.status, result.error.characters(), result.error.length());
            return;
        }
        ByteString mime = "text/html";
        if (result.headers) {
            if (auto type = result.headers->get("Content-Type"sv); type.has_value())
                mime = *type;
        }
        load_document(result.url, result.body, mime, &result);
        ganglion_host_navigated(final_url.characters(), final_url.length(), result.status, "", 0);
    });
}

// The host has a JavaScript engine (V8 in the segment Worker): scripts run through it from now on.
extern "C" void ganglion_js_attach(void);
GANGLION_EXPORT void ganglion_js_enable(void)
{
    ganglion_js_attach();
    if (host().page)
        host().page->set_is_scripting_enabled(true);
}

// Work the host starts in the page's realm (the harness evaluating a string, tests) runs between LibWeb's
// "prepare to run script" and "clean up after running script" (HTML, "running scripts"), with the backup
// incumbent realm set as for a callback: the realm execution context is on the stack, so the entry,
// incumbent and current settings objects all resolve. Nested enters stack.
// Whether there is a document to enter (a call from the host before the first document, or after a failed load, has
// none; the glue then does not bracket it).
GANGLION_EXPORT bool ganglion_js_can_enter(void)
{
    return s_host && host().traversable && host().traversable->active_document();
}

// The settings each enter prepared, for its leave to clean up: the same ones even if the document or the realm's state
// changed in between (HTML's clean-up steps assert that the realm execution context they pop is the one on top).
static Vector<GC::Root<Web::HTML::EnvironmentSettingsObject>> s_entered_settings;

static void enter_settings(Web::HTML::EnvironmentSettingsObject& settings)
{
    s_entered_settings.append(GC::make_root(settings));
    Web::HTML::prepare_to_run_script(settings);
    Web::HTML::prepare_to_run_callback(settings);
}

GANGLION_EXPORT void ganglion_js_enter(void)
{
    enter_settings(Web::HTML::principal_realm_settings_object(Web::HTML::relevant_realm(*active_document())));
}

// The same for page code acting in another realm than the principal one (ganglion_js_realm_of: the realm of the function
// it calls, a frame realm's own code): that realm's settings become the entry and incumbent settings (HTML "incumbent",
// the backup incumbent settings object stack), as they are when a frame's own function runs. 0, or a realm with no
// settings object, is the principal realm.
GANGLION_EXPORT void ganglion_js_enter_realm(uintptr_t realm_pointer)
{
    auto* realm = reinterpret_cast<JS::Realm*>(realm_pointer);
    if (!realm || !realm->host_defined()) {
        ganglion_js_enter();
        return;
    }
    auto& settings = Web::HTML::principal_realm_settings_object(*realm);
    if (auto const* window = Web::HTML::window_from_global_object(settings.global_object()); window && !window->associated_document().is_fully_active()) {
        ganglion_js_enter();
        return;
    }
    enter_settings(settings);
}

GANGLION_EXPORT void ganglion_js_leave(void)
{
    VERIFY(!s_entered_settings.is_empty());
    auto settings = s_entered_settings.take_last();
    Web::HTML::clean_up_after_running_callback(*settings);
    Web::HTML::clean_up_after_running_script(*settings);
}

// The leave of a binding call that page code made from a host job (a V8 promise job or microtask, glue idleEntry): page
// JavaScript is still running on the host's stack, so HTML's microtask checkpoint ("if the JavaScript execution context stack
// is now empty") is not due yet. When the engine queued a mutation observer microtask during the call, the checkpoint is left to the host: it returns 1 and the glue runs ganglion_microtask_checkpoint from a host
// microtask, in queue order with the page's promise jobs (before, MutationObserver callbacks ran inside the setAttribute
// call that queued them, ahead of the rest of the page's code). With nothing queued it checkpoints now, as before.
GANGLION_EXPORT int ganglion_js_leave_deferring_microtasks(void)
{
    VERIFY(!s_entered_settings.is_empty());
    auto settings = s_entered_settings.take_last();
    Web::HTML::clean_up_after_running_callback(*settings);
    auto& vm = settings->global_object().vm();
    VERIFY(&settings->realm_execution_context() == &vm.running_execution_context());
    // Only a queued mutation observer microtask waits for the host: an engine promise the call settled (a WebCrypto rejection)
    // still settles in the call, which is when Chrome settles it (tests/subtle.test.mjs).
    if (Web::HTML::main_thread_event_loop().microtask_queue_empty() || vm.execution_context_stack().size() > 1
        || !Web::Bindings::main_thread_similar_origin_window_agent().mutation_observer_microtask_queued) {
        Web::HTML::clean_up_after_running_script(*settings);
        return 0;
    }
    vm.pop_execution_context();
    return 1;
}

// The deferred checkpoint (above), from a host microtask: only when no engine script is running.
GANGLION_EXPORT void ganglion_microtask_checkpoint(void)
{
    auto& vm = Web::Bindings::main_thread_vm();
    if (!vm.has_running_execution_context())
        Web::HTML::perform_a_microtask_checkpoint();
}

// A deliberate verification failure, for the host's handling of a stopped engine (tests only): a wasm trap
// unwinds no C++ frame, so after one the engine's state is not to be trusted and the glue refuses further
// calls with the reason.
// document.cookie's setter (patch 0041): the page's string as written, for the host's jar. The document's URL is the one the
// jar files the cookie under; it refuses what Chrome refuses.
extern "C" bool ganglion_document_set_cookie(char const* url, size_t url_length, char const* cookie, size_t cookie_length)
{
    ganglion_host_cookie_set(url, url_length, "script", 6, cookie, cookie_length);
    return true;
}

GANGLION_EXPORT void ganglion_debug_trap(void)
{
    VERIFY_NOT_REACHED();
}

// localStorage for the host to persist: the whole area, in the format ganglion_host_storage_data describes. The host
// calls it after ganglion_host_storage_changed (and before it lets the segment go).
GANGLION_EXPORT void ganglion_storage_flush(void)
{
    auto& area = PageClient::local_storage_area();
    PageClient::local_storage_dirty() = false;
    Vector<u16> data;
    auto put_length = [&](size_t length) {
        data.append(static_cast<u16>(length & 0xFFFF));
        data.append(static_cast<u16>(length >> 16));
    };
    auto put_units = [&](Utf16String const& text) {
        auto view = text.utf16_view();
        for (size_t i = 0; i < view.length_in_code_units(); ++i)
            data.append(view.code_unit_at(i));
    };
    for (auto const& key : area.keys) {
        auto value = area.values.get(key);
        if (!value.has_value())
            continue;
        put_length(key.length_in_code_units());
        put_length(value->length_in_code_units());
        put_units(key);
        put_units(*value);
    }
    ganglion_host_storage_data(data.data(), data.size());
}

// The host's persisted localStorage (the format of ganglion_host_storage_data), before the first document.
GANGLION_EXPORT void ganglion_storage_restore(uint16_t const* data, size_t length)
{
    auto& area = PageClient::local_storage_area();
    area.keys.clear();
    area.values.clear();
    area.code_units = 0;
    size_t at = 0;
    auto get_length = [&]() { size_t n = data[at] | (static_cast<size_t>(data[at + 1]) << 16); at += 2; return n; };
    while (at + 4 <= length) {
        size_t key_length = get_length();
        size_t value_length = get_length();
        if (at + key_length + value_length > length)
            break;
        auto key = Utf16String::from_utf16(Utf16View { reinterpret_cast<char16_t const*>(data + at), key_length });
        auto value = Utf16String::from_utf16(Utf16View { reinterpret_cast<char16_t const*>(data + at + key_length), value_length });
        at += key_length + value_length;
        if (area.code_units + key_length + value_length > PageClient::storage_quota_code_units)
            break;
        area.keys.append(key);
        area.values.set(key, value);
        area.code_units += key_length + value_length;
    }
    PageClient::local_storage_dirty() = false;
}

// The trust store for TLS (a PEM bundle of CA certificates, Mozilla's).
GANGLION_EXPORT void ganglion_set_ca_bundle(uint8_t const* bytes, size_t length)
{
    Net::set_ca_bundle({ bytes, length });
}

// (Kept until install_network runs, at start: the ResourceLoader does not exist yet when the host sends it.)
// The platform identity (docs/surface.md): "user agent\nSec-CH-UA\nSec-CH-UA-Mobile\nSec-CH-UA-Platform[\nSec-CH-UA without
// the Chitin brand]", from the host Chrome's UA plus the Chitin token; the same strings navigator answers with. The fifth line
// is what a URL the site-compatibility list hides Chitin from is sent. Before the first request.
GANGLION_EXPORT void ganglion_set_identity(uint8_t const* bytes, size_t length)
{
    auto lines = StringView { reinterpret_cast<char const*>(bytes), length }.lines();
    if (lines.size() != 4 && lines.size() != 5)
        return;
    s_identity_user_agent = ByteString(lines[0]);
    Net::set_client_hints(ByteString(lines[1]), ByteString(lines[2]), ByteString(lines[3]), lines.size() == 5 ? ByteString(lines[4]) : ByteString(lines[1]));
}

// The site-compatibility list (docs/surface.md): a JSON array of Ladybird WebCompat rules ("matches", "user_agent":
// ["hide_Chitin"], "expose_experimental_interfaces"). Returns false (and keeps the previous list) if it does not parse.
GANGLION_EXPORT bool ganglion_set_site_compatibility(uint8_t const* bytes, size_t length)
{
    auto json = JsonValue::from_string(StringView { reinterpret_cast<char const*>(bytes), length });
    if (json.is_error()) {
        host_log(ByteString::formatted("ganglion: site compatibility: {}", json.error()));
        return false;
    }
    auto data = Web::SiteCompatibilityData::from_json(json.value());
    if (data.is_error()) {
        host_log(ByteString::formatted("ganglion: site compatibility: {}", data.error()));
        return false;
    }
    if (Web::ResourceLoader::is_initialized())
        Web::ResourceLoader::the().set_site_compatibility_data(data.release_value());
    else
        s_site_compatibility = data.release_value();
    return true;
}

// The user agent the engine sends to and shows `url` (after the site-compatibility list), as UTF-8 into a static buffer.
GANGLION_EXPORT char const* ganglion_user_agent_for_url(char const* url_bytes, size_t url_length)
{
    static ByteString result;
    auto url = URL::Parser::basic_parse(StringView { url_bytes, url_length });
    if (!url.has_value() || !Web::ResourceLoader::is_initialized())
        result = s_identity_user_agent;
    else
        result = Web::ResourceLoader::the().user_agent_for_url(*url).to_byte_string();
    return result.characters();
}

// The host's TCP streams (Spiracle): one of these per event, then a pump.
// The address the host's TCP stream connected to (before ganglion_tcp_opened), for HTTP/2 connection pooling.
GANGLION_EXPORT void ganglion_tcp_peer(uint32_t stream_id, char const* address, size_t length)
{
    Net::tcp_peer(stream_id, ByteString(StringView { address, length }).to_lowercase());
}

// What a name resolves to, as the host learned it ("host", addresses one per line; none: forget it), for HTTP/2 pooling.
GANGLION_EXPORT void ganglion_net_dns(char const* host, size_t host_length, char const* addresses, size_t addresses_length)
{
    Vector<ByteString> list;
    for (auto line : StringView { addresses, addresses_length }.lines()) {
        if (!line.trim_whitespace().is_empty())
            list.append(ByteString(line.trim_whitespace()).to_lowercase());
    }
    Net::set_dns_answer(ByteString(StringView { host, host_length }).to_lowercase(), move(list));
}

GANGLION_EXPORT void ganglion_tcp_opened(uint32_t stream_id)
{
    Net::tcp_opened(stream_id);
}

GANGLION_EXPORT void ganglion_tcp_data(uint32_t stream_id, uint8_t const* bytes, size_t length)
{
    Net::tcp_data(stream_id, { bytes, length });
}

GANGLION_EXPORT void ganglion_tcp_closed(uint32_t stream_id, uint32_t reason)
{
    Net::tcp_closed(stream_id, reason);
}

// A frame tick from the host: a rendering opportunity for LibWeb's event loop (HTML "update the rendering":
// requestAnimationFrame callbacks, resize and intersection observers, style and layout flushes), which the
// loop runs as a rendering task on the next pump. The host grants one per display frame whether or not it
// will paint; `ts` is the host's timestamp in milliseconds (the page's time origin as the Worker's).
GANGLION_EXPORT void ganglion_rendering_opportunity(double ts)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    (void)ts;
    Web::HTML::main_thread_event_loop().rendering_opportunity(Web::HighResolutionTime::unsafe_shared_current_time(), Web::HTML::EventLoop::RenderingOpportunitySource::Manual);
    h.event_loop_manager.pump();
}

// Counters: 0 bytes received, 1 bytes sent, 2 connections, 3 TLS handshakes, 4 handshake wall ms (sum),
// 5 handshake compute ms (sum), 6 requests, 7 failures, 8 CA certificates loaded, 9 requests in flight, 11 HTTP/2 connections, 12 HTTP/2 streams, 13 pooled dispatches.
GANGLION_EXPORT double ganglion_net_stats(int which)
{
    auto const& s = Net::stats();
    switch (which) {
    case 0: return static_cast<double>(s.bytes_received);
    case 1: return static_cast<double>(s.bytes_sent);
    case 2: return static_cast<double>(s.connections);
    case 3: return static_cast<double>(s.tls_handshakes);
    case 4: return s.tls_handshake_ms;
    case 5: return s.tls_handshake_cpu_ms;
    case 6: return static_cast<double>(s.requests);
    case 7: return static_cast<double>(s.failures);
    case 8: return static_cast<double>(s.ca_certificates);
    case 9: return static_cast<double>(s.requests - s.completed - s.failures);
    case 10: Net::dump(); return 0;
    case 11: return static_cast<double>(s.h2_connections);
    case 12: return static_cast<double>(s.h2_streams);
    case 13: return static_cast<double>(s.h2_pooled);
    default: return 0;
    }
}

static NonnullRefPtr<HTTP::HeaderList> host_response_headers(char const* header_bytes, size_t header_length, bool mirror_of_own_site)
{
    auto headers = HTTP::HeaderList::create();
    for (auto line : StringView { header_bytes, header_length }.lines()) {
        auto colon = line.find(':');
        if (!colon.has_value())
            continue;
        auto name = line.substring_view(0, *colon).trim_whitespace();
        auto value = line.substring_view(*colon + 1).trim_whitespace();
        headers->append(HTTP::Header::isomorphic_encode(name, value));
    }
    if (mirror_of_own_site)
        allow_own_site_mirror(*headers);
    return headers;
}

// A host response in parts (a body that streams in: a media resource of the harness's stand-in): the headers, the body
// in chunks, then the end (or ganglion_fetch_failed).
GANGLION_EXPORT void ganglion_fetch_headers(uint32_t id, uint32_t status, char const* header_bytes, size_t header_length)
{
    auto& h = host();
    auto fetch = h.fetches.get(id);
    if (!fetch.has_value())
        return;
    auto headers = host_response_headers(header_bytes, header_length, fetch->mirror_of_own_site);
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    fetch->on_headers->function()(nullptr, headers, status, {}, {}, {}, Requests::CacheState::NotCached);
}

GANGLION_EXPORT void ganglion_fetch_data(uint32_t id, uint8_t const* body, size_t body_length)
{
    auto& h = host();
    auto fetch = h.fetches.get(id);
    if (!fetch.has_value())
        return;
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    fetch->on_data->function()(Requests::ResponseData::from_bytes({ body, body_length }));
}

GANGLION_EXPORT void ganglion_fetch_end(uint32_t id)
{
    auto& h = host();
    auto fetch = h.fetches.take(id);
    if (!fetch.has_value())
        return;
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    fetch->on_complete->function()(true, {}, {});
}

GANGLION_EXPORT void ganglion_fetch_done(uint32_t id, uint32_t status, char const* header_bytes, size_t header_length, uint8_t const* body, size_t body_length)
{
    auto& h = host();
    auto fetch = h.fetches.take(id);
    if (!fetch.has_value())
        return;
    auto headers = host_response_headers(header_bytes, header_length, fetch->mirror_of_own_site);
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    fetch->on_headers->function()(nullptr, headers, status, {}, {}, {}, Requests::CacheState::NotCached);
    fetch->on_data->function()(Requests::ResponseData::from_bytes({ body, body_length }));
    fetch->on_complete->function()(true, {}, {});
}

// A fetch the host claimed (ganglion_host_fetch returned 1) goes to the engine's own network after all, exactly as it would
// have without the host: the page's service worker let it fall through (docs/architecture.md, "Page service workers").
GANGLION_EXPORT void ganglion_fetch_network(uint32_t id)
{
    submit_to_network(id);
}

// A request on the engine's own network for the host, outside any document's Fetch: a page service worker's own fetch(). No
// cookies, no CORS and no redirects here (the host applies its rules); the whole response comes back through
// ganglion_host_net_done. Only http(s).
// `cookies`: the request's credentials include cookies (the caller applied the credentials mode); the jar adds them and takes
// the response's Set-Cookie, which the host never sees (docs/cookies.md).
GANGLION_EXPORT void ganglion_net_request(uint32_t id, char const* method, size_t method_length, char const* url_bytes, size_t url_length, char const* header_bytes, size_t header_length, uint8_t const* body, size_t body_length, int cookies)
{
    auto url = URL::Parser::basic_parse(StringView { url_bytes, url_length });
    if (!url.has_value() || !url->scheme().is_one_of("http"sv, "https"sv)) {
        auto message = "not an http or https URL"sv;
        ganglion_host_net_done(id, 0, nullptr, 0, nullptr, 0, message.characters_without_null_termination(), message.length());
        return;
    }
    Net::RequestSpec spec;
    spec.method = ByteString(StringView { method, method_length });
    spec.url = *url;
    for (auto line : StringView { header_bytes, header_length }.lines()) {
        auto colon = line.find(':');
        if (!colon.has_value())
            continue;
        auto name = line.substring_view(0, *colon).trim_whitespace();
        if (name.equals_ignoring_ascii_case("cookie"sv))
            continue;
        spec.headers.append({ ByteString(name), ByteString(line.substring_view(*colon + 1).trim_whitespace()) });
    }
    spec.body = MUST(ByteBuffer::copy(ReadonlyBytes { body, body_length }));
    auto cookie_context = ByteString::formatted("subresource\n{}", spec.method);
    if (cookies) {
        if (auto header = Net::cookie_header(spec.url, cookie_context); !header.is_empty())
            spec.headers.append({ "Cookie", move(header) });
    }
    struct State : public RefCounted<State> {
        u32 id { 0 };
        u32 status { 0 };
        ByteString headers;
        ByteBuffer body;
    };
    auto state = adopt_ref(*new State);
    state->id = id;
    Net::Sink sink;
    sink.on_headers = [state, cookies, cookie_context, cookie_url = spec.url](u32 status, ByteString const&, NonnullRefPtr<HTTP::HeaderList> headers) {
        state->status = status;
        if (cookies)
            Net::store_cookies(cookie_url, *headers, cookie_context);
        StringBuilder builder;
        for (auto const& header : headers->headers()) {
            if (header.name.equals_ignoring_ascii_case("set-cookie"sv))
                continue;
            builder.appendff("{}: {}\n", header.name, header.value);
        }
        state->headers = builder.to_byte_string();
    };
    sink.on_data = [state](ReadonlyBytes bytes) {
        state->body.append(bytes);
    };
    sink.on_complete = [state](bool ok, ByteString const& error) {
        if (!ok) {
            auto message = error.is_empty() ? ByteString("network error") : error;
            ganglion_host_net_done(state->id, 0, nullptr, 0, nullptr, 0, message.characters(), message.length());
            return;
        }
        ganglion_host_net_done(state->id, state->status, state->headers.characters(), state->headers.length(), state->body.data(), state->body.size(), nullptr, 0);
    };
    Net::submit(move(spec), move(sink));
}

// An upgrade request ("GET", the headers one "name: value" per line) on the engine's own network, for the host's WebSocket: the
// connection is the host's after a 101 (ganglion_tunnel_write / ganglion_tunnel_close, ganglion_host_tunnel_*). `id` is the host's.
GANGLION_EXPORT void ganglion_tunnel_open(uint32_t id, char const* url_bytes, size_t url_length, char const* header_bytes, size_t header_length)
{
    auto url = URL::Parser::basic_parse(StringView { url_bytes, url_length });
    if (!url.has_value() || !url->scheme().is_one_of("http"sv, "https"sv)) {
        auto message = "not an http or https URL"sv;
        ganglion_host_tunnel_close(id, message.characters_without_null_termination(), message.length());
        return;
    }
    Net::RequestSpec spec;
    spec.url = *url;
    bool has_user_agent = false;
    for (auto line : StringView { header_bytes, header_length }.lines()) {
        auto colon = line.find(':');
        if (!colon.has_value())
            continue;
        auto name = line.substring_view(0, *colon).trim_whitespace();
        if (name.equals_ignoring_ascii_case("cookie"sv))
            continue; // the jar's, below
        has_user_agent |= name.equals_ignoring_ascii_case("user-agent"sv);
        spec.headers.append({ ByteString(name), ByteString(line.substring_view(*colon + 1).trim_whitespace()) });
    }
    // A WebSocket handshake carries the User-Agent its http(s) URL is given (Ladybird's user_agent_for_websocket_url), as
    // every request does: the site-compatibility list applies to it too.
    if (!has_user_agent && Web::ResourceLoader::is_initialized())
        spec.headers.append({ "User-Agent", Web::ResourceLoader::the().user_agent_for_url(*url).to_byte_string() });
    // The handshake carries the jar's cookies for the URL and its 101 may set some (RFC 6455 4.1, 6265bis), as in Chrome; the
    // host's WebSocket code never sees either.
    if (auto header = Net::cookie_header(*url, "websocket\nGET"sv); !header.is_empty())
        spec.headers.append({ "Cookie", move(header) });
    Net::TunnelSink sink;
    sink.on_open = [id, cookie_url = *url](u32 status, ByteString const& reason, HTTP::HeaderList const& headers) {
        Net::store_cookies(cookie_url, headers, "websocket\nGET"sv);
        StringBuilder builder;
        for (auto const& header : headers.headers()) {
            if (header.name.equals_ignoring_ascii_case("set-cookie"sv))
                continue;
            builder.appendff("{}: {}\n", header.name, header.value);
        }
        auto text = builder.to_byte_string();
        ganglion_host_tunnel_open(id, status, reason.characters(), reason.length(), text.characters(), text.length());
    };
    sink.on_data = [id](ReadonlyBytes bytes) {
        ganglion_host_tunnel_data(id, bytes.data(), bytes.size());
    };
    sink.on_close = [id](ByteString const& error) {
        ganglion_host_tunnel_close(id, error.characters(), error.length());
    };
    Net::open_tunnel(id, move(spec), move(sink));
}

GANGLION_EXPORT int ganglion_tunnel_write(uint32_t id, uint8_t const* bytes, size_t length)
{
    return Net::tunnel_write(id, { bytes, length }) ? 1 : 0;
}

GANGLION_EXPORT void ganglion_tunnel_close(uint32_t id)
{
    Net::tunnel_close(id);
}

GANGLION_EXPORT void ganglion_fetch_failed(uint32_t id, char const* message, size_t length)
{
    auto& h = host();
    auto fetch = h.fetches.take(id);
    if (!fetch.has_value())
        return;
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*active_document()), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    fetch->on_complete->function()(false, {}, StringView { message, length });
}

GANGLION_EXPORT void ganglion_image_done(uint32_t id, uint32_t width, uint32_t height, uint32_t frame_count, uint8_t const* pixels, uint32_t const* durations)
{
    host().image_codec->decoded(id, width, height, frame_count, pixels, durations);
}

GANGLION_EXPORT void ganglion_image_failed(uint32_t id)
{
    host().image_codec->failed(id);
}

// Runs due timers and queued events. Returns the milliseconds until the next timer, or -1 for none.
GANGLION_EXPORT int32_t ganglion_pump(void)
{
    auto& h = host();
    for (int i = 0, rounds = provenance_pump_rounds(); i < rounds; ++i) {
        auto ran = h.event_loop_manager.pump();
        if (g_debug & 1)
            dbgln("ganglion: pump round {}: {} events, pending {}, next timer {} ms", i, ran, Core::ThreadEventQueue::current().has_pending_events(), h.event_loop_manager.next_timer_in_ms());
        if (ran == 0)
            break;
    }
    // An event posted while the rounds ran (a deferred invocation from a callback, such as the parser's
    // resume after a blocking script) waits for the next pump: ask for it now, else the host would stop
    // pumping with work queued and no timer armed.
    if (Core::ThreadEventQueue::current().has_pending_events())
        return 0;
    auto next = h.event_loop_manager.next_timer_in_ms();
    return next < 0 ? -1 : static_cast<int32_t>(min<i64>(next, 0x7FFFFFFF));
}

GANGLION_EXPORT void ganglion_set_viewport(int width, int height, double dpr)
{
    auto& h = host();
    h.width = width;
    h.height = height;
    h.dpr = dpr;
    h.client->set_size(width, height, dpr);
    if (h.traversable)
        h.traversable->set_viewport_size({ width, height }, Web::InvalidateDisplayList::PaintCommandsAndHitTestList);
    h.frame = nullptr;
}

// prefers-color-scheme: 1 dark, 0 light (the host's, read by the segment document; sent again when it changes).
GANGLION_EXPORT void ganglion_set_color_scheme(int dark)
{
    auto& h = host();
    if (h.color_scheme_dark == (dark != 0))
        return;
    h.color_scheme_dark = dark != 0;
    if (h.page)
        h.page->invalidate_style_for_preference_change();
}

// The host browser's screen, as the segment document reads it (harness/segment/segment.js): CSS pixels, as Chrome reports
// them; Page treats the client's rect as the web-exposed screen area as it is. Sent again when the orientation changes,
// which fires `change` at every window's screen.orientation (Screen Orientation, "screen orientation change steps").
GANGLION_EXPORT void ganglion_set_screen(int width, int height, int avail_left, int avail_top, int avail_width, int avail_height, int color_depth, int orientation_type, int orientation_angle, int extended)
{
    auto& h = host();
    bool orientation_changed = h.screen.known && (h.screen.orientation_type != orientation_type || h.screen.orientation_angle != orientation_angle);
    h.screen = { true, width, height, avail_left, avail_top, avail_width, avail_height, static_cast<u32>(color_depth), orientation_type, static_cast<u16>(orientation_angle), extended != 0 };
    if (!orientation_changed || !h.traversable || !h.traversable->active_document())
        return;
    for (auto& navigable : h.traversable->active_document()->inclusive_descendant_navigables()) {
        auto* local = as_if<Web::HTML::LocalNavigable>(*navigable);
        if (local && local->active_window())
            local->active_window()->screen()->orientation_did_change();
    }
}

Web::DevicePixelRect PageClient::screen_rect() const
{
    auto const& s = host().screen;
    if (s.known)
        return { 0, 0, s.width, s.height };
    return { 0, 0, static_cast<int>(m_width * m_dpr), static_cast<int>(m_height * m_dpr) };
}

Optional<Web::DevicePixelRect> PageClient::available_screen_rect() const
{
    auto const& s = host().screen;
    if (!s.known)
        return {};
    return Web::DevicePixelRect { s.avail_left, s.avail_top, s.avail_width, s.avail_height };
}

u32 PageClient::screen_color_depth() const
{
    return host().screen.known ? host().screen.color_depth : 24;
}

Optional<u8> PageClient::screen_orientation_type() const
{
    auto const& s = host().screen;
    if (!s.known || s.orientation_type < 0 || s.orientation_type > 3)
        return {};
    return static_cast<u8>(s.orientation_type);
}

// The host browser's navigator.connection, as the segment document reads it: effectiveType ("slow-2g", "2g", "3g", "4g" as
// 0-3), rtt in milliseconds and downlink in megabits per second, already rounded by the host as the Network Information API
// says. A change fires `change` at every window's navigator.connection that a page has looked at.
GANGLION_EXPORT void ganglion_set_network_information(int effective_type, double rtt, double downlink, int save_data)
{
    static constexpr char const* types[] = { "slow-2g", "2g", "3g", "4g" };
    auto& h = host();
    auto const* type = types[effective_type >= 0 && effective_type <= 3 ? effective_type : 3];
    bool changed = StringView { h.network.effective_type, strlen(h.network.effective_type) } != StringView { type, strlen(type) } || h.network.rtt != rtt || h.network.downlink != downlink || h.network.save_data != (save_data != 0);
    strncpy(h.network.effective_type, type, sizeof(h.network.effective_type) - 1);
    h.network.rtt = rtt;
    h.network.downlink = downlink;
    h.network.save_data = save_data != 0;
    if (!changed || !h.traversable || !h.traversable->active_document())
        return;
    for (auto& navigable : h.traversable->active_document()->inclusive_descendant_navigables()) {
        auto* local = as_if<Web::HTML::LocalNavigable>(*navigable);
        if (!local || !local->active_window())
            continue;
        if (auto connection = local->active_window()->navigator()->connection_if_created())
            connection->did_change();
    }
}

Web::PageClient::NetworkInformationValues PageClient::network_information() const
{
    auto const& n = host().network;
    return { StringView { n.effective_type, strlen(n.effective_type) }, n.rtt, n.downlink, n.save_data };
}

extern "C" uint32_t g_ganglion_audio_output_rate;

float PageClient::audio_output_sample_rate() const
{
    return g_ganglion_audio_output_rate >= 8000 && g_ganglion_audio_output_rate <= 384000 ? static_cast<float>(g_ganglion_audio_output_rate) : 44100.0f;
}

size_t PageClient::screen_count() const
{
    return host().screen.extended ? 2 : 1;
}

u16 PageClient::screen_orientation_angle() const
{
    return host().screen.orientation_angle;
}

Web::CSS::PreferredColorScheme PageClient::preferred_color_scheme() const
{
    return host().color_scheme_dark ? Web::CSS::PreferredColorScheme::Dark : Web::CSS::PreferredColorScheme::Light;
}

static u32 s_paint_requests_from_page { 0 }; // PageClient::request_frame calls since the last paint (diagnostics)

void PageClient::request_frame()
{
    ++s_paint_requests_from_page;
    host().paint_requested = true;
    ganglion_host_request_frame();
}

static bool descendants_need_record(Web::HTML::LocalNavigable&);

// Why a paint is wanted, as bits (docs/feel.md: pages that paint every tick while nothing changes): 1 the first paint,
// 2 a frame request (input, scrolling, the page client), 4 running animations, 8 a display list to record, 16 a canvas,
// 32 a media frame, 64 a frame document, 128 tiles ahead still to raster, 256 the page client asked since the last paint.
GANGLION_EXPORT uint32_t ganglion_needs_paint_reasons(void)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return 0;
    return (h.frames_painted == 0 ? 1u : 0u) | (h.paint_requested ? 2u : 0u) | (h.animations_running ? 4u : 0u)
        | (h.traversable->needs_to_record_display_list() ? 8u : 0u) | (Ganglion::canvas_2d_pending() ? 16u : 0u)
        | (Ganglion::media_frames_pending() ? 32u : 0u) | (descendants_need_record(*h.traversable) ? 64u : 0u)
        | (Ganglion::Layers::prefetch_pending() ? 128u : 0u) | (s_paint_requests_from_page ? 256u : 0u);
}

// Whether a paint would change the frame: the first one, a display list to re-record (style, layout, DOM
// and selection changes set the navigable's flag, as they do for Ladybird's compositor), or a frame
// request (input, scrolling, readiness). A static page answers false after its first paint.
GANGLION_EXPORT bool ganglion_needs_paint(void)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return false;
    return h.frames_painted == 0 || h.paint_requested || h.animations_running || h.traversable->needs_to_record_display_list() || Ganglion::canvas_2d_pending() || Ganglion::media_frames_pending() || descendants_need_record(*h.traversable);
}

// Moves the frame's pixels by (dx, dy): what a scroll does to everything that scrolls with the viewport.
// Returns the strip(s) left exposed, as one rect when the move is along one axis.
static Gfx::IntRect blit_frame(Gfx::Bitmap& frame, int dx, int dy)
{
    int width = frame.width();
    int height = frame.height();
    auto pitch = frame.pitch();
    auto* base = frame.scanline_u8(0);
    if (dy != 0) {
        int rows = height - abs(dy);
        if (dy > 0)
            memmove(base, base + static_cast<size_t>(dy) * pitch, static_cast<size_t>(rows) * pitch);
        else
            memmove(base + static_cast<size_t>(-dy) * pitch, base, static_cast<size_t>(rows) * pitch);
    }
    if (dx != 0) {
        int columns = width - abs(dx);
        for (int y = 0; y < height; ++y) {
            auto* row = frame.scanline_u8(y);
            if (dx > 0)
                memmove(row, row + static_cast<size_t>(dx) * 4, static_cast<size_t>(columns) * 4);
            else
                memmove(row + static_cast<size_t>(-dx) * 4, row, static_cast<size_t>(columns) * 4);
        }
    }
    Gfx::IntRect exposed;
    if (dy > 0)
        exposed = { 0, height - dy, width, dy };
    else if (dy < 0)
        exposed = { 0, 0, width, -dy };
    if (dx > 0)
        exposed = exposed.is_empty() ? Gfx::IntRect { width - dx, 0, dx, height } : exposed.united({ width - dx, 0, dx, height });
    else if (dx < 0)
        exposed = exposed.is_empty() ? Gfx::IntRect { 0, 0, -dx, height } : exposed.united({ 0, 0, -dx, height });
    return exposed;
}

// The one spatial node whose scroll offset changed between two snapshots, if it is exactly one.
static Optional<size_t> single_changed_scroll_node(Compositing::ScrollStateSnapshot const& before, Compositing::ScrollStateSnapshot const& after)
{
    auto old_offsets = before.device_offsets();
    auto new_offsets = after.device_offsets();
    Optional<size_t> changed;
    auto count = max(old_offsets.size(), new_offsets.size());
    for (size_t i = 0; i < count; ++i) {
        auto old_offset = i < old_offsets.size() ? old_offsets[i] : Gfx::FloatPoint {};
        auto new_offset = i < new_offsets.size() ? new_offsets[i] : Gfx::FloatPoint {};
        if (old_offset == new_offset)
            continue;
        if (changed.has_value())
            return {};
        changed = i;
    }
    return changed;
}

// Whether every spatial node but the root sits under `index`: then `index` is the viewport's scroll node
// and nothing (no fixed-position box, no other scroller) stays put while it scrolls, so a scroll is a
// blit of the frame plus the exposed strip. Sticky boxes change their own snapshot entries, which the
// single-node test above already excludes.
static bool everything_scrolls_with(Compositing::AccumulatedVisualContextTree const& tree, size_t index)
{
    auto count = tree.spatial_node_count();
    Compositing::SpatialNodeIndex roots[] = { Compositing::SpatialNodeIndex { static_cast<u32>(index) } };
    auto in_subtree = tree.spatial_nodes_in_subtrees_of(roots);
    for (size_t i = 1; i < count; ++i) {
        if (i >= in_subtree.size() || !in_subtree[i])
            return false;
    }
    return true;
}

static void convert_rect_to_rgba(Host& h, Gfx::IntRect rect)
{
    h.rgba.resize(static_cast<size_t>(rect.width()) * rect.height() * 4);
    auto* target = h.rgba.data();
    auto alpha = provenance_alpha();
    for (int y = 0; y < rect.height(); ++y) {
        auto const* source = h.frame->scanline_u8(rect.y() + y) + static_cast<size_t>(rect.x()) * 4;
        for (int x = 0; x < rect.width(); ++x, source += 4, target += 4) {
            target[0] = source[2];
            target[1] = source[1];
            target[2] = source[0];
            target[3] = alpha;
        }
    }
}

// Same-site iframes: the engine has no compositor host, so a child navigable's document is painted here when the
// parent's list reaches its DrawCompositedContext (patch 0030 gives the container an in-process context id). Each
// context keeps its resources and raster cache between frames; the child's list is recorded again when its navigable
// asks, and rastered into a surface the size of the destination (device pixels).
struct ChildContextState {
    AK_ALLOC_WITH_KMALLOC;
    Compositing::DisplayListResourceStorage resources;
    Compositor::DisplayListRasterCache raster_cache;
    RefPtr<Gfx::Bitmap> bitmap;
    RefPtr<Compositing::DisplayList> display_list;
    // What the bitmap holds (docs/feel.md "Paint profile"): the paint it was painted in, and the list and offsets it was
    // painted with. Every DrawCompositedContext of the frame (one per tile it crosses) used to repaint the whole child.
    u64 painted_in { 0 };
    Compositing::DisplayList const* painted_list { nullptr };
    Vector<Gfx::FloatPoint> painted_offsets;
};
static u64 s_paint_serial { 0 }; // one per ganglion_paint
static bool s_paint_canvas_or_media_changed { false }; // this paint flushed a canvas or shows a new video frame
static HashMap<u64, NonnullOwnPtr<ChildContextState>>& child_contexts()
{
    static HashMap<u64, NonnullOwnPtr<ChildContextState>> contexts;
    return contexts;
}

// Whether a frame's document below `navigable` changed what it paints.
static bool descendants_need_record(Web::HTML::LocalNavigable& navigable)
{
    for (auto& child : navigable.child_navigables()) {
        auto* local = as_if<Web::HTML::LocalNavigable>(*child);
        if (!local || local->has_been_destroyed())
            continue;
        if (local->needs_to_record_display_list() || descendants_need_record(*local))
            return true;
    }
    return false;
}

// After a frame: a frame's document that was not drawn (culled, render-blocked) does not keep asking; its list is
// recorded again when it is next drawn.
static void settle_descendants(Web::HTML::LocalNavigable& navigable)
{
    for (auto& child : navigable.child_navigables()) {
        auto* local = as_if<Web::HTML::LocalNavigable>(*child);
        if (!local || local->has_been_destroyed())
            continue;
        if (local->needs_to_record_display_list()) {
            if (auto it = child_contexts().find(Web::Painting::in_process_compositor_context_id(*local)); it != child_contexts().end())
                it->value->display_list = nullptr;
            local->clear_needs_to_record_display_list();
        }
        settle_descendants(*local);
    }
}

static Compositing::CompositedContextSurface paint_child_context(Web::CompositorContextId id, Gfx::FloatRect destination, int depth)
{
    auto* navigable = Web::Painting::local_navigable_for_in_process_compositor_context(id.value());
    if (!navigable || depth > 8)
        return {};
    auto document = navigable->active_document();
    if (!document)
        return {};
    int width = static_cast<int>(ceilf(destination.width()));
    int height = static_cast<int>(ceilf(destination.height()));
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384)
        return {};
    auto& state = *child_contexts().ensure(id.value(), [] { return make<ChildContextState>(); });
    Gfx::FloatRect content { 0, 0, static_cast<float>(width), static_cast<float>(height) };
    // Painted already in this paint, at this size: the same pixels for every tile that shows the frame.
    if (state.bitmap && state.painted_in == s_paint_serial && state.bitmap->width() == width && state.bitmap->height() == height)
        return { Gfx::PaintingSurface::wrap_bitmap(*state.bitmap), content };
    if (!state.bitmap || state.bitmap->width() != width || state.bitmap->height() != height) {
        auto bitmap = Gfx::Bitmap::create(Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, { width, height });
        if (bitmap.is_error())
            return {};
        state.bitmap = bitmap.release_value();
        state.display_list = nullptr;
    }
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*document), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    Web::Layout::ForcedReadScope read { *document };
    document->update_layout(Web::DOM::UpdateLayoutReason::HTMLEventLoopRenderingUpdate);
    Web::HTML::PaintConfig paint_config;
    paint_config.canvas_fill_rect = Gfx::IntRect { 0, 0, width, height };
    if (!state.display_list || navigable->needs_to_record_display_list()) {
        state.display_list = document->record_display_list(read, paint_config, state.resources, Web::Painting::PaintCommandCacheMode::ReadWrite);
        if (!state.display_list)
            return {};
        navigable->clear_needs_to_record_display_list();
    }
    auto tree = document->paint_state().visual_context_tree(*document);
    document->paint_state().refresh_scroll_state(read, *document);
    Compositing::ScrollStateSnapshot scroll_state = document->scroll_state_snapshot();
    // Nothing changed since the last paint (the same list, the same scroll offsets, no canvas, video or animation that
    // draws without a new list, and no frame of its own): the bitmap still holds it.
    auto offsets = scroll_state.device_offsets();
    bool unchanged = state.painted_in != 0 && state.painted_list == state.display_list.ptr() && state.painted_offsets.size() == offsets.size()
        && !s_paint_canvas_or_media_changed && !Ganglion::canvas_2d_pending() && !Ganglion::media_frames_pending() && !tree.has_visual_animations()
        && !descendants_need_record(*navigable);
    for (size_t k = 0; unchanged && k < offsets.size(); ++k)
        unchanged = state.painted_offsets[k] == offsets[k];
    state.painted_in = s_paint_serial;
    if (unchanged)
        return { Gfx::PaintingSurface::wrap_bitmap(*state.bitmap), content };
    state.painted_list = state.display_list.ptr();
    state.painted_offsets.clear();
    for (auto const& o : offsets)
        state.painted_offsets.append(o);
    __builtin_memset(state.bitmap->scanline_u8(0), 0, state.bitmap->size_in_bytes());
    auto surface = Gfx::PaintingSurface::wrap_bitmap(*state.bitmap);
    Compositing::CompositedContextResolver nested = [depth](Web::CompositorContextId child, Gfx::FloatRect rect, Gfx::FloatMatrix4x4 const&) {
        return paint_child_context(child, rect, depth + 1);
    };
    Compositor::DisplayListPlayerSkia player { RefPtr<Gfx::SkiaBackendContext> {} };
    player.execute(*state.display_list, tree, state.resources, state.raster_cache, scroll_state, surface, &Ganglion::canvas_surfaces(), &nested);
    player.flush(*surface);
    return { surface, content };
}

// An SVG image's frames (drawImage or createImageBitmap of an SVG <img>): Ladybird asks its compositor process to rasterize
// the image's display list; there is none here, so the list is replayed in-process like the page's own frames (patch 0050).
static bool rasterize_svg_image(Compositing::DisplayListResource const& list, Compositing::DisplayListResourceStorage const& resources, Gfx::Bitmap& target)
{
    Compositor::DisplayListRasterCache raster_cache;
    Compositing::ScrollStateSnapshot scroll_state;
    auto surface = Gfx::PaintingSurface::wrap_bitmap(target);
    Compositor::DisplayListPlayerSkia player { RefPtr<Gfx::SkiaBackendContext> {} };
    player.execute(*list.display_list, list.visual_context_tree, resources, raster_cache, scroll_state, surface, &Ganglion::canvas_surfaces(), nullptr);
    player.flush(*surface);
    return true;
}

static Compositing::CompositedContextResolver const& child_context_resolver()
{
    static Compositing::CompositedContextResolver resolver = [](Web::CompositorContextId id, Gfx::FloatRect rect, Gfx::FloatMatrix4x4 const&) {
        return paint_child_context(id, rect, 0);
    };
    return resolver;
}

// Lays out and paints the document into the frame. Returns the RGBA pixels (width * height * 4 bytes, at
// device pixels), or null if nothing could be painted.
// Whether the active document is render-blocked now (HTML; docs/scroll.md "FOUC"): 1, 0, or -1 without a document.
GANGLION_EXPORT int ganglion_render_blocked(void)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable || !h.traversable->active_document())
        return -1;
    return h.traversable->active_document()->is_render_blocked() ? 1 : 0;
}

GANGLION_EXPORT uint8_t const* ganglion_paint(void)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return nullptr;
    int pixel_width = static_cast<int>(h.width * h.dpr);
    int pixel_height = static_cast<int>(h.height * h.dpr);
    if (!h.frame || h.frame->width() != pixel_width || h.frame->height() != pixel_height) {
        auto bitmap = Gfx::Bitmap::create(Gfx::BitmapFormat::BGRA8888, Gfx::AlphaType::Premultiplied, { pixel_width, pixel_height });
        if (bitmap.is_error())
            return nullptr;
        h.frame = bitmap.release_value();
        h.rgba.resize(static_cast<size_t>(pixel_width) * pixel_height * 4);
        Ganglion::Layers::reset();
        h.layers_reset = true;
    }
    Gfx::IntRect frame_rect { 0, 0, pixel_width, pixel_height };
    auto document = active_document();
    // HTML "render-blocked" (stylesheets in the head, blocking=render, while the parser may still add such elements):
    // nothing of the document is presented, as Chrome presents nothing (docs/scroll.md "FOUC"). The host keeps showing
    // what it showed (the previous page's last frame: paint holding). LibWeb's event loop skips such documents in its
    // rendering steps; this paint path is ours and did not.
    if (g_debug & 1)
        host_log(ByteString::formatted("ganglion: paint: render-blocked {} (high resolution time {} ms)", document->is_render_blocked(), Web::HighResolutionTime::current_high_resolution_time(Web::HTML::relevant_global_object(*document))));
    if (document->is_render_blocked())
        return nullptr;
    // The traversable's initial about:blank (before the first document is parsed into it) is never presented either:
    // the host keeps the previous page up or shows blank (Chrome does not paint it for a navigation).
    if (document->is_initial_about_blank())
        return nullptr;
    ++s_paint_serial;
    bool frame_is_new = h.frames_painted == 0 || !h.last_display_list || !h.last_tree.has_value() || h.last_tree->spatial_node_count() == 0;
    Web::HTML::TemporaryExecutionContext context { Web::HTML::relevant_realm(*document), Web::HTML::TemporaryExecutionContext::CallbacksEnabled::Yes };
    Web::Layout::ForcedReadScope read { *document };
    auto t_layout = MonotonicTime::now();
    document->update_layout(Web::DOM::UpdateLayoutReason::HTMLEventLoopRenderingUpdate);
    bool canvas_changed = Ganglion::canvas_2d_pending();
    Ganglion::flush_canvas_2d(); // the canvases' recorded drawing reaches their surfaces before the frame samples them
    auto t_record = MonotonicTime::now();
    h.last_layout_ms = (t_record - t_layout).to_nanoseconds() / 1e6;
    // As LocalNavigable::paint does for a local root: the canvas fill rect is the device viewport, which the
    // recording clips and fills to; without it everything is culled.
    Web::HTML::PaintConfig paint_config;
    paint_config.canvas_fill_rect = frame_rect;
    // Record only when something changed the list (the navigable's flag, which the compositor path clears in
    // commit_frame and this path clears here); a scroll alone replays the last list at new offsets.
    // A canvas that was drawn on moved its content generation, which the recording carries into its DrawCanvas command
    // (that is how damage sees the canvas changed); LibWeb's compositor learns of it from the canvas presenting instead.
    bool record = frame_is_new || canvas_changed || h.traversable->needs_to_record_display_list();
    RefPtr<Compositing::DisplayList> display_list = h.last_display_list;
    if (record) {
        display_list = document->record_display_list(read, paint_config, h.resources, Web::Painting::PaintCommandCacheMode::ReadWrite);
        if (!display_list)
            return nullptr;
        h.traversable->clear_needs_to_record_display_list();
    }
    // Video: each sink the list refers to shows the frame the media server presents now (Media.cpp). A new frame
    // does not change the list, so it repaints the frame (FIXME: only the video's rect).
    for (auto const& [resource_id, sink_handle] : h.resources.video_sink_handles())
        h.resources.set_video_sink(Compositing::VideoSinkResourceId { resource_id }, Ganglion::media_video_sink(sink_handle));
    bool media_changed_now = Ganglion::media_frames_changed();
    bool video_changed = media_changed_now && !h.resources.video_sink_handles().is_empty();
    s_paint_canvas_or_media_changed = canvas_changed || media_changed_now;
    // The tree's node values (a transform, an opacity) change without a new recording when LibWeb updates them in place
    // (incremental visual context updates): take the document's tree whenever it still fits the list.
    auto visual_context_tree = document->paint_state().visual_context_tree(*document);
    if (!record && h.last_tree.has_value() && visual_context_tree.structural_epoch() != display_list->compatible_visual_context_tree_structural_epoch())
        visual_context_tree = *h.last_tree;
    // Transform/opacity animations LibWeb hands a compositor (visual animations in the tree) are sampled here, at the
    // paint's time, as Document's observers and the Compositor service sample them; while one runs, the next tick
    // paints again. Without this they did not move at all in Chitin (no compositor host).
    if (visual_context_tree.has_visual_animations()) {
        auto sample_time_ns = MonotonicTime::now().nanoseconds();
        visual_context_tree = visual_context_tree.with_visual_animation_samples(sample_time_ns);
        h.animations_running = visual_context_tree.has_active_visual_animation_at(sample_time_ns);
    } else {
        h.animations_running = false;
    }
    h.last_record_ms = record ? (MonotonicTime::now() - t_record).to_nanoseconds() / 1e6 : 0;
    // The recording refreshes the scroll state itself; a replay at new offsets has to ask for it.
    if (!record)
        document->paint_state().refresh_scroll_state(read, *document);
    Compositing::ScrollStateSnapshot scroll_state = document->scroll_state_snapshot();
    if (g_debug & 2)
        host_log(ByteString::formatted("ganglion: paint: tape {} bytes, {} runs, clear {}, viewport box {}, ready state {}, viewport {}x{} at {}, recorded {}", display_list->tape_size(), display_list->run_count(), display_list->surface_clear_color(), document->has_committed_viewport_box(), to_underlying(document->readiness()), h.width, h.height, h.traversable->viewport_scroll_offset(), record));
    if (g_debug & 8)
        host_log(ByteString::formatted("ganglion: display list dump:\n{}", document->dump_display_list()));

    // The compositor (docs/compositor.md): the list split into layers, each layer's dirty tiles rastered; the carapace
    // composites them. The flat path below stays the reference (and the debug flag that forces it).
    if (Ganglion::Layers::mode() != Ganglion::Layers::Mode::Flat) {
        bool children_changed = descendants_need_record(*h.traversable);
        Ganglion::Layers::PaintInput input {
            .list = *display_list,
            .tree = visual_context_tree,
            .scroll = scroll_state,
            .last_list = frame_is_new ? nullptr : h.last_display_list.ptr(),
            .last_tree = frame_is_new || !h.last_tree.has_value() ? nullptr : &*h.last_tree,
            .last_scroll = frame_is_new ? nullptr : &h.last_scroll_state,
            .recorded = record,
            .force_full = frame_is_new || h.layers_reset || display_list->surface_clear_color() != (h.last_display_list ? h.last_display_list->surface_clear_color() : Optional<Gfx::Color> {}),
            .media_changed = video_changed || children_changed,
            .frame_rect = frame_rect,
            .resources = h.resources,
            .raster_cache = h.raster_cache,
            .player = h.player,
            .canvases = &Ganglion::canvas_surfaces(),
            .children = &child_context_resolver(),
            .fill = provenance_fill(),
            .alpha = provenance_alpha(),
        };
        auto t_layers = MonotonicTime::now();
        Ganglion::Layers::paint(input);
        settle_descendants(*h.traversable);
        h.layers_reset = false;
        h.last_raster_ms = (MonotonicTime::now() - t_layers).to_nanoseconds() / 1e6;
        h.last_convert_ms = 0;
        if (!Ganglion::Layers::dirty_tiles().is_empty())
            ++h.rasters;
        ++h.frames_painted;
        h.paint_requested = Ganglion::Layers::prefetch_pending();
        s_paint_requests_from_page = 0;
        h.last_display_list = display_list;
        h.last_tree = visual_context_tree;
        h.last_scroll_state = scroll_state;
        h.dirty = {};
        h.blit = {};
        h.rgba.resize(4);
        return h.rgba.data();
    }

    // Damage: what has to be rasterized again. A frame-sized change, a new clear colour or a list the damage
    // pass cannot compare means everything; a viewport scroll with nothing fixed is a blit of the pixels and
    // the strip it exposes; otherwise the rects the two lists differ in (DisplayListDamage.h).
    Gfx::IntRect damage = frame_rect;
    h.blit = {};
    // A frame's document that changed is not in the parent's list (only its DrawCompositedContext is): repaint all.
    bool children_changed = descendants_need_record(*h.traversable);
    if (!frame_is_new && !video_changed && !children_changed && display_list->surface_clear_color() == h.last_display_list->surface_clear_color()) {
        auto changed_node = single_changed_scroll_node(h.last_scroll_state, scroll_state);
        bool scrolled_whole = !record && changed_node.has_value() && everything_scrolls_with(visual_context_tree, *changed_node);
        if (scrolled_whole) {
            auto delta = scroll_state.device_offset_for_index(Compositing::SpatialNodeIndex { static_cast<u32>(*changed_node) }) - h.last_scroll_state.device_offset_for_index(Compositing::SpatialNodeIndex { static_cast<u32>(*changed_node) });
            // The snapshot holds the node's translation (minus the scroll position): scrolling down by 120
            // is a delta of -120, and the content moves up by 120.
            int dx = -static_cast<int>(roundf(delta.x()));
            int dy = -static_cast<int>(roundf(delta.y()));
            if (abs(dx) < pixel_width && abs(dy) < pixel_height && (dx != 0 || dy != 0) && -delta.x() == static_cast<float>(dx) && -delta.y() == static_cast<float>(dy)) {
                damage = blit_frame(*h.frame, dx, dy);
                h.blit = { -dx, -dy };
                ++h.blits;
            } else if (dx == 0 && dy == 0) {
                damage = {};
            }
        } else {
            auto computed = Compositing::compute_display_list_damage(*h.last_display_list, *h.last_tree, h.last_scroll_state, *display_list, visual_context_tree, scroll_state, frame_rect);
            if (computed.has_value())
                damage = computed->intersected(frame_rect);
        }
    }

    auto t_raster = MonotonicTime::now();
    if (!damage.is_empty()) {
        if (damage == frame_rect)
            ++h.full_rasters;
        ++h.rasters;
        for (int y = damage.y(); y < damage.bottom(); ++y)
            __builtin_memset(h.frame->scanline_u8(y) + static_cast<size_t>(damage.x()) * 4, provenance_fill(), static_cast<size_t>(damage.width()) * 4);
        auto surface = Gfx::PaintingSurface::wrap_bitmap(*h.frame);
        auto& canvas = surface->canvas();
        canvas.save();
        canvas.clipRect(SkRect::MakeXYWH(damage.x(), damage.y(), damage.width(), damage.height()));
        h.player.execute(*display_list, visual_context_tree, h.resources, h.raster_cache, scroll_state, surface, &Ganglion::canvas_surfaces(), &child_context_resolver());
        canvas.restore();
        h.player.flush(*surface);
        settle_descendants(*h.traversable);
        if (g_debug & 4) {
            // Raster micro-benchmark: what Skia costs for a frame-sized fill, with and without AA, and the
            // list replayed again, to tell the player from the pipeline.
            auto time = [&](auto&& body) {
                auto t0 = MonotonicTime::now();
                for (int i = 0; i < 10; ++i)
                    body();
                return (MonotonicTime::now() - t0).to_nanoseconds() / 1e7;
            };
            SkPaint plain;
            plain.setColor(SkColorSetARGB(0xFF, 0xF0, 0xF0, 0xF0));
            SkPaint aa;
            aa.setAntiAlias(true);
            aa.setColor(SkColorSetARGB(0xFF, 0xF0, 0xF0, 0xF0));
            auto full = SkRect::MakeXYWH(0, 0, pixel_width, pixel_height);
            auto clear_ms = time([&] { canvas.clear(SK_ColorWHITE); });
            auto fill_ms = time([&] { canvas.drawRect(full, plain); });
            auto fill_aa_ms = time([&] { canvas.drawRect(full, aa); });
            auto replay_ms = time([&] { h.player.execute(*display_list, visual_context_tree, h.resources, h.raster_cache, scroll_state, surface, &Ganglion::canvas_surfaces(), nullptr); });
            auto memset_ms = time([&] { __builtin_memset(h.frame->scanline_u8(0), 0xFF, h.frame->size_in_bytes()); });
            // Raw Skia text: 200 glyphs of the first font at 16px, as the player's blobs are made (subpixel), and
            // without subpixel positioning, each drawn 10 times after a warm-up.
            double text_ms = 0, text_nosub_ms = 0, blob_ms = 0;
            if (h.first_typeface) {
                auto font = h.first_typeface->font(12);
                auto make_blob = [&](bool subpixel) {
                    auto sk_font = font->skia_font(1);
                    sk_font.setSubpixel(subpixel);
                    SkTextBlobBuilder builder;
                    auto const& run = builder.allocRunPos(sk_font, 200);
                    for (int i = 0; i < 200; ++i) {
                        run.glyphs[i] = static_cast<SkGlyphID>(36 + (i % 50));
                        run.pos[i * 2] = 10 + i * 3.7f;
                        run.pos[i * 2 + 1] = 100 + (i % 7) * 20.3f;
                    }
                    return builder.make();
                };
                auto blob = make_blob(true);
                auto blob_nosub = make_blob(false);
                SkPaint text_paint;
                text_paint.setColor(SK_ColorBLACK);
                canvas.drawTextBlob(blob, 0, 0, text_paint);
                canvas.drawTextBlob(blob_nosub, 0, 0, text_paint);
                text_ms = time([&] { canvas.drawTextBlob(blob, 0, 0, text_paint); });
                text_nosub_ms = time([&] { canvas.drawTextBlob(blob_nosub, 0, 0, text_paint); });
                blob_ms = time([&] { (void)make_blob(true); });
            }
            host_log(ByteString::formatted("ganglion: raster bench {}x{}: clear {:.2f} ms, fill {:.2f} ms, fill+aa {:.2f} ms, replay {:.2f} ms, memset {:.2f} ms, 200 glyphs {:.2f} ms (no subpixel {:.2f} ms, blob build {:.2f} ms) (each the mean of 10)", pixel_width, pixel_height, clear_ms, fill_ms, fill_aa_ms, replay_ms, memset_ms, text_ms, text_nosub_ms, blob_ms));
        }
    }
    auto t_convert = MonotonicTime::now();
    h.last_raster_ms = (t_convert - t_raster).to_nanoseconds() / 1e6;
    ++h.frames_painted;
    h.paint_requested = false;
    h.last_display_list = display_list;
    h.last_tree = visual_context_tree;
    h.last_scroll_state = scroll_state;
    h.dirty = damage;
    // BGRA premultiplied -> RGBA of the painted rect for the host's ImageData (page pixels are opaque).
    if (damage.is_empty()) {
        h.rgba.resize(4);
        return h.rgba.data();
    }
    convert_rect_to_rgba(h, damage);
    h.last_convert_ms = (MonotonicTime::now() - t_convert).to_nanoseconds() / 1e6;
    return h.rgba.data();
}

// --- The compositor (Layers.h, docs/compositor.md) --------------------------------------------------------------
// 0: flat frames (the reference path), 1: layers with backdrop filters rastered here, 2: layers with blur/saturate
// backdrop filters left to the carapace's GPU. Switching sends every layer again.
GANGLION_EXPORT void ganglion_set_compositor(int mode)
{
    auto next = mode == 2 ? Ganglion::Layers::Mode::HostBackdrop : mode == 1 ? Ganglion::Layers::Mode::Layers : Ganglion::Layers::Mode::Flat;
    if (next == Ganglion::Layers::mode())
        return;
    Ganglion::Layers::set_mode(next);
    Ganglion::Layers::reset();
    auto& h = host();
    h.layers_reset = true;
    h.paint_requested = true;
    h.last_display_list = nullptr; // the flat path's next paint starts from a full frame too
}
GANGLION_EXPORT void ganglion_set_raw_tiles(int raw) { Ganglion::Layers::set_raw_tiles(raw != 0); }
GANGLION_EXPORT int ganglion_compositor(void) { return static_cast<int>(Ganglion::Layers::mode()); }
// The last layered paint's layer tree as JSON (UTF-8, not NUL-terminated) and its length.
GANGLION_EXPORT char const* ganglion_layers_json(void) { return Ganglion::Layers::frame_json().characters_without_null_termination(); }
GANGLION_EXPORT int ganglion_layers_json_length(void) { return static_cast<int>(Ganglion::Layers::frame_json().length()); }
// The dirty tile parts of the last layered paint: their pixels (RGBA, not premultiplied; the rect is in the JSON).
GANGLION_EXPORT int ganglion_layers_dirty_count(void) { return static_cast<int>(Ganglion::Layers::dirty_tiles().size()); }
GANGLION_EXPORT uint8_t const* ganglion_layers_dirty_pixels(int index)
{
    auto const& tiles = Ganglion::Layers::dirty_tiles();
    if (index < 0 || static_cast<size_t>(index) >= tiles.size())
        return nullptr;
    return tiles[index].rgba.data();
}
// 0 raster ms, 1 split ms, 2 layers, 3 tiles kept, 4 tiles rastered, 5 bytes, 6 flattened (over budget), 7 tiles of a
// scroll layer rastered where they are on screen.
// Replay profiling (patch 0085): per command type, the ms its painter calls took since the last take, as text
// "type:ms:count;..." (types with a count only); the C++ side of the profile is off until enabled.
GANGLION_EXPORT void ganglion_replay_profile_enable(int on)
{
    Compositing::RustFFI::display_list_replay_profile_enable(on != 0);
}
GANGLION_EXPORT char const* ganglion_replay_profile_take(void)
{
    static ByteString text;
    double ms[64];
    u32 counts[64];
    Compositing::RustFFI::display_list_replay_profile_take(ms, counts);
    StringBuilder b;
    for (int i = 0; i < 64; ++i)
        if (counts[i])
            b.appendff("{}:{:.3}:{};", i, ms[i], counts[i]);
    text = b.to_byte_string();
    return text.characters();
}

GANGLION_EXPORT double ganglion_layers_stats(int which)
{
    auto const& s = Ganglion::Layers::last_stats();
    switch (which) {
    case 9: return host().last_layout_ms;
    case 10: return host().last_record_ms;
    case 0: return s.raster_ms;
    case 1: return s.split_ms;
    case 2: return s.layers;
    case 3: return s.tiles;
    case 4: return s.tiles_rastered;
    case 5: return static_cast<double>(s.bytes);
    case 6: return s.flattened ? 1 : 0;
    case 7: return s.tiles_rastered_visible;
    case 8: return s.convert_ms;
    }
    return 0;
}

// The rect the last paint changed (device pixels), and the move the host applies to its copy of the frame
// before putting that rect: (0, 0) unless the paint was a scroll blit.
GANGLION_EXPORT int ganglion_dirty_x(void) { return host().dirty.x(); }
GANGLION_EXPORT int ganglion_dirty_y(void) { return host().dirty.y(); }
GANGLION_EXPORT int ganglion_dirty_width(void) { return host().dirty.width(); }
GANGLION_EXPORT int ganglion_dirty_height(void) { return host().dirty.height(); }
GANGLION_EXPORT int ganglion_blit_dx(void) { return host().blit.x(); }
GANGLION_EXPORT int ganglion_blit_dy(void) { return host().blit.y(); }
GANGLION_EXPORT double ganglion_paint_counts(int which)
{
    auto& h = host();
    switch (which) {
    case 0: return static_cast<double>(h.frames_painted);
    case 1: return static_cast<double>(h.rasters);
    case 2: return static_cast<double>(h.full_rasters);
    case 3: return static_cast<double>(h.blits);
    case 4: return h.last_layout_ms;
    case 5: return h.last_record_ms;
    case 6: return h.last_raster_ms;
    case 7: return h.last_convert_ms;
    }
    return 0;
}

// The whole frame as RGBA (width * height * 4), for a host that wants all of it (tests, a fresh canvas).
GANGLION_EXPORT uint8_t const* ganglion_frame_rgba(void)
{
    auto& h = host();
    if (!h.frame)
        return nullptr;
    convert_rect_to_rgba(h, { 0, 0, h.frame->width(), h.frame->height() });
    return h.rgba.data();
}

// "Chitin <build id>": what this engine says it is (docs/provenance.md). The build id is the one the
// stamp wrote, or "unstamped" for a development build.
GANGLION_EXPORT char const* ganglion_fingerprint(void)
{
    static char buffer[64];
    auto id = provenance_build_id();
    __builtin_memcpy(buffer, "Chitin ", 7);
    __builtin_memcpy(buffer + 7, id.characters_without_null_termination(), id.length());
    buffer[7 + id.length()] = 0;
    return buffer;
}

GANGLION_EXPORT int ganglion_frame_width(void) { return static_cast<int>(host().width * host().dpr); }
GANGLION_EXPORT int ganglion_frame_height(void) { return static_cast<int>(host().height * host().dpr); }

// The pointer the next input comes from (Pointer Events): type 0 mouse, 1 pen, 2 touch; its pointerId, contact size in CSS
// pixels, pressure (negative: not reported) and whether it is primary. A mouse is pointerId 1, as in Chrome.
GANGLION_EXPORT void ganglion_pointer(int type, int id, double width, double height, double pressure, bool is_primary)
{
    using P = Web::UIEvents::PointerEvent;
    P::PlatformPointer pointer;
    pointer.type = type == 2 ? P::PlatformPointerType::Touch : type == 1 ? P::PlatformPointerType::Pen : P::PlatformPointerType::Mouse;
    pointer.id = type == 0 ? 1 : id;
    pointer.width = width > 0 ? width : 1;
    pointer.height = height > 0 ? height : 1;
    pointer.pressure = static_cast<float>(pressure);
    pointer.is_primary = is_primary;
    P::set_platform_pointer(pointer);
}

// The click count of a press (UIEvents detail): a press of the same button within 500 ms and 4 CSS pixels of the last one
// continues its count, as the platforms' double-click settings do by default.
static int click_count_for_press(double x, double y, int button)
{
    static double last_ms = -1e9, last_x = 0, last_y = 0;
    static int last_button = -1, count = 0;
    auto now = static_cast<double>(MonotonicTime::now().milliseconds());
    if (button == last_button && now - last_ms <= 500 && __builtin_fabs(x - last_x) <= 4 && __builtin_fabs(y - last_y) <= 4)
        count++;
    else
        count = 1;
    last_ms = now;
    last_x = x;
    last_y = y;
    last_button = button;
    return count;
}

// Input: kind 0 move, 1 down, 2 up; positions in CSS pixels.
GANGLION_EXPORT void ganglion_mouse(int kind, double x, double y, int button, int buttons, int modifiers)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    Web::DevicePixelPoint position { static_cast<int>(x * h.dpr), static_cast<int>(y * h.dpr) };
    switch (kind) {
    case 0:
        h.page->handle_mousemove(position, position, buttons, modifiers);
        break;
    case 1:
        h.page->handle_mousedown(position, position, button, buttons, modifiers, click_count_for_press(x, y, button));
        break;
    case 2:
        h.page->handle_mouseup(position, position, button, buttons, modifiers);
        break;
    }
    h.event_loop_manager.pump();
}

// A mouse event with the host's screen position, separate from the client position: movementX/Y are the difference of screen
// positions (EventHandler::compute_mouse_event_movement), so under the pointer lock the carapace passes the host's accumulated
// movement as the screen position while the client position stays where the lock began, as in Chrome.
GANGLION_EXPORT void ganglion_mouse_screen(int kind, double x, double y, double screen_x, double screen_y, int button, int buttons, int modifiers)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    Web::DevicePixelPoint position { static_cast<int>(x * h.dpr), static_cast<int>(y * h.dpr) };
    Web::DevicePixelPoint screen { static_cast<int>(screen_x * h.dpr), static_cast<int>(screen_y * h.dpr) };
    switch (kind) {
    case 0:
        h.page->handle_mousemove(position, screen, buttons, modifiers);
        break;
    case 1:
        h.page->handle_mousedown(position, screen, button, buttons, modifiers, click_count_for_press(x, y, button));
        break;
    case 2:
        h.page->handle_mouseup(position, screen, button, buttons, modifiers);
        break;
    }
    h.event_loop_manager.pump();
}

// The carapace's answer to ganglion_host_fullscreen: the host's fullscreen began (1), was refused or ended (0).
GANGLION_EXPORT void ganglion_fullscreen_changed(int fullscreen)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    if (fullscreen)
        h.page->set_viewport_is_fullscreen(Web::ViewportIsFullscreen::Yes);
    else if (h.page->viewport_is_fullscreen() == Web::ViewportIsFullscreen::Yes)
        h.page->set_viewport_is_fullscreen(Web::ViewportIsFullscreen::No);
    else
        h.page->did_deny_fullscreen_window();
    h.event_loop_manager.pump();
}

// The carapace's answer to ganglion_host_pointer_lock: error 0 locked, 1 refused (NotAllowedError), 2 unsupported options;
// kind 1 is the host's lock ending without the page (Esc, focus lost).
GANGLION_EXPORT void ganglion_pointer_lock_result(int kind, int error)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return;
    auto document = h.traversable->active_document();
    if (!document)
        return;
    if (kind == 1)
        document->did_unlock_pointer();
    else
        document->did_lock_pointer(error);
    h.event_loop_manager.pump();
}

// Gamepads from the host's navigator.getGamepads() (the carapace polls them): the registry gets a description and the state slots
// a shared buffer of their own, as WebContent's UI process gives it, so getGamepads and the events are LibWeb's own.
static Web::Gamepad::SharedGamepadStateBuffer* g_gamepad_slots;
static Array<Web::Gamepad::GamepadHandle, Web::Gamepad::MAX_SHARED_GAMEPADS> g_gamepad_slot_handles {};

static Web::Gamepad::SharedGamepadStateBuffer* gamepad_slots()
{
    if (g_gamepad_slots)
        return g_gamepad_slots;
    auto buffer = MUST(Core::AnonymousBuffer::create_with_size(sizeof(Web::Gamepad::SharedGamepadStateBuffer)));
    // A fresh anonymous buffer is zeroed: every slot's sequence is 0 (even, not being written) and empty.
    g_gamepad_slots = reinterpret_cast<Web::Gamepad::SharedGamepadStateBuffer*>(buffer.data<void>());
    Web::Gamepad::GamepadRegistry::the().set_shared_state_buffer(MUST(Web::Gamepad::GamepadStateBuffer::create(buffer)));
    return g_gamepad_slots;
}

static void dispatch_gamepad_states()
{
    auto& h = host();
    for (auto const& state : Web::Gamepad::GamepadRegistry::the().take_changed_shared_states())
        h.page->handle_gamepad_updated(state);
}

// `standard` is the host's mapping == "standard"; axes are -32768..32767, buttons 0..32767 (the host's value times 32767).
GANGLION_EXPORT int ganglion_gamepad_connected(uint32_t handle, char const* id, size_t id_length, int standard, int axis_count, int button_count)
{
    auto& h = host();
    if (!h.page_ready || handle == 0)
        return 0;
    gamepad_slots();
    Web::Gamepad::GamepadDescription description;
    description.handle = handle;
    description.id = MUST(String::from_utf8(StringView { id, id_length }));
    description.has_standard_mapping = standard != 0;
    description.supports_dual_rumble = true;
    for (int i = 0; i < min(axis_count, static_cast<int>(Web::Gamepad::MAX_SHARED_GAMEPAD_AXES)); ++i)
        description.axes.append({ standard ? Optional<u32> { static_cast<u32>(i) } : Optional<u32> {}, -32768, 32767 });
    for (int i = 0; i < min(button_count, static_cast<int>(Web::Gamepad::MAX_SHARED_GAMEPAD_BUTTONS)); ++i)
        description.buttons.append({ standard ? Optional<u32> { static_cast<u32>(i) } : Optional<u32> {}, 0, 32767 });
    Web::Gamepad::GamepadRegistry::the().gamepad_connected(description);
    h.page->handle_gamepad_connected(description);
    dispatch_gamepad_states();
    h.event_loop_manager.pump();
    return 1;
}

GANGLION_EXPORT void ganglion_gamepad_state(uint32_t handle, int16_t const* axes, int axis_count, int16_t const* buttons, int button_count)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    auto* slots = gamepad_slots();
    size_t slot = Web::Gamepad::MAX_SHARED_GAMEPADS;
    for (size_t i = 0; i < g_gamepad_slot_handles.size(); ++i) {
        if (g_gamepad_slot_handles[i] == handle) {
            slot = i;
            break;
        }
        if (slot == Web::Gamepad::MAX_SHARED_GAMEPADS && g_gamepad_slot_handles[i] == 0)
            slot = i;
    }
    if (slot == Web::Gamepad::MAX_SHARED_GAMEPADS)
        return;
    g_gamepad_slot_handles[slot] = handle;
    Web::Gamepad::GamepadState state;
    state.handle = handle;
    for (int i = 0; i < min(axis_count, static_cast<int>(Web::Gamepad::MAX_SHARED_GAMEPAD_AXES)); ++i)
        state.axis_values.append(axes[i]);
    for (int i = 0; i < min(button_count, static_cast<int>(Web::Gamepad::MAX_SHARED_GAMEPAD_BUTTONS)); ++i)
        state.button_values.append(buttons[i]);
    Web::Gamepad::publish_gamepad_state_to_slot(slots->slots[slot], state);
    dispatch_gamepad_states();
    h.event_loop_manager.pump();
}

GANGLION_EXPORT void ganglion_gamepad_disconnected(uint32_t handle)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    for (size_t i = 0; i < g_gamepad_slot_handles.size(); ++i) {
        if (g_gamepad_slot_handles[i] == handle) {
            g_gamepad_slot_handles[i] = 0;
            if (g_gamepad_slots)
                Web::Gamepad::clear_gamepad_state_slot(g_gamepad_slots->slots[i]);
        }
    }
    Web::Gamepad::GamepadRegistry::the().gamepad_disconnected(handle);
    h.page->handle_gamepad_disconnected(handle);
    h.event_loop_manager.pump();
}

// Whether a wheel at `at` by (dx, dy), device px, has something to scroll in this document: the scroller the last frame's
// wheel targets put under the point, or one around it, can still move that way (Chrome's scroll chaining; the carapace
// gives a wheel nothing here can use to the parent page, docs/scroll.md C1). Unknown (no frame yet): true.
static bool wheel_can_scroll(Host& h, Gfx::FloatPoint at, float dx, float dy)
{
    if (!h.last_display_list || !h.last_tree.has_value())
        return true;
    auto async = Compositing::async_scrolling_state_from_display_list(*h.last_display_list);
    u32 node = 0;
    for (auto const& target : async.wheel_hit_test_targets) {
        auto r = h.last_tree->transform_rect_to_viewport(target.context.spatial, target.rect, h.last_scroll_state);
        if (r.contains(at) && target.target_node_id.has_value())
            node = target.target_node_id->scroll_node_index.value();
    }
    if (node == 0) {
        for (auto const& n : async.scroll_nodes)
            if (n.is_viewport)
                node = n.node_id.scroll_node_index.value();
    }
    for (size_t guard = 0; node != 0 && guard < 64; ++guard) {
        Compositing::AsyncScrollNode const* found = nullptr;
        for (auto const& n : async.scroll_nodes)
            if (n.node_id.scroll_node_index.value() == node)
                found = &n;
        if (!found)
            return false;
        auto position = -h.last_scroll_state.device_offset_for_index(found->node_id.scroll_node_index);
        auto moves = [](float p, float d, float lo, float hi) { return d != 0 && clamp(p + d, lo, hi) != p; };
        if ((found->can_be_wheel_scrolled_horizontally && moves(position.x(), dx, found->min_scroll_offset.x(), found->max_scroll_offset.x()))
            || (found->can_be_wheel_scrolled_vertically && moves(position.y(), dy, found->min_scroll_offset.y(), found->max_scroll_offset.y())))
            return true;
        node = found->parent_node_id.has_value() ? found->parent_node_id->scroll_node_index.value() : 0;
    }
    return false;
}

// Returns 1 when the wheel was used here (something scrolled, or a listener cancelled it), 0 when nothing in this
// document could scroll that way (the carapace hands it to the parent page).
GANGLION_EXPORT int ganglion_wheel(double x, double y, double delta_x, double delta_y)
{
    auto& h = host();
    if (!h.page_ready)
        return 1;
    Web::DevicePixelPoint position { static_cast<int>(x * h.dpr), static_cast<int>(y * h.dpr) };
    bool can = wheel_can_scroll(h, { static_cast<float>(x * h.dpr), static_cast<float>(y * h.dpr) }, static_cast<float>(delta_x * h.dpr), static_cast<float>(delta_y * h.dpr));
    auto before = h.traversable->viewport_scroll_offset();
    auto result = h.page->handle_mousewheel(position, position, 0, 0, 0, delta_x * h.dpr, delta_y * h.dpr, Web::WheelDeltaPrecision::Precise);
    auto after = h.traversable->viewport_scroll_offset();
    if (g_debug & 1)
        host_log(ByteString::formatted("ganglion: wheel {},{} at {},{}: result {} offset {} -> {}", delta_x, delta_y, x, y, to_underlying(result), before, after));
    // A wheel step that continues a latched gesture (one within 500 ms of the last at the same spot,
    // Compositing::user_scroll_settle_delay) goes through EventHandler's latched path, whose viewport scroll
    // (LocalNavigable::scroll_viewport_by_delta) comes back "accepted" without moving the viewport in a build
    // without a compositor; the first step of a gesture scrolls. Until that path is understood, a step the
    // page accepted but did not scroll by scrolls the viewport directly, as ganglion_scroll_by does.
    // Not when nothing here can scroll that way: an overflow: hidden viewport is not scrolled by a wheel (C1).
    if (can && result == Web::EventResult::Accepted && after == before && (delta_x != 0 || delta_y != 0))
        h.traversable->perform_scroll_of_viewport_scrolling_box({ before.x() + Web::CSSPixels::nearest_value_for(delta_x), before.y() + Web::CSSPixels::nearest_value_for(delta_y) });
    h.paint_requested = true;
    h.event_loop_manager.pump();
    return can || result == Web::EventResult::Cancelled ? 1 : 0;
}

// Threaded scroll (docs/compositor.md): the carapace already scrolled scroll node `node` by (delta_x, delta_y) CSS
// pixels for a wheel at (x, y) and showed it. The page's wheel listeners (passive: the carapace keeps wheels over
// non-passive ones on the main-thread path) get the wheel with its default action already done, the node scrolls by the
// same delta here (so a script's scrollTo in between composes with it), and its scroll/scrollend events follow as for
// any user scroll. `seq` is the carapace's number for this scroll; the next layered frame reports the last one applied
// per node, which is how the carapace knows when the engine's offset includes it.
GANGLION_EXPORT void ganglion_scroll_sync(uint32_t seq, uint32_t node, double x, double y, double delta_x, double delta_y)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return;
    Web::DevicePixelPoint position { static_cast<int>(x * h.dpr), static_cast<int>(y * h.dpr) };
    h.page->handle_mousewheel(position, position, 0, 0, 0, delta_x * h.dpr, delta_y * h.dpr, Web::WheelDeltaPrecision::Precise, Web::ScrollGesturePhase::None, true);
    bool scrolled = false;
    if (h.last_display_list) {
        auto async = Compositing::async_scrolling_state_from_display_list(*h.last_display_list);
        for (auto const& candidate : async.scroll_nodes) {
            if (candidate.node_id.scroll_node_index.value() != node)
                continue;
            if (auto* layout_node = h.traversable->layout_node_for_async_scroll_node_stable_id(candidate.stable_node_id)) {
                Web::Painting::scroll_by(*layout_node, delta_x, delta_y);
                scrolled = true;
            } else if (candidate.is_viewport) {
                auto offset = h.traversable->viewport_scroll_offset();
                h.traversable->perform_scroll_of_viewport_scrolling_box({ offset.x() + Web::CSSPixels::nearest_value_for(delta_x), offset.y() + Web::CSSPixels::nearest_value_for(delta_y) });
                scrolled = true;
            }
            break;
        }
    }
    if (g_debug & 1)
        host_log(ByteString::formatted("ganglion: scroll sync {} node {} by {},{}: {}", seq, node, delta_x, delta_y, scrolled ? "applied" : "no such node"));
    Ganglion::Layers::set_host_scroll_seq(node, seq);
    h.paint_requested = true;
    h.event_loop_manager.pump();
}

// Scrolls the viewport by a delta in CSS pixels.
GANGLION_EXPORT void ganglion_scroll_by(double delta_x, double delta_y)
{
    auto& h = host();
    if (!h.page_ready || !h.traversable)
        return;
    auto offset = h.traversable->viewport_scroll_offset();
    h.traversable->perform_scroll_of_viewport_scrolling_box({ offset.x() + Web::CSSPixels::nearest_value_for(delta_x), offset.y() + Web::CSSPixels::nearest_value_for(delta_y) });
    h.paint_requested = true;
    h.event_loop_manager.pump();
}

// The page's microtasks that followed the last outermost classic script have run: document.currentScript is null again.
GANGLION_EXPORT void ganglion_microtask_turn_end(void)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    Web::HTML::HTMLScriptElement::release_current_script_after_microtasks(*active_document());
    // IndexedDB transactions stay active for these microtasks (Algorithms.cpp, patch 0024).
    Web::IndexedDB::run_deferred_after_embedder_microtasks();
    h.event_loop_manager.pump();
}

GANGLION_EXPORT void ganglion_key(int kind, int key_code, int modifiers, uint32_t code_point)
{
    auto& h = host();
    if (!h.page_ready)
        return;
    if (kind == 0)
        h.page->handle_keydown(static_cast<Web::UIEvents::KeyCode>(key_code), modifiers, code_point, false, true);
    else
        h.page->handle_keyup(static_cast<Web::UIEvents::KeyCode>(key_code), modifiers, code_point, false);
    h.event_loop_manager.pump();
}

// A task boundary: no engine frame is on the stack, so a collection sees every live cell through roots.
GANGLION_EXPORT bool ganglion_collect(bool force)
{
    if (!s_host || !s_host->page_ready)
        return false;
    auto& heap = GC::Heap::the();
    if (force) {
        heap.collect_garbage();
        return true;
    }
    return heap.collect_garbage_if_pending();
}

// The depth of the JavaScript execution context stack (0 between tasks). A debugging aid; it changes nothing.
GANGLION_EXPORT int ganglion_debug_context_depth(void)
{
    if (!s_vm_ready)
        return 0;
    return static_cast<int>(Web::Bindings::main_thread_vm().execution_context_stack().size());
}

// The JavaScript execution context stack as text, one line per entry from the bottom: its realm (the URL of the
// realm's document, or "-"), whether it has a ScriptOrModule (S script, M module, - none), whether it is that realm's
// realm execution context (R), and its function's name. A debugging aid for unbalanced pushes (docs/captcha.md);
// it changes nothing.
GANGLION_EXPORT char const* ganglion_debug_context_stack(void)
{
    static ByteString text;
    if (!s_vm_ready)
        return "";
    StringBuilder builder;
    auto& vm = Web::Bindings::main_thread_vm();
    builder.appendff("depth {} (top first)\n", vm.execution_context_stack().size());
    size_t i = 0;
    vm.for_each_execution_context_top_to_bottom([&](JS::ExecutionContext const& context_ref) {
        auto const* context = &context_ref;
        ByteString where = "-";
        bool is_realm_context = false;
        if (context->realm) {
            if (auto const* window = Web::HTML::window_from_global_object(context->realm->global_object()))
                where = window->associated_document().url().serialize().to_byte_string();
            if (context->realm->host_defined())
                is_realm_context = &Web::HTML::principal_realm_settings_object(*context->realm).realm_execution_context() == context;
        }
        char kind = context->script_or_module.has<Empty>() ? '-' : (context->script_or_module.has<GC::Ref<JS::Module>>() ? 'M' : 'S');
        ByteString name = "";
        if (context->function)
            name = context->function->name_for_call_stack().to_byte_string();
        builder.appendff("{} {} {}{} {}\n", i++, where, kind, is_realm_context ? " R" : "", name);
        return true;
    });
    text = builder.to_byte_string();
    return text.characters();
}

GANGLION_EXPORT void ganglion_debug(int flags)
{
    g_debug = flags;
    Ganglion::Layers::set_debug(flags & 32);
}

GANGLION_EXPORT uint32_t ganglion_heap_bytes(void)
{
    return 0;
}
