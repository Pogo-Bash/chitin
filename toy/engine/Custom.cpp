// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Hand-written C exports for IDL members marked [ImplementedInBindings] (their JS side is in
 * glue/custom/). The callback itself never reaches the engine: it is stored on the anchor, and the
 * engine keeps only the callback's identity (an id from the glue's WeakMap) and the edge id.
 */
#include "Bindings.h"

using namespace ganglion;
using namespace ganglion::bindings;

GANGLION_EXPORT("ganglion_EventTarget_addEventListener") i32 ganglion_EventTarget_addEventListener(u32 self_handle, u32 type_ptr, u32 type_len, u32 callback_id, i32 capture, i32 once, i32 passive)
{
    auto& self = resolve<EventTarget>(self_handle);
    return static_cast<i32>(self.add_event_listener(intern(in_string(type_ptr, type_len)), callback_id, capture != 0, once != 0, passive != 0));
}

GANGLION_EXPORT("ganglion_EventTarget_removeEventListener") i32 ganglion_EventTarget_removeEventListener(u32 self_handle, u32 type_ptr, u32 type_len, u32 callback_id, i32 capture)
{
    auto& self = resolve<EventTarget>(self_handle);
    return static_cast<i32>(self.remove_event_listener(intern(in_string(type_ptr, type_len)), callback_id, capture != 0));
}
