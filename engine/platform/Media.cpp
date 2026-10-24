// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// See Media.h. The message handlers follow Ladybird's Services/MediaServer (ConnectionFromClient.cpp and
// PlaybackSession.cpp, BSD-2-Clause); the playback pipeline is our own, single-threaded and driven by the engine's
// event loop, since a segment Worker has no threads: LibMedia's PlaybackManager decodes on threads of its own.
//
// What it does now: a media resource in WebM (demuxed as it arrives: a read of data that has not come answers at once,
// patch 0035, and the session reads again when it has) and MSE source
// buffers (WebM and fMP4), video decoded by the host (VP8, VP9, AV1, H.264, H.265: whatever its WebCodecs decodes),
// and audio decoded by the host (its AudioDecoder) and played by the carapace's AudioWorklet, whose output position
// drives the media clock while it plays (a monotonic clock otherwise: no audio, or an output that is not running).

#include "Media.h"
#include <AK/HashMap.h>
#include <AK/NeverDestroyed.h>
#include <AK/QuickSort.h>
#include <LibCore/EventLoop.h>
#include <LibCore/Timer.h>
#include <LibIPC/ConnectionFromClient.h>
#include <LibIPC/TransportSocket.h>
#include <LibMedia/Audio/NullPlaybackStream.h>
#include <LibMedia/CodecParameters.h>
#include <LibMedia/DecoderRegistry.h>
#include <LibMedia/Demuxer.h>
#include <LibMedia/DemuxerRegistry.h>
#include <LibMedia/IncrementallyPopulatedStream.h>
#include <LibMedia/MediaSourceExtensions/ISOBMFFByteStreamParser.h>
#include <LibMedia/MediaSourceExtensions/SourceBufferDemuxer.h>
#include <LibMedia/MediaSourceExtensions/SourceBufferProcessor.h>
#include <LibMedia/MediaSourceExtensions/WebMByteStreamParser.h>
#include <LibMedia/MediaSupport.h>
#include <LibMedia/MediaTime.h>
#include <LibMedia/VideoFrame.h>
#include <LibMedia/VideoFramePool.h>
#include <LibMediaClient/Client.h>
#include <LibMediaClient/RemotePlaybackManager.h>
#include <MediaServer/MediaClientEndpoint.h>
#include <MediaServer/MediaServerEndpoint.h>

#define GANGLION_EXPORT extern "C" __attribute__((used, visibility("default")))

extern "C" {
void ganglion_host_log(char const* text, size_t length);
void ganglion_host_request_frame(void);
// kind 0 video, 1 audio. Returns 0 when the host refuses the configuration at once.
int ganglion_host_media_decoder_create(uint32_t id, int kind, char const* codec, size_t codec_length, uint8_t const* description, size_t description_length, uint32_t width, uint32_t height, uint32_t sample_rate, uint32_t channels);
void ganglion_host_media_decode(uint32_t id, uint8_t const* data, size_t length, double timestamp_us, double duration_us, int key);
void ganglion_host_media_decoder_flush(uint32_t id);
void ganglion_host_media_decoder_close(uint32_t id);
// An audio decoder's output (kind 1): whether it plays, at which volume and rate; sync_us >= 0 tells the output where
// the media clock is when the output does not lead it, and the output drops what lies before that time.
void ganglion_host_media_audio_control(uint32_t id, int playing, double volume, double rate, double sync_us);
// Web Audio's output (an AudioContext's destination, through LibMedia's null stream on Emscripten): a stream id from open
// (0: refused), each period pulled as interleaved floats, whether it plays and at what volume, its end.
uint32_t ganglion_host_webaudio_open(uint32_t sample_rate, uint32_t channels);
void ganglion_host_webaudio_write(uint32_t id, float const* interleaved, size_t frames);
void ganglion_host_webaudio_control(uint32_t id, int playing, double volume);
void ganglion_host_webaudio_close(uint32_t id);
}

namespace Ganglion {

namespace {

namespace Commands = Media::MediaSourceExtensions::Commands;

void log(ByteString const& text)
{
    ganglion_host_log(text.characters(), text.length());
}

// --- What the host's WebCodecs decodes (glue: a probe with isConfigSupported before the first page) ------------

struct HostCodecs {
    HashTable<ByteString> families;
    bool probed { false };
};

HostCodecs& host_codecs()
{
    static NeverDestroyed<HostCodecs> s;
    return *s;
}

StringView family_of(Media::CodecID id)
{
    switch (id) {
    case Media::CodecID::VP8: return "vp8"sv;
    case Media::CodecID::VP9: return "vp9"sv;
    case Media::CodecID::AV1: return "av1"sv;
    case Media::CodecID::H264: return "h264"sv;
    case Media::CodecID::H265: return "h265"sv;
    case Media::CodecID::Opus: return "opus"sv;
    case Media::CodecID::Vorbis: return "vorbis"sv;
    case Media::CodecID::AAC: return "aac"sv;
    case Media::CodecID::FLAC: return "flac"sv;
    case Media::CodecID::MP3: return "mp3"sv;
    default: return {};
    }
}

// The codec string WebCodecs is configured with, from the codec and its configuration record.
ByteString webcodecs_codec_string(Media::CodecID id, ReadonlyBytes config)
{
    switch (id) {
    case Media::CodecID::VP8:
        return "vp8";
    case Media::CodecID::VP9:
        // A vpcC record (fMP4) names the profile, level and depth; WebM carries none, and Chrome decodes any
        // profile 0 stream with the generic string.
        if (config.size() >= 8 && config[0] == 1)
            return ByteString::formatted("vp09.{:02}.{:02}.{:02}", config[4], config[5], config[6] >> 4);
        return "vp09.00.41.08";
    case Media::CodecID::AV1:
        if (config.size() >= 4 && (config[0] & 0x7f) == 1) {
            auto profile = config[1] >> 5;
            auto level = config[1] & 0x1f;
            auto tier = (config[2] >> 7) ? 'H' : 'M';
            auto high_bitdepth = (config[2] >> 6) & 1;
            auto twelve_bit = (config[2] >> 5) & 1;
            auto depth = high_bitdepth ? (twelve_bit ? 12 : 10) : 8;
            return ByteString::formatted("av01.{}.{:02}{}.{:02}", profile, level, tier, depth);
        }
        return "av01.0.08M.08";
    case Media::CodecID::H264:
        if (config.size() >= 4)
            return ByteString::formatted("avc1.{:02x}{:02x}{:02x}", config[1], config[2], config[3]);
        return "avc1.42E01E";
    case Media::CodecID::H265:
        return "hvc1.1.6.L93.B0";
    case Media::CodecID::Opus: return "opus";
    case Media::CodecID::Vorbis: return "vorbis";
    case Media::CodecID::FLAC: return "flac";
    case Media::CodecID::MP3: return "mp3";
    case Media::CodecID::AAC: {
        u8 object_type = config.size() >= 1 ? (config[0] >> 3) : 2;
        if (object_type == 0)
            object_type = 2;
        return ByteString::formatted("mp4a.40.{}", object_type);
    }
    default:
        return {};
    }
}

// --- Decoders on the host ---------------------------------------------------------------------------------------

struct HostDecoderClient {
    AK_ALLOC_WITH_KMALLOC;
    Function<void(NonnullRefPtr<Media::VideoFrame>)> on_video_frame;
    Function<void()> on_flushed;
    Function<void(StringView)> on_error;
    // Audio: decoded through end_us; the output's position (what is heard now), how much it holds, its flags.
    Function<void(AK::Duration)> on_audio_decoded;
    Function<void(AK::Duration played, AK::Duration queued, u32 flags)> on_audio_progress;
    Media::CodingIndependentCodePoints cicp;
    Vector<NonnullRefPtr<Media::VideoFramePool>> pools;
};

HashMap<u32, HostDecoderClient*>& decoders()
{
    static NeverDestroyed<HashMap<u32, HostDecoderClient*>> s;
    return *s;
}

u32 s_next_decoder_id { 1 };

// --- Presentation ---------------------------------------------------------------------------------------------

class FrameSink final : public Media::VideoSink {
public:
    virtual ErrorOr<void> connect_input(NonnullRefPtr<Media::VideoProducer> const&) override { return {}; }
    virtual void disconnect_input(NonnullRefPtr<Media::VideoProducer> const&) override { }
    virtual void seek(AK::Duration, Media::InvalidateHeldData) override { }
    virtual void set_time_reader(Media::MediaTimeReader) override { }
    virtual void set_state_change_handler(Media::PipelineStateChangeHandler) override { }
    virtual void set_resize_handler(Media::PipelineResizeHandler) override { }
    virtual RefPtr<Media::VideoFrame> current_frame() const override { return m_frame; }

    void set_frame(RefPtr<Media::VideoFrame> frame) { m_frame = move(frame); }

private:
    RefPtr<Media::VideoFrame> m_frame;
};

HashMap<Media::VideoSinkHandle, NonnullRefPtr<FrameSink>>& sinks()
{
    static NeverDestroyed<HashMap<Media::VideoSinkHandle, NonnullRefPtr<FrameSink>>> s;
    return *s;
}

bool s_frames_changed { false };

void frames_changed()
{
    s_frames_changed = true;
    ganglion_host_request_frame();
}

class Server;

// --- One media element's playback --------------------------------------------------------------------------------

class Session {
    AK_MAKE_NONCOPYABLE(Session);
    AK_MAKE_NONMOVABLE(Session);

public:
    AK_ALLOC_WITH_KMALLOC;

    Session(Server&, u64 id);
    ~Session();

    void add_media_stream_source(u64 stream_id, NonnullRefPtr<Media::IncrementallyPopulatedStream>, u64 received);
    void stream_completed(u64 stream_id);
    void stream_data_arrived(u64 stream_id, u64 received);
    void start();
    void play();
    void pause();
    void seek(u64 seek_request_id, AK::Duration, Media::SeekMode);
    void set_playback_rate(float);
    void set_duration(AK::Duration duration) { m_duration = duration; m_duration_was_provided = true; }
    void set_audio_track_enabled(u64 seek_request_id, Media::Track const&, bool enabled);
    void set_volume(double);
    void reserve_video_sink(u64 seek_request_id, Media::Track const&, Media::VideoSinkHandle);
    void disable_video_sink(u64 seek_request_id, Media::VideoSinkHandle);

    void create_source_buffer(u64 id);
    void destroy_source_buffer(u64 id) { m_source_buffers.remove(id); }
    void set_source_buffer_content_type(u64 id, StringView subtype);
    void add_to_source_buffer_input(u64 id, ReadonlyBytes data)
    {
        if (auto* sb = find_source_buffer(id))
            sb->pending_append_data.append(data);
    }
    void run_source_buffer_append(u64 id, u64 append_generation);
    void remove_source_buffer_coded_frames(u64 id, AK::Duration start, AK::Duration end);
    void run_source_buffer_coded_frame_eviction(u64 id, size_t new_data_size);
    Optional<Media::MediaSourceExtensions::PublishedState> source_buffer_published_state(u64 id);
    void run_source_buffer_command(u64 id, Media::MediaSourceExtensions::Command);
    void set_source_buffers_ended(bool ended) { m_source_buffers_ended = ended; }

private:
    struct Source {
        NonnullRefPtr<Media::Demuxer> demuxer;
        Optional<u64> stream_id;
        bool is_source_buffer { false };
        Vector<Media::Track> audio_tracks;
        Vector<Media::Track> video_tracks;
        Media::DemuxerScanState reported_scan_state;
    };

    struct VideoOut {
        AK_ALLOC_WITH_KMALLOC;
        Media::Track track;
        Media::VideoSinkHandle handle;
        size_t source_index { 0 };
        NonnullRefPtr<FrameSink> sink;
        u32 decoder_id { 0 };
        OwnPtr<HostDecoderClient> client;
        Optional<ByteBuffer> codec_configuration;
        bool decoder_failed { false };
        Vector<NonnullRefPtr<Media::VideoFrame>> queue;
        u32 in_flight { 0 };
        bool demux_ended { false };
        bool drained { false };
        Optional<AK::Duration> seek_target;
        Optional<AK::Duration> demuxer_seek; // a seek of the demuxer that waits for data
        Gfx::Size<u32> reported_size;
    };

    // The enabled audio track: decoded by the host, played by the carapace's AudioWorklet.
    struct AudioOut {
        AK_ALLOC_WITH_KMALLOC;
        Media::Track track;
        size_t source_index { 0 };
        u32 decoder_id { 0 };
        OwnPtr<HostDecoderClient> client;
        Optional<ByteBuffer> codec_configuration;
        bool decoder_failed { false };
        bool demux_ended { false };
        bool drained { false };
        bool any_sent { false };
        bool any_decoded { false };
        AK::Duration sent_until;
        AK::Duration decoded_until;
        Optional<AK::Duration> demuxer_seek;
        // The output's last report.
        bool has_report { false };
        bool running { false };
        bool underrun { false };
        AK::Duration played;
        MonotonicTime reported_at { MonotonicTime::now() };
        // What the output was last told.
        int sent_playing { -1 };
        double sent_volume { -1 };
        double sent_rate { -1 };
        MonotonicTime last_sync { MonotonicTime::now() };
    };

    struct SourceBuffer {
        NonnullRefPtr<Media::MediaSourceExtensions::SourceBufferProcessor> processor;
        ByteBuffer pending_append_data;
        enum class Outcome { Pending, Completed, Failed } append_outcome { Outcome::Pending };
        u64 append_generation { 0 };
        bool has_parser { false };
    };

    void add_source(NonnullRefPtr<Media::Demuxer>, Optional<u64> stream_id, bool is_source_buffer);
    void try_create_demuxer(u64 stream_id, bool closed, u64 received);
    bool seek_demuxer(size_t source_index, Media::Track const&, AK::Duration, Optional<AK::Duration>& pending);
    void wake();
    void report_state();
    void report_scan_states();
    void tick();
    void update();
    AK::Duration media_time() const { return m_reader.current_time(); }
    void anchor_clock(AK::Duration at, bool advancing, Optional<float> rate = {});
    bool all_have_current_frame() const;
    void pump(VideoOut&);
    void pump_all();
    void restart_decoder(VideoOut&);
    void pump_audio();
    void restart_audio_decoder();
    bool audio_ready() const;
    bool audio_done() const;
    bool audio_starved() const;
    bool audio_leads() const;
    void follow_audio();
    void control_audio_output();
    void receive_frame(Media::VideoSinkHandle, NonnullRefPtr<Media::VideoFrame>);
    void present();
    SourceBuffer* find_source_buffer(u64 id)
    {
        auto it = m_source_buffers.find(id);
        return it == m_source_buffers.end() ? nullptr : &it->value;
    }
    Media::MediaSourceExtensions::PublishedState published_state(SourceBuffer const& sb) const
    {
        auto state = sb.processor->published_state();
        state.evictable_bytes = sb.processor->evictable_bytes(media_time());
        return state;
    }

    Server& m_server;
    u64 m_id { 0 };
    Media::MediaTimeWriter m_writer;
    Media::MediaTimeReader m_reader;
    Media::PlaybackState m_state { Media::PlaybackState::Starting };
    Media::AvailableData m_available { Media::AvailableData::None };
    bool m_playing { false };
    bool m_started { false };
    float m_rate { 1.0f };
    u64 m_applied_seek_request_id { 0 };
    AK::Duration m_duration;
    bool m_duration_was_provided { false };
    Optional<AK::Duration> m_seek_target;
    bool m_source_buffers_ended { false };
    double m_volume { 1.0 };
    OwnPtr<AudioOut> m_audio;
    bool m_slewing { false };

    struct Reported {
        Media::PlaybackState state;
        bool playing;
        Media::AvailableData available;
        u64 seek_id;
    };
    Optional<Reported> m_reported;

    Vector<Source> m_sources;
    struct WaitingStream {
        NonnullRefPtr<Media::IncrementallyPopulatedStream> stream;
        u64 tried_at_size { 0 };
    };
    HashMap<u64, WaitingStream> m_waiting_streams;
    HashMap<Media::VideoSinkHandle, NonnullOwnPtr<VideoOut>> m_video_outs;
    HashMap<u64, SourceBuffer> m_source_buffers;
    NonnullRefPtr<Core::Timer> m_timer;
};

// --- The server end of the connection ----------------------------------------------------------------------------

class Server final : public IPC::ConnectionFromClient<MediaClientEndpoint, MediaServerEndpoint> {
    C_OBJECT(Server);

public:
    explicit Server(NonnullOwnPtr<IPC::Transport> transport)
        : IPC::ConnectionFromClient<MediaClientEndpoint, MediaServerEndpoint>(*this, move(transport), 1)
    {
    }

    virtual void die() override
    {
        m_sessions.clear();
        m_streams.clear();
    }

private:
    Session* session(u64 id)
    {
        auto it = m_sessions.find(id);
        return it == m_sessions.end() ? nullptr : it->value.ptr();
    }

    virtual Messages::MediaServer::InitTransportResponse init_transport(int) override { return 0; }
    virtual Messages::MediaServer::ConnectNewClientResponse connect_new_client() override { return OptionalNone {}; }
    virtual Messages::MediaServer::CreateVideoPresentationChannelResponse create_video_presentation_channel() override { return OptionalNone {}; }

    static Media::MediaSupportInfo file_support(String type, String subtype, Optional<String> codecs)
    {
        OrderedHashMap<String, String> parameters;
        if (codecs.has_value())
            parameters.set("codecs"_string, codecs.release_value());
        return Media::file_media_support({ move(type), move(subtype), parameters });
    }

    static Optional<Media::DecoderCapabilities> capabilities_for(StringView codecs)
    {
        Optional<Media::DecoderCapabilities> combined;
        for (auto codec_string : codecs.split_view(',', SplitBehavior::KeepEmpty)) {
            auto codec = Media::parse_codec_parameters_string(codec_string.trim_whitespace());
            if (!codec.has_value())
                return {};
            auto capabilities = Media::decoder_capabilities(*codec);
            if (!capabilities.has_value())
                return {};
            if (!combined.has_value())
                combined = capabilities;
        }
        return combined;
    }

    virtual Messages::MediaServer::QueryFileMediaSupportResponse query_file_media_support(String type, String subtype, Optional<String> codecs) override { return file_support(move(type), move(subtype), move(codecs)); }
    virtual Messages::MediaServer::QueryDecoderCapabilitiesResponse query_decoder_capabilities(String codecs) override { return capabilities_for(codecs); }
    virtual void request_file_media_support(u64 request_id, String type, String subtype, Optional<String> codecs) override { async_file_media_support_reported(request_id, file_support(move(type), move(subtype), move(codecs))); }
    virtual void request_decoder_capabilities(u64 request_id, String codecs) override { async_decoder_capabilities_reported(request_id, capabilities_for(codecs)); }
    virtual void decode_audio_data(u64 request_id, Core::AnonymousBuffer, u32) override
    {
        async_audio_data_decode_failed(request_id, Media::DecoderError::with_description(Media::DecoderErrorCategory::NotImplemented, "decodeAudioData is not available in this build yet"sv));
    }

    virtual void create_media_stream(u64 id) override
    {
        if (m_streams.contains(id))
            return;
        auto stream = Media::IncrementallyPopulatedStream::create_empty();
        // A read of data that has not arrived (patch 0035) asks the element to fetch from there.
        stream->set_data_request_callback([this, id](Optional<u64> offset) { async_media_stream_data_requested(id, offset); });
        m_streams.set(id, move(stream));
    }
    virtual void destroy_media_stream(u64 id) override
    {
        if (auto stream = m_streams.take(id); stream.has_value())
            (*stream)->close();
        m_received.remove(id);
    }
    virtual void add_media_stream_chunk(u64 id, u64 offset, ByteBuffer data) override
    {
        auto stream = m_streams.get(id);
        if (!stream.has_value())
            return;
        (*stream)->add_chunk_at(offset, data.bytes());
        auto received = m_received.get(id).value_or(0) + data.size();
        m_received.set(id, received);
        for (auto& [session_id, session] : m_sessions)
            session->stream_data_arrived(id, received);
    }
    virtual void set_media_stream_expected_size(u64 id, u64 size) override
    {
        if (auto stream = m_streams.get(id); stream.has_value())
            (*stream)->set_expected_size(size);
    }
    virtual void close_media_stream(u64 id) override
    {
        auto stream = m_streams.get(id);
        if (!stream.has_value())
            return;
        (*stream)->close();
        m_closed_streams.set(id);
        for (auto& [session_id, session] : m_sessions)
            session->stream_completed(id);
    }
    virtual void set_media_stream_may_idle(u64 id, bool may_idle) override
    {
        if (auto stream = m_streams.get(id); stream.has_value())
            (*stream)->set_may_idle(may_idle);
    }

    virtual void create_playback_session(u64 id, Media::AudioOutput) override
    {
        if (!m_sessions.contains(id))
            m_sessions.set(id, make<Session>(*this, id));
    }
    virtual void destroy_playback_session(u64 id) override { m_sessions.remove(id); }
    virtual void add_media_stream_source(u64 session_id, u64 stream_id) override
    {
        auto* s = session(session_id);
        auto stream = m_streams.get(stream_id);
        if (!s || !stream.has_value())
            return;
        s->add_media_stream_source(stream_id, NonnullRefPtr(**stream), m_received.get(stream_id).value_or(0));
        if (m_closed_streams.contains(stream_id))
            s->stream_completed(stream_id);
    }
    virtual void start_playback(u64 id) override { if (auto* s = session(id)) s->start(); }
    virtual void play(u64 id) override { if (auto* s = session(id)) s->play(); }
    virtual void pause(u64 id) override { if (auto* s = session(id)) s->pause(); }
    virtual void seek(u64 id, u64 seek_request_id, AK::Duration t, Media::SeekMode mode) override { if (auto* s = session(id)) s->seek(seek_request_id, t, mode); }
    virtual void set_volume(u64 id, double volume) override
    {
        if (!isfinite(volume))
            return;
        if (auto* s = session(id))
            s->set_volume(clamp(volume, 0.0, 1.0));
    }
    virtual void set_playback_rate(u64 id, float rate) override
    {
        if (!isfinite(rate) || rate < 0)
            return;
        if (auto* s = session(id))
            s->set_playback_rate(rate);
    }
    virtual void set_duration(u64 id, AK::Duration d) override { if (auto* s = session(id)) s->set_duration(d); }
    virtual void set_audio_track_enabled(u64 id, u64 seek_request_id, Media::Track track, bool enabled, bool) override { if (auto* s = session(id)) s->set_audio_track_enabled(seek_request_id, track, enabled); }
    virtual void reserve_video_sink(u64 id, u64 seek_request_id, Media::Track track, Media::VideoSinkHandle handle, bool) override { if (auto* s = session(id)) s->reserve_video_sink(seek_request_id, track, handle); }
    virtual void disable_video_sink(u64 id, u64 seek_request_id, Media::VideoSinkHandle handle) override { if (auto* s = session(id)) s->disable_video_sink(seek_request_id, handle); }
    virtual void set_video_sink_ticking(u64, Media::VideoSinkHandle, bool) override { }
    virtual Messages::MediaServer::MapPresentedFrameSlotResponse map_presented_frame_slot(u64, Media::VideoSinkHandle, Media::VideoFramePoolID, u32) override { return { OptionalNone {}, nullptr }; }

    virtual void create_source_buffer(u64 id, u64 sb) override { if (auto* s = session(id)) s->create_source_buffer(sb); }
    virtual void destroy_source_buffer(u64 id, u64 sb) override { if (auto* s = session(id)) s->destroy_source_buffer(sb); }
    virtual void set_source_buffer_content_type(u64 id, u64 sb, String subtype) override { if (auto* s = session(id)) s->set_source_buffer_content_type(sb, subtype); }
    virtual void add_to_source_buffer_input(u64 id, u64 sb, ByteBuffer data) override { if (auto* s = session(id)) s->add_to_source_buffer_input(sb, data.bytes()); }
    virtual void run_source_buffer_append(u64 id, u64 sb, u64 generation) override { if (auto* s = session(id)) s->run_source_buffer_append(sb, generation); }
    virtual void reset_source_buffer_parser(u64 id, u64 sb) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::ResetParserState {}); }
    virtual void remove_source_buffer_coded_frames(u64 id, u64 sb, AK::Duration start, AK::Duration end) override { if (auto* s = session(id)) s->remove_source_buffer_coded_frames(sb, start, end); }
    virtual void run_source_buffer_coded_frame_eviction(u64 id, u64 sb, u64 size) override { if (auto* s = session(id)) s->run_source_buffer_coded_frame_eviction(sb, size); }
    virtual Messages::MediaServer::RunSourceBufferCodedFrameEvictionSynchronouslyResponse run_source_buffer_coded_frame_eviction_synchronously(u64 id, u64 sb, u64 size) override
    {
        auto* s = session(id);
        if (!s)
            return OptionalNone {};
        s->run_source_buffer_coded_frame_eviction(sb, size);
        return s->source_buffer_published_state(sb);
    }
    virtual void set_source_buffer_mode(u64 id, u64 sb, Media::MediaSourceExtensions::AppendMode mode) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::SetMode { mode }); }
    virtual void set_source_buffer_timestamp_offset(u64 id, u64 sb, AK::Duration offset) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::SetTimestampOffset { offset }); }
    virtual void set_source_buffer_append_window(u64 id, u64 sb, AK::Duration start, AK::Duration end) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::SetAppendWindow { start, end }); }
    virtual void set_source_buffer_generate_timestamps_flag(u64 id, u64 sb, bool flag) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::SetGenerateTimestampsFlag { flag }); }
    virtual void set_source_buffer_pending_initialization_segment_for_change_type_flag(u64 id, u64 sb, bool flag) override { if (auto* s = session(id)) s->run_source_buffer_command(sb, Commands::SetPendingInitializationSegmentForChangeTypeFlag { flag }); }
    virtual void set_source_buffer_reached_end_of_stream(u64 id, u64 sb, bool reached) override
    {
        if (auto* s = session(id)) {
            s->set_source_buffers_ended(reached);
            s->run_source_buffer_command(sb, Commands::SetReachedEndOfStream { reached });
        }
    }

    HashMap<u64, NonnullOwnPtr<Session>> m_sessions;
    HashMap<u64, NonnullRefPtr<Media::IncrementallyPopulatedStream>> m_streams;
    HashTable<u64> m_closed_streams;
    HashMap<u64, u64> m_received; // bytes added to each stream so far
};

RefPtr<Server>& server()
{
    static NeverDestroyed<RefPtr<Server>> s;
    return *s;
}

// --- Session ---------------------------------------------------------------------------------------------------

Session::Session(Server& server, u64 id)
    : m_server(server)
    , m_id(id)
    , m_writer(MUST(Media::MediaTimeWriter::create()))
    , m_reader(MUST(Media::MediaTimeReader::create(m_writer.buffer())))
    , m_timer(Core::Timer::create_repeating(10, [this] { tick(); }))
{
    m_writer.publish_monotonic_anchor(MonotonicTime::now(), AK::Duration::zero(), m_rate, false);
    m_server.async_playback_session_clock_changed(m_id, m_reader);
}

Session::~Session()
{
    m_timer->stop();
    for (auto& [handle, out] : m_video_outs) {
        if (out->decoder_id) {
            decoders().remove(out->decoder_id);
            ganglion_host_media_decoder_close(out->decoder_id);
        }
        sinks().remove(handle);
    }
    if (m_audio && m_audio->decoder_id) {
        decoders().remove(m_audio->decoder_id);
        ganglion_host_media_decoder_close(m_audio->decoder_id);
    }
}

void Session::add_media_stream_source(u64 stream_id, NonnullRefPtr<Media::IncrementallyPopulatedStream> stream, u64 received)
{
    // The resource is demuxed as it arrives: the demuxer is created once its headers have come (a read of data that has
    // not arrived answers Aborted at once, patch 0035, and the creation is tried again with more).
    m_waiting_streams.set(stream_id, WaitingStream { move(stream) });
    try_create_demuxer(stream_id, false, received);
}

void Session::try_create_demuxer(u64 stream_id, bool closed, u64 have)
{
    auto it = m_waiting_streams.find(stream_id);
    if (it == m_waiting_streams.end())
        return;
    auto stream = it->value.stream;
    // Not on every chunk: a demuxer's creation reads the headers again from the start.
    static constexpr u64 retry_step = 16 * KiB;
    if (!closed && (have < 4 * KiB || (it->value.tried_at_size && have < it->value.tried_at_size + retry_step)))
        return;
    it->value.tried_at_size = have;
    auto demuxer = Media::create_demuxer(NonnullRefPtr<Media::MediaStream>(*stream));
    if constexpr (false)
        log(ByteString::formatted("ganglion: media: demuxer for stream {} at {} bytes{}: {}", stream_id, have, closed ? " (all)" : "", demuxer.is_error() ? demuxer.error().description() : "created"sv));
    if (demuxer.is_error()) {
        // Before the end, a failure may be data that has not come (a format probe that could not read its header says
        // it does not recognise the format); after it, it is final.
        if (!closed && (demuxer.error().category() == Media::DecoderErrorCategory::Aborted || have < 1 * MiB))
            return;
        m_waiting_streams.remove(stream_id);
        m_server.async_playback_session_media_stream_source_failed(m_id, stream_id, demuxer.release_error());
        return;
    }
    m_waiting_streams.remove(stream_id);
    add_source(demuxer.release_value(), stream_id, false);
}

void Session::stream_data_arrived(u64 stream_id, u64 received)
{
    if (m_waiting_streams.contains(stream_id)) {
        try_create_demuxer(stream_id, false, received);
        return;
    }
    for (auto const& source : m_sources) {
        if (source.stream_id == stream_id) {
            wake();
            return;
        }
    }
}

void Session::stream_completed(u64 stream_id)
{
    if (m_waiting_streams.contains(stream_id)) {
        try_create_demuxer(stream_id, true, 0);
        return;
    }
    wake();
}

// Data came that reads may have waited for.
void Session::wake()
{
    pump_all();
    pump_audio();
    update();
}

// Seeks a track's demuxer; a seek that needs data that has not arrived is kept and tried again when it has.
bool Session::seek_demuxer(size_t source_index, Media::Track const& track, AK::Duration target, Optional<AK::Duration>& pending)
{
    auto result = m_sources[source_index].demuxer->seek_to_most_recent_keyframe(track, target, Media::DemuxerSeekOptions::Force | Media::DemuxerSeekOptions::NeedCodecConfiguration);
    if (result.is_error() && result.error().category() == Media::DecoderErrorCategory::Aborted && !m_sources[source_index].is_source_buffer) {
        pending = target;
        return false;
    }
    pending.clear();
    return true;
}

void Session::add_source(NonnullRefPtr<Media::Demuxer> demuxer, Optional<u64> stream_id, bool is_source_buffer)
{
    auto fail = [&](Media::DecoderError&& error) {
        if (stream_id.has_value())
            m_server.async_playback_session_media_stream_source_failed(m_id, *stream_id, move(error));
    };
    auto video = demuxer->get_tracks_for_type(Media::TrackType::Video);
    auto audio = demuxer->get_tracks_for_type(Media::TrackType::Audio);
    if (video.is_error())
        return fail(video.release_error());
    if (audio.is_error())
        return fail(audio.release_error());
    Optional<Media::Track> preferred_video, preferred_audio;
    if (auto t = demuxer->get_preferred_track_for_type(Media::TrackType::Video); !t.is_error())
        preferred_video = t.release_value();
    if (auto t = demuxer->get_preferred_track_for_type(Media::TrackType::Audio); !t.is_error())
        preferred_audio = t.release_value();
    for (auto const& track : video.value())
        (void)demuxer->create_context_for_track(track);
    for (auto const& track : audio.value())
        (void)demuxer->create_context_for_track(track);

    if (!m_duration_was_provided) {
        if (auto d = demuxer->total_duration(); !d.is_error() && d.value() > m_duration) {
            m_duration = d.value();
            m_server.async_playback_session_duration_changed(m_id, m_duration);
        }
    }

    auto scan_state = demuxer->scan_state();
    m_sources.append({ demuxer, stream_id, is_source_buffer, audio.value(), video.value(), scan_state });
    if (!is_source_buffer) {
        demuxer->set_scan_state_change_handler([this](Media::TimeRanges const&) { report_scan_states(); });
    }
    m_server.async_playback_session_media_source_added(m_id, stream_id, audio.release_value(), video.release_value(), preferred_audio, preferred_video, demuxer->start_time_realtime(), is_source_buffer ? Media::DemuxerScanState {} : scan_state);
    update();
}

void Session::report_scan_states()
{
    for (auto& source : m_sources) {
        if (source.is_source_buffer || !source.stream_id.has_value())
            continue;
        auto const& scan_state = source.demuxer->scan_state();
        if (scan_state == source.reported_scan_state)
            continue;
        source.reported_scan_state = scan_state;
        m_server.async_playback_session_media_stream_scan_state_changed(m_id, *source.stream_id, scan_state);
    }
}

void Session::report_state()
{
    Reported now { m_state, m_playing, m_available, m_applied_seek_request_id };
    if (m_reported.has_value() && m_reported->state == now.state && m_reported->playing == now.playing && m_reported->available == now.available && m_reported->seek_id == now.seek_id)
        return;
    m_reported = now;
    auto time = m_state == Media::PlaybackState::Seeking && m_seek_target.has_value() ? *m_seek_target : media_time();
    m_server.async_playback_session_state_changed(m_id, m_applied_seek_request_id, m_state, m_playing, m_available, time);
}

void Session::anchor_clock(AK::Duration at, bool advancing, Optional<float> rate)
{
    if (!rate.has_value())
        m_slewing = false;
    m_writer.publish_monotonic_anchor(MonotonicTime::now(), at, rate.value_or(m_rate), advancing);
}

bool Session::all_have_current_frame() const
{
    for (auto const& [handle, out] : m_video_outs) {
        if (out->seek_target.has_value())
            return false;
        if (!out->sink->current_frame() && out->queue.is_empty() && !(out->drained || out->decoder_failed))
            return false;
        // A frame after the one on show, too (Chrome's HAVE_ENOUGH_DATA after a seek): the decoder may still hold the
        // next ones, and playing at once would wait for them.
        if (out->sink->current_frame() && out->queue.is_empty() && !(out->drained || out->decoder_failed || out->demux_ended))
            return false;
    }
    if (!audio_ready())
        return false;
    return !m_sources.is_empty();
}

void Session::start()
{
    m_started = true;
    update();
}

void Session::play()
{
    m_playing = true;
    if (m_state == Media::PlaybackState::Paused) {
        m_state = Media::PlaybackState::Playing;
        anchor_clock(media_time(), true);
    }
    update();
    report_state();
}

void Session::pause()
{
    m_playing = false;
    if (m_state == Media::PlaybackState::Playing || m_state == Media::PlaybackState::Buffering) {
        m_state = Media::PlaybackState::Paused;
        anchor_clock(media_time(), false);
    }
    update();
    report_state();
}

void Session::set_playback_rate(float rate)
{
    auto now = media_time();
    m_rate = rate;
    anchor_clock(now, m_state == Media::PlaybackState::Playing);
}

void Session::seek(u64 seek_request_id, AK::Duration target, Media::SeekMode)
{
    m_applied_seek_request_id = seek_request_id;
    m_state = Media::PlaybackState::Seeking;
    m_seek_target = target;
    m_writer.seek(target);
    anchor_clock(target, false);
    for (auto& [handle, out] : m_video_outs) {
        seek_demuxer(out->source_index, out->track, target, out->demuxer_seek);
        out->queue.clear();
        out->demux_ended = false;
        out->drained = false;
        out->seek_target = target;
        restart_decoder(*out);
    }
    if (m_audio) {
        restart_audio_decoder();
        seek_demuxer(m_audio->source_index, m_audio->track, target, m_audio->demuxer_seek);
    }
    report_state();
    pump_all();
    pump_audio();
    update();
}

void Session::set_audio_track_enabled(u64 seek_request_id, Media::Track const& track, bool enabled)
{
    m_applied_seek_request_id = seek_request_id;
    if (!enabled) {
        if (m_audio && m_audio->track == track) {
            restart_audio_decoder();
            m_audio = nullptr;
        }
    } else if (!m_audio || !(m_audio->track == track)) {
        Optional<size_t> source_index;
        for (size_t i = 0; i < m_sources.size(); ++i) {
            if (m_sources[i].audio_tracks.contains_slow(track))
                source_index = i;
        }
        if (source_index.has_value()) {
            if (m_audio)
                restart_audio_decoder();
            m_audio = make<AudioOut>(AudioOut { .track = track, .source_index = *source_index });
            auto at = m_seek_target.value_or(media_time());
            if (at > AK::Duration::zero())
                seek_demuxer(*source_index, track, at, m_audio->demuxer_seek);
            pump_audio();
        }
    }
    update();
    report_state();
}

void Session::set_volume(double volume)
{
    m_volume = volume;
    control_audio_output();
}

// Closes the audio decoder (its output and what it holds go with it); the next sample starts a new one.
void Session::restart_audio_decoder()
{
    if (!m_audio)
        return;
    auto& out = *m_audio;
    if (out.decoder_id) {
        decoders().remove(out.decoder_id);
        ganglion_host_media_decoder_close(out.decoder_id);
    }
    out.decoder_id = 0;
    out.client = nullptr;
    out.decoder_failed = false;
    out.demux_ended = false;
    out.drained = false;
    out.any_sent = false;
    out.any_decoded = false;
    out.sent_until = {};
    out.decoded_until = {};
    out.has_report = false;
    out.running = false;
    out.underrun = false;
    out.sent_playing = -1;
    out.sent_volume = -1;
    out.sent_rate = -1;
}

// Hands samples to the host's audio decoder until a second ahead of the clock has been sent.
void Session::pump_audio()
{
    if (!m_audio)
        return;
    auto& out = *m_audio;
    if (out.demuxer_seek.has_value() && !seek_demuxer(out.source_index, out.track, *out.demuxer_seek, out.demuxer_seek))
        return;
    auto& source = m_sources[out.source_index];
    auto horizon = m_seek_target.value_or(media_time()) + AK::Duration::from_milliseconds(1000);
    while (!out.demux_ended && !out.decoder_failed && (!out.any_sent || out.sent_until < horizon)) {
        if (source.is_source_buffer)
            source.demuxer->set_blocking_reads_aborted_for_track(out.track);
        auto sample = source.demuxer->get_next_sample_for_track(out.track);
        if (source.is_source_buffer)
            source.demuxer->reset_blocking_reads_aborted_for_track(out.track);
        if (sample.is_error()) {
            auto category = sample.error().category();
            if (category == Media::DecoderErrorCategory::Aborted && !m_source_buffers_ended)
                return;
            if (category != Media::DecoderErrorCategory::EndOfStream && category != Media::DecoderErrorCategory::Aborted)
                log(ByteString::formatted("ganglion: media: demuxing audio failed: {}", sample.error().description()));
            out.demux_ended = true;
            if (out.decoder_id)
                ganglion_host_media_decoder_flush(out.decoder_id);
            else
                out.drained = true;
            break;
        }
        auto frame = sample.release_value();
        if (auto config = frame.new_codec_configuration(); config.has_value()) {
            bool changed = !out.codec_configuration.has_value() || out.codec_configuration->bytes() != *config;
            out.codec_configuration = MUST(ByteBuffer::copy(*config));
            if (changed && out.decoder_id) {
                decoders().remove(out.decoder_id);
                ganglion_host_media_decoder_close(out.decoder_id);
                out.decoder_id = 0;
                out.client = nullptr;
                out.sent_playing = -1;
            }
        }
        if (!out.decoder_id) {
            ReadonlyBytes config = out.codec_configuration.has_value() ? out.codec_configuration->bytes() : ReadonlyBytes {};
            auto codec = webcodecs_codec_string(frame.codec_id(), config);
            auto id = s_next_decoder_id++;
            auto client = make<HostDecoderClient>();
            client->on_audio_decoded = [this](AK::Duration end) {
                if (!m_audio)
                    return;
                m_audio->any_decoded = true;
                if (end > m_audio->decoded_until)
                    m_audio->decoded_until = end;
                update();
            };
            client->on_audio_progress = [this](AK::Duration played, AK::Duration, u32 flags) {
                if (!m_audio)
                    return;
                m_audio->has_report = true;
                m_audio->running = flags & 1;
                m_audio->underrun = flags & 2;
                m_audio->played = played;
                m_audio->reported_at = MonotonicTime::now();
                follow_audio();
            };
            client->on_flushed = [this] {
                if (!m_audio)
                    return;
                m_audio->drained = true;
                update();
            };
            client->on_error = [this](StringView message) {
                log(ByteString::formatted("ganglion: media: the host's audio decoder failed: {}", message));
                if (!m_audio)
                    return;
                m_audio->decoder_failed = true;
                update();
            };
            decoders().set(id, client.ptr());
            out.client = move(client);
            out.decoder_id = id;
            auto const& spec = out.track.audio_data().sample_specification;
            if (!ganglion_host_media_decoder_create(id, 1, codec.characters(), codec.length(), config.data(), config.size(), 0, 0, spec.sample_rate(), spec.channel_count())) {
                log(ByteString::formatted("ganglion: media: the host cannot decode {}", codec));
                out.decoder_failed = true;
                break;
            }
            out.sent_playing = -1;
            control_audio_output();
        }
        auto end = frame.presentation_timestamp() + frame.duration();
        if (!out.any_sent || end > out.sent_until)
            out.sent_until = end;
        out.any_sent = true;
        ganglion_host_media_decode(out.decoder_id, frame.data().data(), frame.data().size(), static_cast<double>(frame.presentation_timestamp().to_microseconds()), static_cast<double>(frame.duration().to_microseconds()), 1);
    }
}

bool Session::audio_ready() const
{
    if (!m_audio || m_audio->decoder_failed)
        return true;
    if (m_audio->drained)
        return true;
    auto at = m_seek_target.value_or(media_time());
    return m_audio->any_decoded && m_audio->decoded_until > at;
}

bool Session::audio_done() const
{
    if (!m_audio || m_audio->decoder_failed)
        return true;
    return m_audio->drained && media_time() >= m_audio->decoded_until;
}

// Playing, decoded audio does not reach the clock: wait for it (unless the decoding has ended).
bool Session::audio_starved() const
{
    if (!m_audio || m_audio->decoder_failed || m_audio->drained || m_audio->demux_ended)
        return false;
    return !m_audio->any_decoded || m_audio->decoded_until <= media_time();
}

// The audio output leads the clock while it plays and reports: it is running (the carapace's AudioContext runs) and
// not starved, and it reported recently.
bool Session::audio_leads() const
{
    if (!m_audio || !m_audio->has_report || !m_audio->running || m_audio->underrun || m_state != Media::PlaybackState::Playing)
        return false;
    return MonotonicTime::now() - m_audio->reported_at < AK::Duration::from_milliseconds(250);
}

// The clock follows the output's position. It never jumps back (currentTime only increases while playing, as in
// Chrome): a small difference is slewed (the clock runs a little faster or slower until they meet), a large lead jumps.
void Session::follow_audio()
{
    if (!audio_leads())
        return;
    auto heard = m_audio->played;
    auto now = media_time();
    auto diff = (heard - now).to_microseconds() / 1e6;
    if (diff > 0.3) {
        anchor_clock(heard, true);
    } else if (diff > 0.008 || diff < -0.008) {
        auto factor = clamp(1.0 + 6.0 * diff, 0.75, 1.25);
        m_writer.publish_monotonic_anchor(MonotonicTime::now(), now, static_cast<float>(m_rate * factor), true);
        m_slewing = true;
    } else if (m_slewing) {
        anchor_clock(now, true);
    }
}

// Tells the output whether to play, its volume and rate, and (while it does not lead the clock) where the clock is.
void Session::control_audio_output()
{
    if (!m_audio || !m_audio->decoder_id)
        return;
    auto& out = *m_audio;
    int playing = m_state == Media::PlaybackState::Playing ? 1 : 0;
    bool leads = audio_leads();
    auto now = MonotonicTime::now();
    bool sync_due = !leads && now - out.last_sync >= AK::Duration::from_milliseconds(100);
    if (playing == out.sent_playing && out.sent_volume == m_volume && out.sent_rate == m_rate && !sync_due)
        return;
    out.sent_playing = playing;
    out.sent_volume = m_volume;
    out.sent_rate = m_rate;
    double sync = -1;
    if (!leads) {
        out.last_sync = now;
        sync = static_cast<double>(m_seek_target.value_or(media_time()).to_microseconds());
    }
    ganglion_host_media_audio_control(out.decoder_id, playing, m_volume, m_rate, sync);
}

void Session::reserve_video_sink(u64 seek_request_id, Media::Track const& track, Media::VideoSinkHandle handle)
{
    m_applied_seek_request_id = seek_request_id;
    Optional<size_t> source_index;
    for (size_t i = 0; i < m_sources.size(); ++i) {
        if (m_sources[i].video_tracks.contains_slow(track))
            source_index = i;
    }
    if (source_index.has_value()) {
        auto sink = adopt_ref(*new FrameSink);
        sinks().set(handle, sink);
        auto out = make<VideoOut>(VideoOut { .track = track, .handle = handle, .source_index = *source_index, .sink = sink });
        if (m_state == Media::PlaybackState::Seeking && m_seek_target.has_value())
            out->seek_target = m_seek_target;
        auto& ref = *out;
        m_video_outs.set(handle, move(out));
        if (ref.seek_target.has_value() || media_time() > AK::Duration::zero())
            seek_demuxer(ref.source_index, track, ref.seek_target.value_or(media_time()), ref.demuxer_seek);
        pump(ref);
    }
    update();
    report_state();
}

void Session::disable_video_sink(u64 seek_request_id, Media::VideoSinkHandle handle)
{
    m_applied_seek_request_id = seek_request_id;
    if (auto out = m_video_outs.take(handle); out.has_value()) {
        if ((*out)->decoder_id) {
            decoders().remove((*out)->decoder_id);
            ganglion_host_media_decoder_close((*out)->decoder_id);
        }
    }
    sinks().remove(handle);
    frames_changed();
    update();
    report_state();
}

void Session::restart_decoder(VideoOut& out)
{
    if (out.decoder_id) {
        decoders().remove(out.decoder_id);
        ganglion_host_media_decoder_close(out.decoder_id);
    }
    out.decoder_id = 0;
    out.client = nullptr;
    out.in_flight = 0;
    out.decoder_failed = false;
}

void Session::pump_all()
{
    for (auto& [handle, out] : m_video_outs)
        pump(*out);
}

// Reads samples and hands them to the host's decoder until a few frames are queued or in flight.
void Session::pump(VideoOut& out)
{
    static constexpr u32 frames_ahead = 10;
    if (out.demuxer_seek.has_value() && !seek_demuxer(out.source_index, out.track, *out.demuxer_seek, out.demuxer_seek))
        return;
    auto& source = m_sources[out.source_index];
    while (!out.demux_ended && !out.decoder_failed && out.in_flight + out.queue.size() < frames_ahead) {
        // A source buffer's demuxer waits for data that has not been appended: aborting its reads first makes it
        // answer at once instead. A media resource has all arrived, so its reads never wait.
        if (source.is_source_buffer)
            source.demuxer->set_blocking_reads_aborted_for_track(out.track);
        auto sample = source.demuxer->get_next_sample_for_track(out.track);
        if (source.is_source_buffer)
            source.demuxer->reset_blocking_reads_aborted_for_track(out.track);
        if (sample.is_error()) {
            auto category = sample.error().category();
            // An aborted read found no frame at the cursor; once the stream has ended (MediaSource.endOfStream), none comes.
            if (category == Media::DecoderErrorCategory::Aborted && !m_source_buffers_ended)
                return;
            // After MediaSource.endOfStream an aborted read is the end, not a failure.
            if (category != Media::DecoderErrorCategory::EndOfStream && category != Media::DecoderErrorCategory::Aborted)
                log(ByteString::formatted("ganglion: media: demuxing failed: {}", sample.error().description()));
            out.demux_ended = true;
            if (out.decoder_id)
                ganglion_host_media_decoder_flush(out.decoder_id);
            else
                out.drained = true;
            break;
        }
        auto frame = sample.release_value();
        if (auto config = frame.new_codec_configuration(); config.has_value()) {
            bool changed = !out.codec_configuration.has_value() || out.codec_configuration->bytes() != *config;
            out.codec_configuration = MUST(ByteBuffer::copy(*config));
            if (changed && out.decoder_id)
                restart_decoder(out);
        }
        if (!out.decoder_id) {
            if (!has_flag(frame.flags(), Media::FrameFlags::Keyframe))
                continue;
            ReadonlyBytes config = out.codec_configuration.has_value() ? out.codec_configuration->bytes() : ReadonlyBytes {};
            auto codec = webcodecs_codec_string(frame.codec_id(), config);
            auto id = s_next_decoder_id++;
            auto client = make<HostDecoderClient>();
            // An unspecified matrix converts as BT.601, as Chrome's video renderer (PaintCanvasVideoRenderer) does; with
            // BT.709, BT.601 red came out 255,24,0 and green 0,233,0 (Khronos video uploads).
            client->cicp = Media::CodingIndependentCodePoints { Media::ColorPrimaries::BT709, Media::TransferCharacteristics::BT709, Media::MatrixCoefficients::BT601, Media::VideoFullRangeFlag::Studio };
            client->cicp.adopt_specified_values(out.track.video_data().cicp);
            auto handle = out.handle;
            client->on_video_frame = [this, handle](NonnullRefPtr<Media::VideoFrame> frame) { receive_frame(handle, move(frame)); };
            client->on_flushed = [this, handle] {
                if (auto o = m_video_outs.get(handle); o.has_value()) {
                    (*o)->drained = true;
                    update();
                }
            };
            client->on_error = [this, handle](StringView message) {
                log(ByteString::formatted("ganglion: media: the host's decoder failed: {}", message));
                if (auto o = m_video_outs.get(handle); o.has_value()) {
                    (*o)->decoder_failed = true;
                    update();
                }
            };
            decoders().set(id, client.ptr());
            out.client = move(client);
            out.decoder_id = id;
            auto const& video = out.track.video_data();
            if (!ganglion_host_media_decoder_create(id, 0, codec.characters(), codec.length(), config.data(), config.size(), video.pixel_width, video.pixel_height, 0, 0)) {
                log(ByteString::formatted("ganglion: media: the host cannot decode {}", codec));
                out.decoder_failed = true;
                m_server.async_playback_session_error(m_id, Media::DecoderError::with_description(Media::DecoderErrorCategory::NotImplemented, "The host cannot decode this video"sv));
                break;
            }
        }
        out.in_flight++;
        ganglion_host_media_decode(out.decoder_id, frame.data().data(), frame.data().size(), static_cast<double>(frame.presentation_timestamp().to_microseconds()), static_cast<double>(frame.duration().to_microseconds()), has_flag(frame.flags(), Media::FrameFlags::Keyframe) ? 1 : 0);
    }
}

void Session::receive_frame(Media::VideoSinkHandle handle, NonnullRefPtr<Media::VideoFrame> frame)
{
    auto o = m_video_outs.get(handle);
    if (!o.has_value())
        return;
    auto& out = **o;
    if (out.in_flight > 0)
        out.in_flight--;
    if (out.seek_target.has_value()) {
        // Frames before the target are decoded only to reach it.
        if (frame->end() <= *out.seek_target) {
            pump(out);
            return;
        }
        out.seek_target.clear();
        out.sink->set_frame(frame);
        frames_changed();
    }
    if (frame->size() != out.reported_size) {
        out.reported_size = frame->size();
        m_server.async_playback_session_video_resized(m_id, handle, frame->width(), frame->height());
    }
    out.queue.append(move(frame));
    quick_sort(out.queue, [](auto const& a, auto const& b) { return a->timestamp() < b->timestamp(); });
    pump(out);
    update();
}

// The frame on show for each sink: the latest whose time has come.
void Session::present()
{
    auto now = media_time();
    for (auto& [handle, out] : m_video_outs) {
        if (out->seek_target.has_value())
            continue;
        RefPtr<Media::VideoFrame> chosen;
        if (!out->sink->current_frame() && !out->queue.is_empty())
            chosen = out->queue.take_first();
        while (!out->queue.is_empty() && out->queue.first()->timestamp() <= now)
            chosen = out->queue.take_first();
        if (chosen) {
            out->sink->set_frame(chosen);
            frames_changed();
            pump(*out);
        }
    }
}

void Session::tick()
{
    follow_audio();
    pump_audio();
    present();
    update();
}

void Session::update()
{
    present();
    bool have_current = all_have_current_frame();
    auto now = media_time();

    bool starved = audio_starved();
    bool finished = !m_video_outs.is_empty() || m_audio;
    for (auto const& [handle, out] : m_video_outs) {
        bool out_done = (out->drained || out->decoder_failed) && out->queue.is_empty() && out->in_flight == 0;
        if (!out_done)
            finished = false;
        auto current = out->sink->current_frame();
        if (!out_done && out->queue.is_empty() && (!current || current->end() <= now))
            starved = true;
    }
    if (!audio_done())
        finished = false;
    if (m_video_outs.is_empty() && !m_audio && !m_sources.is_empty() && m_duration > AK::Duration::zero() && now >= m_duration)
        finished = true;

    switch (m_state) {
    case Media::PlaybackState::Starting:
        if (m_started && have_current) {
            m_state = m_playing ? Media::PlaybackState::Playing : Media::PlaybackState::Paused;
            anchor_clock(now, m_playing);
        }
        break;
    case Media::PlaybackState::Seeking:
        if (have_current) {
            auto target = m_seek_target.value_or(now);
            m_seek_target.clear();
            m_state = m_playing ? Media::PlaybackState::Playing : Media::PlaybackState::Paused;
            anchor_clock(target, m_playing);
        }
        break;
    case Media::PlaybackState::Playing:
        if (finished && (m_duration == AK::Duration::zero() || now >= m_duration || m_video_outs.size() > 0 || m_audio)) {
            m_state = Media::PlaybackState::Ended;
            anchor_clock(m_duration > AK::Duration::zero() ? m_duration : now, false);
        } else if (starved) {
            m_state = Media::PlaybackState::Buffering;
            anchor_clock(now, false);
            log(ByteString::formatted("ganglion: media: waiting at {} ms: audio {}, decoded to {} ms; video queue {}, on show {}", now.to_milliseconds(), audio_starved() ? "starved" : "ok", m_audio ? m_audio->decoded_until.to_milliseconds() : -1, m_video_outs.is_empty() ? -1 : static_cast<i64>(m_video_outs.begin()->value->queue.size()),
                m_video_outs.is_empty() || !m_video_outs.begin()->value->sink->current_frame() ? ByteString("none") : ByteString::formatted("{}-{} ms, {} in flight", m_video_outs.begin()->value->sink->current_frame()->timestamp().to_milliseconds(), m_video_outs.begin()->value->sink->current_frame()->end().to_milliseconds(), m_video_outs.begin()->value->in_flight)));
        }
        break;
    case Media::PlaybackState::Buffering:
        if (!starved && have_current) {
            m_state = Media::PlaybackState::Playing;
            anchor_clock(now, true);
        } else if (finished) {
            m_state = Media::PlaybackState::Ended;
        }
        break;
    case Media::PlaybackState::Ended:
        if (m_playing && now < m_duration && !finished) {
            m_state = Media::PlaybackState::Playing;
            anchor_clock(now, true);
        }
        break;
    case Media::PlaybackState::Paused:
    case Media::PlaybackState::Suspended:
        break;
    }

    if (!have_current)
        m_available = Media::AvailableData::None;
    else if (finished || !starved)
        m_available = Media::AvailableData::Future;
    else
        m_available = Media::AvailableData::Current;

    control_audio_output();
    bool needs_ticks = m_state == Media::PlaybackState::Playing || m_state == Media::PlaybackState::Buffering;
    if (needs_ticks && !m_timer->is_active())
        m_timer->start();
    else if (!needs_ticks && m_timer->is_active())
        m_timer->stop();
    report_state();
}

void Session::create_source_buffer(u64 id)
{
    if (m_source_buffers.contains(id))
        return;
    auto processor = adopt_ref(*new Media::MediaSourceExtensions::SourceBufferProcessor());
    processor->set_duration_change_callback([this, id](double duration) {
        m_server.async_source_buffer_duration_received(m_id, id, duration);
    });
    processor->set_first_initialization_segment_callback([this, id](Media::MediaSourceExtensions::InitializationSegmentData&& segment) {
        // The tracks are added before the renderer hears of the segment, so that it knows them first (upstream holds
        // messages while its manager adds them on another thread; here that is immediate).
        if (!segment.audio_tracks.is_empty() || !segment.video_tracks.is_empty())
            add_source(segment.demuxer, {}, true);
        m_server.async_source_buffer_first_initialization_segment_received(m_id, id, move(segment.audio_tracks), move(segment.video_tracks), move(segment.text_tracks));
    });
    processor->set_append_error_callback([this, id] {
        if (auto* sb = find_source_buffer(id))
            sb->append_outcome = SourceBuffer::Outcome::Failed;
    });
    processor->set_coded_frame_processing_done_callback([this, id](AK::Duration group_end_timestamp) {
        m_server.async_source_buffer_coded_frames_processed(m_id, id, group_end_timestamp);
    });
    processor->set_append_done_callback([this, id] {
        if (auto* sb = find_source_buffer(id))
            sb->append_outcome = SourceBuffer::Outcome::Completed;
    });
    m_source_buffers.set(id, SourceBuffer { .processor = move(processor), .pending_append_data = {} });
}

void Session::set_source_buffer_content_type(u64 id, StringView subtype)
{
    auto* sb = find_source_buffer(id);
    if (!sb)
        return;
    OwnPtr<Media::MediaSourceExtensions::ByteStreamParser> parser;
    if (subtype == "webm"sv)
        parser = make<Media::MediaSourceExtensions::WebMByteStreamParser>();
    else if (subtype == "mp4"sv)
        parser = make<Media::MediaSourceExtensions::ISOBMFFByteStreamParser>();
    if (!parser)
        return;
    sb->processor->run(Commands::SetParser { parser.release_nonnull() });
    sb->has_parser = true;
}

void Session::run_source_buffer_append(u64 id, u64 append_generation)
{
    auto* sb = find_source_buffer(id);
    if (!sb || !sb->has_parser)
        return;
    auto data = move(sb->pending_append_data);
    sb->append_outcome = SourceBuffer::Outcome::Pending;
    sb->append_generation = append_generation;
    sb->processor->run(Commands::BufferAppend { move(data) });
    sb = find_source_buffer(id);
    if (!sb)
        return;
    auto state = published_state(*sb);
    if constexpr (false) {
        for (size_t i = 0; i < state.track_buffered_ranges.size(); ++i) {
            auto const& ranges = state.track_buffered_ranges[i];
            log(ByteString::formatted("ganglion: media: append {}: track {} has {} ranges{}", append_generation, i, ranges.size(), ranges.size() ? ByteString::formatted(", {} to {}", ranges[0].start, ranges[0].end) : ByteString {}));
        }
    }
    if (sb->append_outcome == SourceBuffer::Outcome::Failed)
        m_server.async_source_buffer_append_failed(m_id, id, append_generation, move(state));
    else
        m_server.async_source_buffer_append_completed(m_id, id, append_generation, move(state));
    // Frames that were waiting for this data can be decoded now.
    for (auto& [handle, out] : m_video_outs) {
        if (out->demux_ended && !m_source_buffers_ended && m_sources[out->source_index].is_source_buffer) {
            out->demux_ended = false;
            out->drained = false;
        }
    }
    if (m_audio && m_audio->demux_ended && !m_source_buffers_ended && m_sources[m_audio->source_index].is_source_buffer) {
        m_audio->demux_ended = false;
        m_audio->drained = false;
    }
    pump_all();
    pump_audio();
    update();
}

void Session::remove_source_buffer_coded_frames(u64 id, AK::Duration start, AK::Duration end)
{
    auto* sb = find_source_buffer(id);
    if (!sb)
        return;
    sb->processor->run(Commands::CodedFrameRemoval { start, end });
    m_server.async_source_buffer_removal_completed(m_id, id, published_state(*sb));
}

void Session::run_source_buffer_coded_frame_eviction(u64 id, size_t new_data_size)
{
    if (auto* sb = find_source_buffer(id))
        sb->processor->run(Commands::CodedFrameEviction { new_data_size, media_time() });
}

Optional<Media::MediaSourceExtensions::PublishedState> Session::source_buffer_published_state(u64 id)
{
    auto* sb = find_source_buffer(id);
    if (!sb)
        return {};
    return published_state(*sb);
}

void Session::run_source_buffer_command(u64 id, Media::MediaSourceExtensions::Command command)
{
    if (auto* sb = find_source_buffer(id))
        sb->processor->run(move(command));
    pump_all();
    pump_audio();
    update();
}

}

void install_media()
{
    // The frame a video shows, for drawImage / createImageBitmap / WebGL uploads (HTMLVideoElement's
    // current_decoded_image_frame): the media server is in this process, so its sink's frame is read directly.
    MediaClient::RemotePlaybackManager::in_process_presented_frame() = [](Media::VideoSinkHandle handle) -> RefPtr<Media::VideoFrame> {
        auto sink = sinks().get(handle);
        if (!sink.has_value())
            return nullptr;
        return (*sink)->current_frame();
    };
    MediaClient::Client::set_transport_factory([]() -> ErrorOr<NonnullOwnPtr<IPC::Transport>> {
        auto pair = IPC::TransportSocket::create_in_process_pair();
        server() = Server::construct(move(pair.server));
        return move(pair.client);
    });
}

RefPtr<Media::VideoSink> media_video_sink(Media::VideoSinkHandle handle)
{
    auto sink = sinks().get(handle);
    if (!sink.has_value())
        return nullptr;
    return RefPtr<Media::VideoSink> { *sink };
}

bool media_frames_pending()
{
    return s_frames_changed;
}

bool media_frames_changed()
{
    return exchange(s_frames_changed, false);
}

// Called by LibMedia's decoder registry (MediaWithoutFFmpeg.cpp): whether the host decodes this codec.
bool host_decodes(Media::CodecID id)
{
    auto family = family_of(id);
    return !family.is_empty() && host_codecs().families.contains(family);
}

}

// --- The host's answers ---------------------------------------------------------------------------------------

// The codec families the host's WebCodecs decodes, one per line (vp8, vp9, av1, h264, h265, opus, vorbis, aac, flac, mp3).
GANGLION_EXPORT void ganglion_media_set_codec_support(char const* text, size_t length)
{
    auto& codecs = Ganglion::host_codecs();
    codecs.families.clear();
    for (auto line : StringView { text, length }.split_view('\n'))
        codecs.families.set(line.trim_whitespace());
    codecs.probed = true;
}

// A decoded frame: planes Y, U, V one after another (8-bit unless bit_depth > 8: 16-bit little-endian samples).
// chroma: 0 4:2:0, 1 4:2:2, 2 4:4:4.
GANGLION_EXPORT void ganglion_media_video_frame(uint32_t id, double timestamp_us, double duration_us, uint32_t width, uint32_t height, int chroma, int bit_depth, uint8_t const* data, size_t length)
{
    auto client = Ganglion::decoders().get(id);
    if (!client.has_value())
        return;
    auto& c = **client;
    auto subsampling = chroma == 2 ? Media::Subsampling::yuv444() : chroma == 1 ? Media::Subsampling::yuv422() : Media::Subsampling::yuv420();
    auto size = Gfx::IntSize { static_cast<int>(width), static_cast<int>(height) };
    // The host's planes come tightly packed, Y, U, V; the pool's layout starts each plane on a 64-byte boundary
    // (frame_plane_layout), so a size whose planes are not multiples of 64 (854x480) is copied plane by plane.
    auto layout_or_error = Media::frame_plane_layout(size, static_cast<u8>(bit_depth), subsampling);
    if (layout_or_error.is_error() || layout_or_error.value().y_size + layout_or_error.value().u_size + layout_or_error.value().v_size != length) {
        if (c.on_error)
            c.on_error(ByteString::formatted("frame planes do not match their size: {}x{}, chroma {}, {} bits, {} bytes", width, height, chroma, bit_depth, length));
        return;
    }
    auto layout = layout_or_error.release_value();
    auto slot_size = layout.total_byte_count;
    Optional<Media::VideoFramePool::AcquiredSlot> slot;
    RefPtr<Media::VideoFramePool> pool;
    for (auto& p : c.pools) {
        slot = p->try_acquire(slot_size);
        if (slot.has_value()) {
            pool = p;
            break;
        }
    }
    if (!slot.has_value()) {
        auto created = Media::VideoFramePool::create();
        if (created.is_error())
            return;
        pool = created.release_value();
        c.pools.append(*pool);
        slot = pool->try_acquire(slot_size);
        if (!slot.has_value())
            return;
    }
    memcpy(slot->bytes.data(), data, layout.y_size);
    memcpy(slot->bytes.data() + layout.u_offset, data + layout.y_size, layout.u_size);
    memcpy(slot->bytes.data() + layout.v_offset, data + layout.y_size + layout.u_size, layout.v_size);
    auto backing = pool->try_adopt_acquired_slot(*slot);
    if (backing.is_error())
        return;
    auto frame = adopt_ref(*new Media::VideoFrame(
        AK::Duration::from_microseconds(static_cast<i64>(timestamp_us)),
        AK::Duration::from_microseconds(static_cast<i64>(duration_us > 0 ? duration_us : 33333)),
        { width, height }, static_cast<u8>(bit_depth), subsampling, c.cicp, backing.release_value()));
    if (c.on_video_frame)
        c.on_video_frame(move(frame));
}

GANGLION_EXPORT void ganglion_media_decoder_flushed(uint32_t id)
{
    if (auto client = Ganglion::decoders().get(id); client.has_value() && (*client)->on_flushed)
        (*client)->on_flushed();
}

GANGLION_EXPORT void ganglion_media_decoder_error(uint32_t id, char const* message, size_t length)
{
    if (auto client = Ganglion::decoders().get(id); client.has_value() && (*client)->on_error)
        (*client)->on_error(StringView { message, length });
}

// An audio decoder's output was handed to the host's audio output; decoded through end_us.
GANGLION_EXPORT void ganglion_media_audio_decoded(uint32_t id, double end_us)
{
    if (auto client = Ganglion::decoders().get(id); client.has_value() && (*client)->on_audio_decoded)
        (*client)->on_audio_decoded(AK::Duration::from_microseconds(static_cast<i64>(end_us)));
}

// The audio output's report: the media time heard now, what it holds, flags (1 running, 2 starved).
GANGLION_EXPORT void ganglion_media_audio_progress(uint32_t id, double played_us, double queued_us, uint32_t flags)
{
    if (auto client = Ganglion::decoders().get(id); client.has_value() && (*client)->on_audio_progress)
        (*client)->on_audio_progress(AK::Duration::from_microseconds(static_cast<i64>(played_us)), AK::Duration::from_microseconds(static_cast<i64>(queued_us)), flags);
}

// The host's output rate for Web Audio (the carapace's AudioContext's sampleRate): an AudioContext made afterwards runs at it,
// as Chrome's runs at the output device's, and what it renders goes to the host (ganglion_host_webaudio_*).
static Audio::EmbedderAudioOutput s_webaudio_output {
    .sample_rate = 0,
    .open = [](u32 sample_rate, u32 channels) -> u32 { return ganglion_host_webaudio_open(sample_rate, channels); },
    .write = [](u32 stream, float const* samples, size_t frames) { ganglion_host_webaudio_write(stream, samples, frames); },
    .control = [](u32 stream, bool playing, double volume) { ganglion_host_webaudio_control(stream, playing ? 1 : 0, volume); },
    .close = [](u32 stream) { ganglion_host_webaudio_close(stream); },
};

extern "C" { uint32_t g_ganglion_audio_output_rate = 0; } // read by the page client (Host.cpp: an AudioContext's default sampleRate)

GANGLION_EXPORT void ganglion_set_audio_output(uint32_t sample_rate)
{
    g_ganglion_audio_output_rate = sample_rate;
    s_webaudio_output.sample_rate = sample_rate;
    Audio::set_embedder_audio_output(&s_webaudio_output);
}
