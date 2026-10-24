// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// LibMedia without FFmpeg: the factories its registries call answer "no decoder", and the Vorbis
// packet parser (libavcodec's vorbis_parser in upstream) reports no durations. Media decoding in a
// segment goes to the host's WebCodecs in phase 4 (docs/plan.md).

#include "Media.h"
#include <LibMedia/Codecs/Vorbis.h>
#include <LibMedia/FFmpeg/FFmpegAudioConverter.h>
#include <LibMedia/FFmpeg/FFmpegAudioDecoder.h>
#include <LibMedia/FFmpeg/FFmpegDemuxer.h>
#include <LibMedia/FFmpeg/FFmpegVideoDecoder.h>

namespace Media::FFmpeg {

static DecoderError no_decoder()
{
    return DecoderError::with_description(DecoderErrorCategory::NotImplemented, "Ganglion has no FFmpeg; media decoding is not available in this build"sv);
}

DecoderErrorOr<NonnullRefPtr<Demuxer>> FFmpegDemuxer::from_stream(NonnullRefPtr<MediaStream> const&)
{
    return no_decoder();
}

bool FFmpegDemuxer::supports_container_mime_type(ContainerMimeType)
{
    return false;
}

bool FFmpegDemuxer::supports_codec_in_container(ContainerID, CodecID)
{
    return false;
}

ErrorOr<NonnullOwnPtr<FFmpegAudioConverter>> FFmpegAudioConverter::try_create()
{
    return Error::from_string_literal("Ganglion has no FFmpeg audio converter");
}

// The host's WebCodecs decodes for the media server (Media.cpp); these answer canPlayType and isTypeSupported.
Optional<DecoderCapabilities> FFmpegAudioDecoder::capabilities(ParsedCodec const& codec)
{
    if (!Ganglion::host_decodes(codec.codec_id()))
        return {};
    return DecoderCapabilities { .smooth = true, .power_efficient = true };
}

DecoderErrorOr<NonnullOwnPtr<FFmpegAudioDecoder>> FFmpegAudioDecoder::try_create(CodecID, Audio::SampleSpecification const&, ReadonlyBytes)
{
    return no_decoder();
}

Optional<DecoderCapabilities> FFmpegVideoDecoder::capabilities(ParsedCodec const& codec)
{
    if (!Ganglion::host_decodes(codec.codec_id()))
        return {};
    return DecoderCapabilities { .smooth = true, .power_efficient = true };
}

DecoderErrorOr<NonnullOwnPtr<FFmpegVideoDecoder>> FFmpegVideoDecoder::try_create(CodecID, ReadonlyBytes)
{
    return no_decoder();
}

}

namespace Media::Codecs {

Optional<Vorbis::Parser> Vorbis::Parser::create(ReadonlyBytes)
{
    return {};
}

Vorbis::Parser::Parser(Parser&& other)
    : m_context(exchange(other.m_context, nullptr))
{
}

Vorbis::Parser& Vorbis::Parser::operator=(Parser&& other)
{
    m_context = exchange(other.m_context, nullptr);
    return *this;
}

Vorbis::Parser::~Parser() = default;

void Vorbis::Parser::reset() const
{
}

Optional<u32> Vorbis::Parser::parse_packet_duration_in_samples(ReadonlyBytes) const
{
    return {};
}

Optional<AK::Duration> Vorbis::Parser::parse_packet_duration(ReadonlyBytes, u32) const
{
    return {};
}

}
