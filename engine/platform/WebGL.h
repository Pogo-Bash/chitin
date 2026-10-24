// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// WebGL in the engine. LibWeb records a WebGL context's calls as a command stream for a GPU process
// (Ladybird's Services/Compositor/HostWebGLContext). The engine has no GPU process, so this is an in-process
// transport: the same executor (HostWebGLContext and its generated replayer, compiled into the module) runs the
// stream right away, and its GL calls are imports (glue/engine/58-webgl.js) answered by a WebGL context of the
// segment Worker's own, on an OffscreenCanvas only the glue holds. getParameter, extensions, shader precision and
// errors are therefore the host browser's own (docs/webgl.md).

#pragma once

namespace Ganglion {

// Gives WebGL contexts a transport (RemoteWebGLTransport::local_factory). Once, before any page script.
void install_webgl();

}
