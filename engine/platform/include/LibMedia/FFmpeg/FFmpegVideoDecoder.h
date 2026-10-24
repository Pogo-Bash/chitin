// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Ganglion replaces LibMedia's FFmpeg-backed classes: there is no FFmpeg in a segment Worker (media is
// decoded by the host's WebCodecs in phase 4). This header shadows <LibMedia/FFmpeg/...> with the same
// class names and the static entry points LibMedia's registries call, which all report "no decoder"
// (engine/platform/MediaWithoutFFmpeg.cpp).
#pragma once

#include <AK/NonnullOwnPtr.h>
#include <AK/Optional.h>
#include <LibMedia/CodecID.h>
#include <LibMedia/CodecParameters.h>
#include <LibMedia/DecoderCapabilities.h>
#include <LibMedia/DecoderError.h>
#include <LibMedia/VideoDecoder.h>

namespace Media::FFmpeg {

class FFmpegVideoDecoder : public VideoDecoder {
public:
    static Optional<DecoderCapabilities> capabilities(ParsedCodec const&);
    static DecoderErrorOr<NonnullOwnPtr<FFmpegVideoDecoder>> try_create(CodecID, ReadonlyBytes codec_initialization_data);
};

}
