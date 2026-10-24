// SPDX-License-Identifier: GPL-2.0-or-later
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

// Whether a presented frame the engine draws itself changed since the last call, and clears it (a hosted sink's new
// frame is the carapace's to show: docs/youtube.md "Video on the host").
bool media_frames_changed();
// The host frame a sink shows (0: none, or the engine holds the pixels), and whether the engine lifts that sink's
// DrawVideoFrame out to the carapace this paint (Layers.cpp).
u32 media_sink_host_frame(Media::VideoSinkHandle);
void media_sink_set_hosted(Media::VideoSinkHandle, bool);
bool media_frames_pending();

// Whether the host's WebCodecs decodes the codec (the glue's probe, ganglion_media_set_codec_support).
bool host_decodes(Media::CodecID);

}
