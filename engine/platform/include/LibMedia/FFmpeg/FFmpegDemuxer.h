// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Ganglion replaces LibMedia's FFmpeg-backed classes: there is no FFmpeg in a segment Worker (media is
// decoded by the host's WebCodecs in phase 4). This header shadows <LibMedia/FFmpeg/...> with the same
// class names and the static entry points LibMedia's registries call, which all report "no decoder"
// (engine/platform/MediaWithoutFFmpeg.cpp).
#pragma once

#include <AK/NonnullRefPtr.h>
#include <LibMedia/CodecID.h>
#include <LibMedia/ContainerID.h>
#include <LibMedia/DecoderError.h>
#include <LibMedia/Demuxer.h>
#include <LibMedia/Forward.h>

namespace Media::FFmpeg {

class FFmpegDemuxer final {
public:
    static DecoderErrorOr<NonnullRefPtr<Demuxer>> from_stream(NonnullRefPtr<MediaStream> const&);
    static bool supports_container_mime_type(ContainerMimeType);
    static bool supports_codec_in_container(ContainerID, CodecID);
};

}
