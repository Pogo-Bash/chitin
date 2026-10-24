// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Handles, atoms, wrapper bookkeeping, anchors and the engine-side collector.
 *
 * The collector is the toy's LibGC: mark/sweep over all wrappables, run only at task boundaries
 * (when the glue calls ganglion_collect), so no engine frame is on the stack while it runs
 * (docs/research/bindings-and-gc.md, "LibGC inside wasm").
 */
#include "Ganglion.h"

#include <unordered_map>

namespace ganglion {

// --- Atoms ---------------------------------------------------------------------------------------

namespace {
struct AtomTable {
    std::vector<String> texts { String {} };
    std::unordered_map<String, Atom> ids;
};
AtomTable& atoms()
{
    static AtomTable* table = new AtomTable;
    return *table;
}
}

Atom intern(StringView text)
{
    auto& table = atoms();
    String key(text);
    if (auto it = table.ids.find(key); it != table.ids.end())
        return it->second;
    Atom id = static_cast<Atom>(table.texts.size());
    table.texts.push_back(key);
    table.ids.emplace(std::move(key), id);
    return id;
}

StringView atom_text(Atom atom)
{
    auto& table = atoms();
    if (atom >= table.texts.size())
        return {};
    return table.texts[atom];
}

String ascii_lowercase(StringView in)
{
    String out(in);
    for (auto& c : out)
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char16_t>(c + 32);
    return out;
}

String ascii_uppercase(StringView in)
{
    String out(in);
    for (auto& c : out)
        if (c >= 'a' && c <= 'z')
            c = static_cast<char16_t>(c - 32);
    return out;
}

String to_utf16(char const* s)
{
    String out;
    while (*s)
        out.push_back(static_cast<char16_t>(static_cast<unsigned char>(*s++)));
    return out;
}

// --- Heap ----------------------------------------------------------------------------------------

Heap& Heap::the()
{
    static Heap* heap = new Heap;
    return *heap;
}

Wrappable::Wrappable()
{
    m_handle = Heap::the().register_object(this);
}

Wrappable::~Wrappable()
{
    auto& heap = Heap::the();
    u32 index = m_handle >> 8;
    heap.m_slots[index].object = nullptr;
    heap.m_slots[index].generation = static_cast<u8>(heap.m_slots[index].generation + 1) ?: 1;
    heap.m_free.push_back(index);
    heap.m_live--;
}

// Handles are (index << 8) | generation. Index < 2^23 keeps every handle positive as an i32,
// so negative return values are free to carry error codes.
u32 Heap::register_object(Wrappable* object)
{
    u32 index;
    if (!m_free.empty()) {
        index = m_free.back();
        m_free.pop_back();
    } else {
        index = static_cast<u32>(m_slots.size());
        if (index >= (1u << 23))
            __builtin_trap();
        m_slots.push_back({});
    }
    m_slots[index].object = object;
    m_live++;
    return (index << 8) | m_slots[index].generation;
}

Wrappable* Heap::resolve(u32 handle) const
{
    u32 index = handle >> 8;
    if (index == 0 || index >= m_slots.size())
        return nullptr;
    auto const& slot = m_slots[index];
    if (slot.generation != (handle & 0xff))
        return nullptr;
    return slot.object;
}

u32 Heap::live_of_type(InterfaceId id) const
{
    u32 n = 0;
    for (auto const& slot : m_slots)
        if (slot.object && is_a(slot.object->interface_id(), id))
            n++;
    return n;
}

bool Heap::is_real_root(Wrappable* root) const
{
    return root == active_document;
}

u32 Heap::ensure_anchor(Wrappable* root)
{
    if (root->anchor_id)
        return root->anchor_id;
    u32 id;
    if (!m_free_anchor_ids.empty()) {
        id = m_free_anchor_ids.back();
        m_free_anchor_ids.pop_back();
    } else {
        id = m_next_anchor_id++;
        if (id >= (1u << 24))
            __builtin_trap();
    }
    root->anchor_id = id;
    if (is_real_root(root))
        root->pinned = true;
    js_anchor_create(id, root->pinned ? 1 : 0);
    return id;
}

bool Heap::needs_anchor(Wrappable* root)
{
    if (auto* node = root->accounting_node())
        return node->js_count >= 2 || (node->js_count >= 1 && (root->pinned || is_real_root(root)));
    // A standalone EventTarget: its wrapper plus at least one listener edge.
    return root->has_wrapper() && !static_cast<EventTarget*>(root)->listeners().empty();
}

void Heap::sync_anchor(Wrappable* root)
{
    if (root->anchor_id || !needs_anchor(root))
        return;
    ensure_anchor(root);
    std::vector<u32> handles;
    if (auto* node = root->accounting_node()) {
        std::vector<u32> edges;
        node->collect_moving(edges, handles);
    } else if (root->has_wrapper()) {
        handles.push_back(root->handle());
    }
    if (!handles.empty())
        js_anchor_adopt(root->anchor_id, handles.data(), static_cast<u32>(handles.size()));
}

void Heap::release_anchor(Wrappable* root)
{
    if (!root->anchor_id)
        return;
    js_anchor_released(root->anchor_id);
    m_free_anchor_ids.push_back(root->anchor_id);
    root->anchor_id = 0;
}

void Heap::set_pinned(Wrappable* root, bool pinned)
{
    if (root->pinned == pinned)
        return;
    root->pinned = pinned;
    if (root->anchor_id)
        js_anchor_pin(root->anchor_id, pinned ? 1 : 0);
    else if (pinned)
        sync_anchor(root);
}

// Returns (interface id << 24) | anchor id. The glue picks the wrapper class from the interface id
// and stores the anchor in the wrapper's private #anchor field.
i32 Heap::wrapper_created(u32 handle)
{
    auto* object = resolve(handle);
    if (!object)
        __builtin_trap(); // a forged or stale handle: fail closed
    if (!object->m_has_wrapper) {
        object->m_has_wrapper = true;
        if (auto* node = object->accounting_node())
            node->adjust_counts(1, 0);
    }
    u32 anchor = 0;
    if (auto* root = object->component_root()) {
        sync_anchor(root);
        anchor = root->anchor_id;
    }
    return static_cast<i32>((static_cast<u32>(object->interface_id()) << 24) | anchor);
}

void Heap::wrapper_dropped(u32 handle)
{
    auto* object = resolve(handle);
    if (!object || !object->m_has_wrapper)
        return;
    object->m_has_wrapper = false;
    auto* root = object->component_root();
    if (auto* node = object->accounting_node()) {
        node->adjust_counts(-1, 0);
        // Nothing in the component is referenced from JS any more: its anchor is empty or dead.
        if (root && static_cast<Node*>(root)->js_count == 0)
            release_anchor(root);
    } else if (root) {
        // A standalone EventTarget: its anchor held only its own wrapper and edges, and died with it.
        static_cast<EventTarget*>(root)->drop_all_edges();
        release_anchor(root);
    }
}

namespace {
struct WorklistVisitor final : Visitor {
    std::vector<Wrappable*> work;
    void visit(Wrappable* object) override
    {
        if (object)
            work.push_back(object);
    }
};
}

u32 Heap::collect()
{
    // Phase 1: which components must stay pinned. Mark from the real roots only (the active
    // document; in Ladybird also ActivityRoots, task queues, the event being dispatched). Live
    // wrappers do not count here, or every component with a wrapper would pin itself.
    for (auto& slot : m_slots)
        if (slot.object)
            slot.object->pin_marked = slot.object->marked = false;

    WorklistVisitor visitor;
    auto drain_pin = [&] {
        while (!visitor.work.empty()) {
            auto* object = visitor.work.back();
            visitor.work.pop_back();
            if (object->pin_marked)
                continue;
            object->pin_marked = true;
            object->visit_edges(visitor);
        }
    };
    if (active_document)
        visitor.visit(active_document);
    drain_pin();

    // Phase 1b, the conservative rule for the known leak class: an engine edge that leaves its
    // component from an object JS can still reach pins whatever it reaches. V8 cannot see this edge,
    // so without the rule the target's listeners could die while it is still reachable.
    if (cross_pin_rule) {
        struct CrossVisitor final : Visitor {
            Wrappable* from_component;
            WorklistVisitor* out;
            void visit(Wrappable* target) override
            {
                if (target && !target->pin_marked && target->component_root() != from_component)
                    out->visit(target);
            }
        } cross;
        cross.out = &visitor;
        for (auto& slot : m_slots) {
            auto* object = slot.object;
            if (!object || !object->m_has_wrapper)
                continue;
            cross.from_component = object->component_root();
            object->visit_edges(cross);
        }
        drain_pin();
    }

    // Phase 2: liveness. Roots are the real roots plus every object with a live wrapper.
    auto drain_mark = [&] {
        while (!visitor.work.empty()) {
            auto* object = visitor.work.back();
            visitor.work.pop_back();
            if (object->marked)
                continue;
            object->marked = true;
            object->visit_edges(visitor);
        }
    };
    if (active_document)
        visitor.visit(active_document);
    for (auto& slot : m_slots)
        if (slot.object && slot.object->m_has_wrapper)
            visitor.visit(slot.object);
    drain_mark();

    // Phase 3: sweep. Unlink cross-component counters first, then release anchors, then free.
    std::vector<Wrappable*> dead;
    for (auto& slot : m_slots)
        if (slot.object && !slot.object->marked)
            dead.push_back(slot.object);
    for (auto* object : dead) {
        if (object->interface_id() == InterfaceId::Range) {
            auto* range = static_cast<Range*>(object);
            if (range->m_start && range->m_start->marked)
                range->m_start->adjust_counts(0, -1);
            range->m_start = nullptr;
        }
        if (object->anchor_id)
            release_anchor(object);
    }
    for (auto* object : dead)
        delete object;

    // Phase 4: pin diffs for the surviving component roots.
    u32 pinned_count = 0;
    for (auto& slot : m_slots) {
        auto* object = slot.object;
        if (!object || object->component_root() != object)
            continue;
        bool pinned = object->pin_marked || is_real_root(object);
        set_pinned(object, pinned);
        if (pinned)
            pinned_count++;
    }
    pinned_components = pinned_count;
    last_freed = static_cast<u32>(dead.size());
    return last_freed;
}

}
