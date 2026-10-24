// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Ganglion toy engine: a small DOM shaped like Ladybird's LibWeb model, for Chitin phase 0.
 *
 * It is not LibWeb. It exists to prove the binding and GC designs (docs/research/bindings-and-gc.md)
 * on code with the same shape: implementation objects ("wrappables") separate from their JS
 * wrappers, a handle per object, an engine-side mark/sweep collector run at task boundaries, and
 * every engine -> JS edge stored in the V8 heap on a per-component anchor.
 *
 * Built with -fno-exceptions like Ladybird; errors travel as ExceptionOr<T>.
 */
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "InterfaceIds.gen.h"

namespace ganglion {

using u8 = uint8_t;
using u16 = uint16_t;
using u32 = uint32_t;
using i32 = int32_t;
using f64 = double;
using String = std::u16string;
using StringView = std::u16string_view;

// --- Errors ------------------------------------------------------------------------------------

// Codes crossing the boundary. 1 is a TypeError; the rest are DOMException names (glue maps them).
enum class Error : i32 {
    None = 0,
    TypeError = 1,
    HierarchyRequestError = 2,
    NotFoundError = 3,
    InvalidCharacterError = 4,
    IndexSizeError = 5,
    NotSupportedError = 6,
    InvalidStateError = 7,
    WrongDocumentError = 8,
    SyntaxError = 9,
};

template<typename T>
class [[nodiscard]] ExceptionOr {
public:
    ExceptionOr(T value) : m_value(std::move(value)) { }
    ExceptionOr(Error error) : m_error(error) { }
    bool is_error() const { return m_error != Error::None; }
    Error error() const { return m_error; }
    T& value() { return m_value; }

private:
    T m_value {};
    Error m_error { Error::None };
};

template<>
class [[nodiscard]] ExceptionOr<void> {
public:
    ExceptionOr() = default;
    ExceptionOr(Error error) : m_error(error) { }
    bool is_error() const { return m_error != Error::None; }
    Error error() const { return m_error; }

private:
    Error m_error { Error::None };
};

// --- Atoms (FlyString stand-in) ------------------------------------------------------------------

using Atom = u32;
Atom intern(StringView);
StringView atom_text(Atom);
String ascii_lowercase(StringView);
String ascii_uppercase(StringView);
String to_utf16(char const*);

// --- Imports from the glue (engine -> JS) ------------------------------------------------------

#define GANGLION_IMPORT(name) __attribute__((import_module("chitin"), import_name(#name)))
extern "C" {
GANGLION_IMPORT(anchor_create) void js_anchor_create(u32 id, i32 pinned);
GANGLION_IMPORT(anchor_merge) void js_anchor_merge(u32 from, u32 into);
GANGLION_IMPORT(anchor_adopt) void js_anchor_adopt(u32 id, u32 const* handles, u32 n_handles);
GANGLION_IMPORT(anchor_split) void js_anchor_split(u32 from, u32 to, u32 const* edges, u32 n_edges, u32 const* handles, u32 n_handles);
GANGLION_IMPORT(anchor_released) void js_anchor_released(u32 id);
GANGLION_IMPORT(anchor_pin) void js_anchor_pin(u32 id, i32 pinned);
GANGLION_IMPORT(invoke_listener) void js_invoke_listener(u32 anchor, u32 edge, u32 this_handle, u32 event_handle, i32 delete_after);
GANGLION_IMPORT(now) f64 js_now();
}

// --- Heap ---------------------------------------------------------------------------------------

class Wrappable;
class Node;
class Element;
class HTMLElement;
class Text;
class Document;
class Event;
class EventTarget;
class CSSStyleDeclaration;
class Range;

struct Visitor {
    virtual void visit(Wrappable*) = 0;
    virtual ~Visitor() = default;
};

// Base of every object page JS can hold. Mirrors Web::Bindings::Wrappable: the wrapper lives in V8,
// the engine keeps a handle and a "has live wrapper" bit.
class Wrappable {
public:
    Wrappable();
    virtual ~Wrappable();
    virtual InterfaceId interface_id() const = 0;
    virtual void visit_edges(Visitor&) { }

    // The object that identifies this object's component, or nullptr if it has no component (it
    // can hold no engine -> JS edges, so it needs no anchor: Range, Event in the toy).
    virtual Wrappable* component_root() { return nullptr; }
    // The node whose subtree counters account for this object (itself for nodes, the owner
    // element for a style declaration).
    virtual Node* accounting_node() { return nullptr; }

    u32 handle() const { return m_handle; }
    bool has_wrapper() const { return m_has_wrapper; }

    // Component bookkeeping; meaningful only on a component root.
    u32 anchor_id { 0 };
    bool pinned { false };

    // Collector state.
    bool marked { false };
    bool pin_marked { false };

private:
    friend class Heap;
    u32 m_handle { 0 };
    bool m_has_wrapper { false };
};

class Heap {
public:
    static Heap& the();

    u32 register_object(Wrappable*);
    Wrappable* resolve(u32 handle) const;
    template<typename T>
    T* resolve_as(u32 handle) const
    {
        auto* object = resolve(handle);
        if (!object || !is_a(object->interface_id(), T::static_interface_id))
            return nullptr;
        return static_cast<T*>(object);
    }

    // Wrapper lifecycle, driven by the glue.
    i32 wrapper_created(u32 handle);
    void wrapper_dropped(u32 handle);

    // Anchors.
    // Anchors are lazy: a component gets one only when it holds two or more JS items (wrappers or
    // listener edges), or when it is pinned and holds one. A lone wrapper keeps itself alive; an
    // anchor would add nothing. sync_anchor creates the anchor once that changes and adopts the
    // component's existing wrappers into it.
    bool needs_anchor(Wrappable* root);
    void sync_anchor(Wrappable* root);
    u32 ensure_anchor(Wrappable* root);
    void release_anchor(Wrappable* root);
    void recycle_anchor_id(u32 id) { m_free_anchor_ids.push_back(id); }
    void set_pinned(Wrappable* root, bool);
    bool is_real_root(Wrappable*) const;

    // Mark/sweep at a task boundary; returns the number of objects freed.
    u32 collect();
    u32 live_objects() const { return m_live; }
    u32 live_of_type(InterfaceId) const;

    bool cross_pin_rule { true };
    Document* active_document { nullptr };
    u32 last_freed { 0 };
    u32 pinned_components { 0 };

private:
    struct Slot {
        Wrappable* object { nullptr };
        u8 generation { 1 };
    };
    std::vector<Slot> m_slots { Slot {} }; // index 0 is never used: handle 0 means null
    std::vector<u32> m_free;
    std::vector<u32> m_free_anchor_ids;
    u32 m_next_anchor_id { 1 };
    u32 m_live { 0 };
    friend class Wrappable;
};

// --- Events ------------------------------------------------------------------------------------

class EventTarget : public Wrappable {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::EventTarget;
    InterfaceId interface_id() const override { return InterfaceId::EventTarget; }
    Wrappable* component_root() override { return this; }
    static EventTarget* construct() { return new EventTarget; }

    struct Listener {
        Atom type;
        u32 callback_id; // identity of the JS callback, assigned by glue (a WeakMap, not a reference)
        u32 edge_id;     // where the callback lives: anchor(component).edges[edge_id]
        bool capture;
        bool once;
        bool passive;
        bool removed;
    };

    // Returns the new edge id, or 0 if an identical listener already exists.
    u32 add_event_listener(Atom type, u32 callback_id, bool capture, bool once, bool passive);
    // Returns the removed edge id, or 0.
    u32 remove_event_listener(Atom type, u32 callback_id, bool capture);
    ExceptionOr<bool> dispatch_event_for_bindings(Event&);

    virtual EventTarget* get_the_parent(Event&) { return nullptr; }
    std::vector<Listener>& listeners() { return m_listeners; }
    void edges_in(std::vector<u32>& out) const;
    void drop_all_edges();

private:
    std::vector<Listener> m_listeners;
};

class Event : public Wrappable {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Event;
    InterfaceId interface_id() const override { return InterfaceId::Event; }
    void visit_edges(Visitor&) override;

    static Event* construct(StringView type, bool bubbles, bool cancelable, bool composed);

    Atom type() const { return m_type; }
    EventTarget* target() const { return m_target; }
    EventTarget* current_target() const { return m_current_target; }
    u32 event_phase() const { return m_phase; }
    void stop_propagation() { m_stop_propagation = true; }
    void stop_immediate_propagation() { m_stop_propagation = m_stop_immediate = true; }
    bool bubbles() const { return m_bubbles; }
    bool cancelable() const { return m_cancelable; }
    void prevent_default()
    {
        if (m_cancelable && !m_in_passive_listener)
            m_canceled = true;
    }
    bool default_prevented() const { return m_canceled; }
    bool is_trusted() const { return m_trusted; }
    f64 time_stamp() const { return m_time_stamp; }

    Atom m_type { 0 };
    EventTarget* m_target { nullptr };
    EventTarget* m_current_target { nullptr };
    u32 m_phase { 0 };
    bool m_bubbles { false };
    bool m_cancelable { false };
    bool m_canceled { false };
    bool m_stop_propagation { false };
    bool m_stop_immediate { false };
    bool m_dispatching { false };
    bool m_in_passive_listener { false };
    bool m_trusted { false };
    f64 m_time_stamp { 0 };
};

class MouseEvent final : public Event {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::MouseEvent;
    InterfaceId interface_id() const override { return InterfaceId::MouseEvent; }
    f64 client_x() const { return m_x; }
    f64 client_y() const { return m_y; }
    i32 button() const { return m_button; }
    u32 buttons() const { return m_buttons; }
    f64 m_x { 0 }, m_y { 0 };
    i32 m_button { 0 };
    u32 m_buttons { 0 };
};

class KeyboardEvent final : public Event {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::KeyboardEvent;
    InterfaceId interface_id() const override { return InterfaceId::KeyboardEvent; }
    String const& key() const { return m_key; }
    String m_key;
};

// --- Nodes -------------------------------------------------------------------------------------

struct Box {
    f64 x { 0 }, y { 0 }, width { 0 }, height { 0 };
};

class Node : public EventTarget {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Node;
    ~Node() override;
    void visit_edges(Visitor&) override;
    Wrappable* component_root() override { return &root(); }
    Node* accounting_node() override { return this; }
    EventTarget* get_the_parent(Event&) override { return m_parent; }

    virtual u32 node_type() const = 0;
    virtual Atom node_name() const = 0;
    bool is_element() const { return node_type() == 1; }
    bool is_text() const { return node_type() == 3; }
    bool is_document() const { return node_type() == 9; }

    Node& root();
    bool is_connected();
    Document* owner_document() const;
    Document& document() const { return *m_document; }
    Node* parent_node() const { return m_parent; }
    Element* parent_element() const;
    bool has_child_nodes() const { return m_first_child != nullptr; }
    Node* first_child() const { return m_first_child; }
    Node* last_child() const { return m_last_child; }
    Node* previous_sibling() const { return m_previous_sibling; }
    Node* next_sibling() const { return m_next_sibling; }
    bool contains(Node* other) const;
    bool is_inclusive_ancestor_of(Node const&) const;

    virtual std::optional<String> node_value() const { return {}; }
    virtual void set_node_value(std::optional<StringView>) { }
    std::optional<String> text_content() const;
    void set_text_content(std::optional<StringView>);

    ExceptionOr<Node*> pre_insert(Node& node, Node* child);
    ExceptionOr<Node*> append_child(Node& node) { return pre_insert(node, nullptr); }
    ExceptionOr<Node*> pre_remove(Node& child);
    ExceptionOr<void> remove();

    void collect_text(String& out) const;

    // Subtree counters (doc: "Each node keeps a count of preserved wrappers and JS edges in its
    // subtree, so moves of subtrees without them cost nothing").
    u32 js_count { 0 };    // live wrappers + listener edges in this subtree (incl. style decls)
    u32 cross_count { 0 }; // engine edges from other components (Range) into this subtree
    void adjust_counts(i32 js_delta, i32 cross_delta);
    // Lists the edges and wrapped handles in this subtree (skipping subtrees with js_count 0).
    void collect_moving(std::vector<u32>& edges, std::vector<u32>& handles);

    Box box;

protected:
    explicit Node(Document* document) : m_document(document) { }

private:
    friend class Document;
    // moved_from: the old root when `node` is moving between trees (its JS state moves anchor to
    // anchor directly, without the intermediate component a remove would create).
    void insert_node(Node& node, Node* child, Node* moved_from = nullptr);
    enum class Split { Yes, No };
    void remove_node(Node& node, Split = Split::Yes);

    Document* m_document { nullptr };
    Node* m_parent { nullptr };
    Node* m_first_child { nullptr };
    Node* m_last_child { nullptr };
    Node* m_previous_sibling { nullptr };
    Node* m_next_sibling { nullptr };
};

class CharacterData : public Node {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::CharacterData;
    String const& data() const { return m_data; }
    void set_data(StringView);
    u32 length_in_utf16_code_units() const { return static_cast<u32>(m_data.size()); }
    void append_data(StringView);
    std::optional<String> node_value() const override { return m_data; }
    void set_node_value(std::optional<StringView> v) override { set_data(v.value_or(StringView {})); }

protected:
    CharacterData(Document* d, StringView data) : Node(d), m_data(data) { }
    String m_data;
};

class Text final : public CharacterData {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Text;
    Text(Document* d, StringView data) : CharacterData(d, data) { }
    InterfaceId interface_id() const override { return InterfaceId::Text; }
    u32 node_type() const override { return 3; }
    Atom node_name() const override;
};

struct StyleProperty {
    Atom name;
    String value;
    bool important;
};

class CSSStyleDeclaration final : public Wrappable {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::CSSStyleDeclaration;
    explicit CSSStyleDeclaration(Element& owner) : m_owner(&owner) { }
    InterfaceId interface_id() const override { return InterfaceId::CSSStyleDeclaration; }
    void visit_edges(Visitor&) override;
    Wrappable* component_root() override;
    Node* accounting_node() override;

    String css_text() const;
    void set_css_text(StringView);
    u32 length() const;
    String get_property_value(StringView property) const;
    ExceptionOr<void> set_property(StringView property, StringView value, StringView priority);
    String remove_property(StringView property);

    Element* m_owner;
};

class Element : public Node {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Element;
    Element(Document* d, Atom local_name);
    ~Element() override;
    InterfaceId interface_id() const override { return InterfaceId::Element; }
    void visit_edges(Visitor&) override;
    u32 node_type() const override { return 1; }
    Atom node_name() const override { return m_tag_name; }

    Atom local_name() const { return m_local_name; }
    Atom tag_name() const { return m_tag_name; }

    String id() const;
    void set_id(StringView v) { set_attribute_value(u"id", v); }
    String class_name() const;
    void set_class_name(StringView v) { set_attribute_value(u"class", v); }

    String const* find_attribute(StringView name) const;
    std::optional<String> get_attribute(StringView name) const;
    ExceptionOr<void> set_attribute(StringView name, StringView value);
    ExceptionOr<void> remove_attribute(StringView name);
    bool has_attribute(StringView name) const { return find_attribute(name) != nullptr; }
    void set_attribute_value(StringView name, StringView value);

    Box get_bounding_client_rect();

    // Inline style, parsed into the few properties the toy layout understands.
    std::vector<StyleProperty> inline_style;
    void style_changed();
    CSSStyleDeclaration* style_if_exists() const { return m_style; }
    CSSStyleDeclaration* style();

    // Computed, for layout and paint.
    struct Computed {
        bool display_none { false };
        bool absolute { false };
        f64 width { -1 }, height { -1 }; // -1 = auto
        f64 left { 0 }, top { 0 };
        f64 margin { 0 }, padding { 0 };
        u32 background { 0 }; // RGBA, 0 = transparent
        u32 color { 0x000000ff };
        u32 border_color { 0 };
        f64 border { 0 };
    } computed;

private:
    struct Attribute {
        String name;
        String value;
    };
    Atom m_local_name;
    Atom m_tag_name;
    std::vector<Attribute> m_attributes;
    CSSStyleDeclaration* m_style { nullptr };
};

class HTMLElement final : public Element {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::HTMLElement;
    using Element::Element;
    InterfaceId interface_id() const override { return InterfaceId::HTMLElement; }
    i32 offset_top();
    i32 offset_left();
    i32 offset_width();
    i32 offset_height();
};

class Range final : public Wrappable {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Range;
    explicit Range(Document& d);
    ~Range() override;
    InterfaceId interface_id() const override { return InterfaceId::Range; }
    void visit_edges(Visitor&) override;

    Node* start_container() const { return m_start; }
    u32 start_offset() const { return m_offset; }
    ExceptionOr<void> set_start(Node& node, u32 offset);

    Node* m_start;
    u32 m_offset { 0 };
};

class Document final : public Node {
public:
    static constexpr InterfaceId static_interface_id = InterfaceId::Document;
    Document();
    InterfaceId interface_id() const override { return InterfaceId::Document; }
    u32 node_type() const override { return 9; }
    Atom node_name() const override;

    Element* document_element() const;
    HTMLElement* body() const { return m_body; }
    ExceptionOr<Element*> create_element(StringView local_name);
    Text* create_text_node(StringView data);
    Range* create_range();
    Element* get_element_by_id(StringView id);

    // Rendering.
    void invalidate_layout() { m_layout_dirty = m_paint_dirty = true; }
    void update_layout();
    bool needs_paint() const { return m_paint_dirty; }
    void paint(std::vector<u32>& out);
    Element* hit_test(f64 x, f64 y);
    f64 viewport_width { 800 }, viewport_height { 600 };
    u32 layout_count { 0 };

private:
    bool m_layout_dirty { true };
    bool m_paint_dirty { true };
    HTMLElement* m_body { nullptr };
};

// Event dispatch (https://dom.spec.whatwg.org/#concept-event-dispatch, simplified: no shadow
// trees, no activation behaviour, no window in the path).
bool dispatch(EventTarget& target, Event& event);

// Style parsing for the toy layout.
void apply_property(Element::Computed&, Atom name, StringView value);
u32 parse_color(StringView);

}
