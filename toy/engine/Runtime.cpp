// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Hand-written exports: lifecycle, wrapper bookkeeping, collection, input and paint.
 * The per-member DOM exports are generated from IDL (build/gen/Bindings.gen.cpp).
 */
#include "Bindings.h"

#include <cstdlib>

namespace ganglion::bindings {

IO& io()
{
    static IO* block = [] {
        auto* b = new IO {};
        b->in_capacity = 32 * 1024;
        b->in_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(std::malloc(b->in_capacity * 2)));
        return b;
    }();
    return *block;
}

static String& out_buffer()
{
    static String* buffer = new String;
    return *buffer;
}

i32 out_string(StringView s)
{
    auto& buffer = out_buffer();
    buffer.assign(s);
    io().out_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(buffer.data()));
    io().out_length = static_cast<u32>(buffer.size());
    return static_cast<i32>(buffer.size());
}

static std::vector<u32>& display_list()
{
    static auto* list = new std::vector<u32>;
    return *list;
}

}

using namespace ganglion;
using namespace ganglion::bindings;

GANGLION_EXPORT("ganglion_init") i32 ganglion_init(f64 width, f64 height)
{
    auto& heap = Heap::the();
    if (!heap.active_document) {
        heap.active_document = new Document;
        heap.active_document->pinned = true;
    }
    heap.active_document->viewport_width = width;
    heap.active_document->viewport_height = height;
    (void)io();
    return static_cast<i32>(heap.active_document->handle());
}

GANGLION_EXPORT("ganglion_io") u32 ganglion_io()
{
    return static_cast<u32>(reinterpret_cast<uintptr_t>(&io()));
}

GANGLION_EXPORT("ganglion_in_reserve") u32 ganglion_in_reserve(u32 units)
{
    auto& block = io();
    if (units > block.in_capacity) {
        u32 capacity = block.in_capacity;
        while (capacity < units)
            capacity *= 2;
        std::free(reinterpret_cast<void*>(static_cast<uintptr_t>(block.in_ptr)));
        block.in_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(std::malloc(capacity * 2)));
        block.in_capacity = capacity;
    }
    return block.in_ptr;
}

GANGLION_EXPORT("ganglion_atom_text") i32 ganglion_atom_text(u32 atom)
{
    return out_string(atom_text(atom));
}

GANGLION_EXPORT("ganglion_wrapper_created") i32 ganglion_wrapper_created(u32 handle)
{
    return Heap::the().wrapper_created(handle);
}

GANGLION_EXPORT("ganglion_wrapper_dropped") void ganglion_wrapper_dropped(u32 handle)
{
    Heap::the().wrapper_dropped(handle);
}

GANGLION_EXPORT("ganglion_collect") u32 ganglion_collect()
{
    return Heap::the().collect();
}

GANGLION_EXPORT("ganglion_set_cross_pin_rule") void ganglion_set_cross_pin_rule(i32 on)
{
    Heap::the().cross_pin_rule = on != 0;
}

GANGLION_EXPORT("ganglion_stat") u32 ganglion_stat(u32 which)
{
    auto& heap = Heap::the();
    switch (which) {
    case 0: return heap.live_objects();
    case 1: return heap.live_of_type(InterfaceId::Node);
    case 2: return heap.pinned_components;
    case 3: return heap.active_document ? heap.active_document->layout_count : 0;
    case 4: return heap.last_freed;
    case 5: return heap.live_of_type(InterfaceId::Range);
    case 6: return heap.live_of_type(InterfaceId::Event);
    case 7: return heap.active_document ? heap.active_document->js_count : 0;
    default: return 0;
    }
}

GANGLION_EXPORT("ganglion_set_viewport") void ganglion_set_viewport(f64 width, f64 height)
{
    auto* document = Heap::the().active_document;
    document->viewport_width = width;
    document->viewport_height = height;
    document->invalidate_layout();
}

// Lays out and paints if anything changed (or if forced). Returns the display list length in words
// (pointer in io().out_ptr), or 0 if there was nothing to paint.
GANGLION_EXPORT("ganglion_paint") i32 ganglion_paint(i32 force)
{
    auto* document = Heap::the().active_document;
    if (!force && !document->needs_paint())
        return 0;
    auto& list = display_list();
    document->paint(list);
    io().out_ptr = static_cast<u32>(reinterpret_cast<uintptr_t>(list.data()));
    io().out_length = static_cast<u32>(list.size());
    return static_cast<i32>(list.size());
}

// Trusted pointer input from the carapace, already in page CSS pixels.
// kind: 0 pointerdown, 1 pointerup, 2 pointermove, 3 click. Returns the target's handle.
GANGLION_EXPORT("ganglion_pointer") i32 ganglion_pointer(u32 kind, f64 x, f64 y, i32 button, u32 buttons)
{
    static char16_t const* names[] = { u"pointerdown", u"pointerup", u"pointermove", u"click" };
    if (kind > 3)
        return 0;
    auto* document = Heap::the().active_document;
    EventTarget* target = document->hit_test(x, y);
    if (!target)
        target = document;
    auto* event = new MouseEvent;
    event->m_type = intern(names[kind]);
    event->m_bubbles = true;
    event->m_cancelable = kind != 2;
    event->m_trusted = true;
    event->m_time_stamp = js_now();
    event->m_x = x;
    event->m_y = y;
    event->m_button = button;
    event->m_buttons = buttons;
    dispatch(*target, *event);
    return static_cast<i32>(target->handle());
}

// kind: 0 keydown, 1 keyup. The key string is in the input buffer.
GANGLION_EXPORT("ganglion_key") void ganglion_key(u32 kind, u32 ptr, u32 length)
{
    auto* document = Heap::the().active_document;
    auto* event = new KeyboardEvent;
    event->m_type = intern(kind == 0 ? u"keydown" : u"keyup");
    event->m_bubbles = true;
    event->m_cancelable = true;
    event->m_trusted = true;
    event->m_time_stamp = js_now();
    event->m_key = in_string(ptr, length);
    EventTarget* target = document->body() ? static_cast<EventTarget*>(document->body()) : document;
    dispatch(*target, *event);
}

// Call-cost baselines.
GANGLION_EXPORT("ganglion_noop") i32 ganglion_noop() { return 0; }
GANGLION_EXPORT("ganglion_noop_handle") i32 ganglion_noop_handle(u32 handle)
{
    return Heap::the().resolve(handle) ? 1 : 0;
}
GANGLION_EXPORT("ganglion_string_in") i32 ganglion_string_in(u32 ptr, u32 length)
{
    String copy(in_string(ptr, length));
    return static_cast<i32>(copy.size());
}
GANGLION_EXPORT("ganglion_string_out") i32 ganglion_string_out(u32 length)
{
    static String* text = new String;
    if (text->size() != length) {
        text->assign(length, u'x');
    }
    return out_string(*text);
}
