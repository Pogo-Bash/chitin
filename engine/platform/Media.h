// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// Media playback inside the engine: an in-process media server that answers LibWeb's media client (LibMediaClient)
// over an in-process IPC transport (patch: LibIPC in-process pair), demuxes with LibMedia (Matroska/WebM for a media
// resource, LibMedia's SourceBuffer processor for MSE) and decodes through the host's WebCodecs (glue/engine/55-media.js).
// Decoded frames are painted from the display list's video sinks (Host.cpp asks media_video_sink()).

#pragma once

#include <AK/RefPtr.h>
#include <LibMedia/CodecID.h>
#include <LibMedia/Sinks/VideoSink.h>
#include <LibMedia/VideoSinkHandle.h>

namespace Ganglion {

// Installs the media client's transport factory. Once, before any page script.
void install_media();

// The sink that holds the current frame of a video sink handle, or null.
RefPtr<Media::VideoSink> media_video_sink(Media::VideoSinkHandle);

// Whether a presented frame changed since the last call (a paint is owed), and clears it.
bool media_frames_changed();
bool media_frames_pending();

// Whether the host's WebCodecs decodes the codec (the glue's probe, ganglion_media_set_codec_support).
bool host_decodes(Media::CodecID);

}
