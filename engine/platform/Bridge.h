// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The bridge to the host's JavaScript engine (Bridge.cpp, docs/phase2.md).

#pragma once

namespace Ganglion::Bridge {

// The principal realm (a JS::Realm of LibWeb's), once the host created it.
void set_realm(void* js_realm);

// A new document is about to be parsed into the (single, phase 2) realm: the host's global sheds what the
// previous page put on it. Nothing happens when no host engine is attached.
void document_reset();

// The global object (a JS::Object*) of the page's workers' environment for an origin (Host.cpp), or null.
void* worker_environment_global(char const* url, unsigned long url_length);

}
