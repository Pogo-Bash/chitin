// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * Tree operations, listeners and event dispatch.
 *
 * Every tree mutation keeps components and anchors in step (bindings-and-gc.md, "Tree mutations"):
 * insert merges the inserted subtree's component into the parent's, remove splits the removed
 * subtree into a component of its own. Only subtrees that hold wrappers or listener edges
 * (js_count > 0) cost anything.
 */
#include "Ganglion.h"

namespace ganglion {

// --- EventTarget ---------------------------------------------------------------------------------

static u32 s_next_edge_id = 1;

u32 EventTarget::add_event_listener(Atom type, u32 callback_id, bool capture, bool once, bool passive)
{
    for (auto& listener : m_listeners)
        if (!listener.removed && listener.type == type && listener.callback_id == callback_id && listener.capture == capture)
            return 0;
    u32 edge = s_next_edge_id++;
    if (s_next_edge_id == 0)
        s_next_edge_id = 1;
    m_listeners.push_back({ type, callback_id, edge, capture, once, passive, false });
    if (auto* node = accounting_node())
        node->adjust_counts(1, 0);
    // The glue stores the callback on the component's anchor right after this returns.
    if (auto* root = component_root())
        Heap::the().sync_anchor(root);
    return edge;
}

u32 EventTarget::remove_event_listener(Atom type, u32 callback_id, bool capture)
{
    for (size_t i = 0; i < m_listeners.size(); i++) {
        auto& listener = m_listeners[i];
        if (listener.removed || listener.type != type || listener.callback_id != callback_id || listener.capture != capture)
            continue;
        u32 edge = listener.edge_id;
        m_listeners.erase(m_listeners.begin() + static_cast<long>(i));
        if (auto* node = accounting_node())
            node->adjust_counts(-1, 0);
        return edge;
    }
    return 0;
}

void EventTarget::edges_in(std::vector<u32>& out) const
{
    for (auto const& listener : m_listeners)
        if (!listener.removed)
            out.push_back(listener.edge_id);
}

void EventTarget::drop_all_edges()
{
    if (auto* node = accounting_node())
        node->adjust_counts(-static_cast<i32>(m_listeners.size()), 0);
    m_listeners.clear();
}

ExceptionOr<bool> EventTarget::dispatch_event_for_bindings(Event& event)
{
    if (event.m_dispatching)
        return Error::InvalidStateError;
    event.m_trusted = false;
    return dispatch(*this, event);
}

// --- Event ---------------------------------------------------------------------------------------

void Event::visit_edges(Visitor& visitor)
{
    visitor.visit(m_target);
    visitor.visit(m_current_target);
}

Event* Event::construct(StringView type, bool bubbles, bool cancelable, bool)
{
    auto* event = new Event;
    event->m_type = intern(type);
    event->m_bubbles = bubbles;
    event->m_cancelable = cancelable;
    event->m_time_stamp = js_now();
    return event;
}

static void inner_invoke(EventTarget& target, Event& event, bool capture_pass)
{
    event.m_current_target = &target;
    // Snapshot edge ids: listeners added during dispatch do not run, removed ones are skipped
    // (https://dom.spec.whatwg.org/#concept-event-listener-invoke, "clone of listeners").
    std::vector<u32> edges;
    for (auto const& listener : target.listeners())
        if (listener.type == event.m_type && listener.capture == capture_pass)
            edges.push_back(listener.edge_id);
    for (u32 edge : edges) {
        auto& list = target.listeners();
        EventTarget::Listener* found = nullptr;
        for (auto& listener : list)
            if (listener.edge_id == edge && !listener.removed)
                found = &listener;
        if (!found)
            continue;
        bool once = found->once;
        bool passive = found->passive;
        if (once)
            target.remove_event_listener(found->type, found->callback_id, found->capture);
        auto* root = target.component_root();
        if (!root || !root->anchor_id)
            continue; // the anchor (and the callback) died: nothing left to call
        event.m_in_passive_listener = passive;
        js_invoke_listener(root->anchor_id, edge, target.handle(), event.handle(), once ? 1 : 0);
        event.m_in_passive_listener = false;
        if (event.m_stop_immediate)
            return;
    }
}

bool dispatch(EventTarget& target, Event& event)
{
    event.m_dispatching = true;
    event.m_target = &target;
    std::vector<EventTarget*> path;
    for (EventTarget* t = &target; t; t = t->get_the_parent(event))
        path.push_back(t);

    for (size_t i = path.size(); i-- > 1;) {
        event.m_phase = 1;
        inner_invoke(*path[i], event, true);
        if (event.m_stop_propagation)
            break;
    }
    if (!event.m_stop_propagation) {
        event.m_phase = 2;
        inner_invoke(target, event, true);
        if (!event.m_stop_immediate)
            inner_invoke(target, event, false);
    }
    if (event.m_bubbles) {
        for (size_t i = 1; i < path.size() && !event.m_stop_propagation; i++) {
            event.m_phase = 3;
            inner_invoke(*path[i], event, false);
        }
    }
    event.m_phase = 0;
    event.m_current_target = nullptr;
    event.m_dispatching = false;
    event.m_stop_propagation = event.m_stop_immediate = false;
    return !event.m_canceled;
}

// --- Node ----------------------------------------------------------------------------------------

Node::~Node() = default;

void Node::visit_edges(Visitor& visitor)
{
    visitor.visit(m_document == this ? nullptr : m_document);
    visitor.visit(m_parent);
    for (auto* child = m_first_child; child; child = child->m_next_sibling)
        visitor.visit(child);
}

Node& Node::root()
{
    Node* node = this;
    while (node->m_parent)
        node = node->m_parent;
    return *node;
}

bool Node::is_connected()
{
    return &root() == m_document;
}

Document* Node::owner_document() const
{
    return is_document() ? nullptr : m_document;
}

Element* Node::parent_element() const
{
    return m_parent && m_parent->is_element() ? static_cast<Element*>(m_parent) : nullptr;
}

bool Node::is_inclusive_ancestor_of(Node const& other) const
{
    for (Node const* n = &other; n; n = n->m_parent)
        if (n == this)
            return true;
    return false;
}

bool Node::contains(Node* other) const
{
    return other && is_inclusive_ancestor_of(*other);
}

void Node::adjust_counts(i32 js_delta, i32 cross_delta)
{
    for (Node* n = this; n; n = n->m_parent) {
        n->js_count = static_cast<u32>(static_cast<i32>(n->js_count) + js_delta);
        n->cross_count = static_cast<u32>(static_cast<i32>(n->cross_count) + cross_delta);
    }
}

void Node::collect_text(String& out) const
{
    for (auto* child = m_first_child; child; child = child->m_next_sibling) {
        if (child->is_text())
            out += static_cast<Text const*>(child)->data();
        else
            child->collect_text(out);
    }
}

std::optional<String> Node::text_content() const
{
    if (is_document())
        return {};
    if (is_text())
        return static_cast<Text const*>(this)->data();
    String out;
    collect_text(out);
    return out;
}

void Node::set_text_content(std::optional<StringView> value)
{
    if (is_document())
        return;
    if (is_text()) {
        static_cast<Text*>(this)->set_data(value.value_or(StringView {}));
        return;
    }
    while (m_first_child)
        remove_node(*m_first_child);
    if (value && !value->empty())
        insert_node(*m_document->create_text_node(*value), nullptr);
    m_document->invalidate_layout();
}

ExceptionOr<Node*> Node::pre_insert(Node& node, Node* child)
{
    // https://dom.spec.whatwg.org/#concept-node-ensure-pre-insertion-validity (subset)
    if (!is_document() && !is_element())
        return Error::HierarchyRequestError;
    if (node.is_inclusive_ancestor_of(*this))
        return Error::HierarchyRequestError;
    if (child && child->m_parent != this)
        return Error::NotFoundError;
    if (node.is_document())
        return Error::HierarchyRequestError;
    if (is_document() && (node.is_text() || (node.is_element() && static_cast<Document*>(this)->document_element() && &node != static_cast<Document*>(this)->document_element())))
        return Error::HierarchyRequestError;
    if (&node.document() != m_document && !is_document())
        return Error::WrongDocumentError; // the toy has one document; real DOM adopts here

    Node* reference = child;
    if (reference == &node)
        reference = node.m_next_sibling;
    if (node.m_parent) {
        // A move. Within one tree the component does not change; across trees the subtree's
        // edges and wrappers go straight from the old anchor to the new one.
        Node& old_root = node.root();
        node.m_parent->remove_node(node, Split::No);
        insert_node(node, reference, &old_root == &root() ? nullptr : &old_root);
        return &node;
    }
    insert_node(node, reference);
    return &node;
}

ExceptionOr<Node*> Node::pre_remove(Node& child)
{
    if (child.m_parent != this)
        return Error::NotFoundError;
    remove_node(child);
    return &child;
}

ExceptionOr<void> Node::remove()
{
    if (m_parent)
        m_parent->remove_node(*this);
    return {};
}

void Node::insert_node(Node& node, Node* child, Node* moved_from)
{
    node.m_parent = this;
    if (child) {
        node.m_next_sibling = child;
        node.m_previous_sibling = child->m_previous_sibling;
        if (child->m_previous_sibling)
            child->m_previous_sibling->m_next_sibling = &node;
        else
            m_first_child = &node;
        child->m_previous_sibling = &node;
    } else {
        node.m_previous_sibling = m_last_child;
        if (m_last_child)
            m_last_child->m_next_sibling = &node;
        else
            m_first_child = &node;
        m_last_child = &node;
    }
    adjust_counts(static_cast<i32>(node.js_count), static_cast<i32>(node.cross_count));

    auto& heap = Heap::the();
    Node& into = root();
    if (moved_from) {
        // A move between trees: the subtree's JS state goes from the old component's anchor (if
        // any) straight to ours (if we need one), or its wrappers are detached from the old anchor.
        if (node.cross_count > 0)
            heap.set_pinned(&into, true);
        if (node.js_count > 0) {
            heap.sync_anchor(&into);
            if (moved_from->anchor_id || into.anchor_id) {
                std::vector<u32> edges;
                std::vector<u32> handles;
                node.collect_moving(edges, handles);
                js_anchor_split(moved_from->anchor_id, into.anchor_id, edges.data(), static_cast<u32>(edges.size()), handles.data(), static_cast<u32>(handles.size()));
            }
            if (moved_from->js_count == 0 && !heap.is_real_root(moved_from))
                heap.release_anchor(moved_from);
        }
        m_document->invalidate_layout();
        return;
    }
    if (node.anchor_id == 0 && node.js_count == 0 && !node.pinned) {
        m_document->invalidate_layout();
        return; // nothing of the subtree is known to JS: no component bookkeeping at all
    }

    // Merge the inserted subtree's component into ours.
    bool want_pinned = into.pinned || node.pinned || heap.is_real_root(&into);
    if (node.anchor_id && into.anchor_id) {
        js_anchor_merge(node.anchor_id, into.anchor_id);
        heap.recycle_anchor_id(node.anchor_id);
        node.anchor_id = 0;
    } else if (node.anchor_id) {
        // We had no anchor: adopt the subtree's, then bring in our own wrappers, if any.
        bool had_footprint = into.js_count > node.js_count;
        into.anchor_id = node.anchor_id;
        into.pinned = node.pinned;
        node.anchor_id = 0;
        if (had_footprint) {
            std::vector<u32> edges;
            std::vector<u32> handles;
            into.collect_moving(edges, handles);
            js_anchor_adopt(into.anchor_id, handles.data(), static_cast<u32>(handles.size()));
        }
    } else if (into.anchor_id && node.js_count > 0) {
        std::vector<u32> edges;
        std::vector<u32> handles;
        node.collect_moving(edges, handles);
        js_anchor_adopt(into.anchor_id, handles.data(), static_cast<u32>(handles.size()));
    }
    node.pinned = false;
    heap.set_pinned(&into, want_pinned);
    heap.sync_anchor(&into);
    m_document->invalidate_layout();
}

void Node::collect_moving(std::vector<u32>& edges, std::vector<u32>& handles)
{
    if (js_count == 0)
        return;
    if (has_wrapper())
        handles.push_back(handle());
    edges_in(edges);
    if (is_element()) {
        if (auto* style = static_cast<Element*>(this)->style_if_exists(); style && style->has_wrapper())
            handles.push_back(style->handle());
    }
    for (auto* child = m_first_child; child; child = child->m_next_sibling)
        child->collect_moving(edges, handles);
}

void Node::remove_node(Node& node, Split split)
{
    Node& from = root();
    if (node.m_previous_sibling)
        node.m_previous_sibling->m_next_sibling = node.m_next_sibling;
    else
        m_first_child = node.m_next_sibling;
    if (node.m_next_sibling)
        node.m_next_sibling->m_previous_sibling = node.m_previous_sibling;
    else
        m_last_child = node.m_previous_sibling;
    node.m_parent = node.m_next_sibling = node.m_previous_sibling = nullptr;
    adjust_counts(-static_cast<i32>(node.js_count), -static_cast<i32>(node.cross_count));
    if (split == Split::No) {
        m_document->invalidate_layout();
        return;
    }

    // Split: the removed subtree becomes its own component. If something outside points into it
    // through an engine edge (a Range), pin it until the next collection decides precisely.
    node.pinned = node.cross_count > 0;
    if (node.js_count > 0) {
        auto& heap = Heap::the();
        if (heap.needs_anchor(&node))
            heap.ensure_anchor(&node);
        if (from.anchor_id || node.anchor_id) {
            // Moves the subtree's edges and wrappers to its new anchor, or detaches its lone
            // wrapper from the old one.
            std::vector<u32> edges;
            std::vector<u32> handles;
            node.collect_moving(edges, handles);
            js_anchor_split(from.anchor_id, node.anchor_id, edges.data(), static_cast<u32>(edges.size()), handles.data(), static_cast<u32>(handles.size()));
        }
        // If the old component has nothing left in JS, its anchor is now empty.
        if (from.js_count == 0 && !heap.is_real_root(&from))
            heap.release_anchor(&from);
    }
    m_document->invalidate_layout();
}

// --- CharacterData / Text --------------------------------------------------------------------

void CharacterData::set_data(StringView data)
{
    m_data = data;
    document().invalidate_layout();
}

void CharacterData::append_data(StringView data)
{
    m_data += data;
    document().invalidate_layout();
}

Atom Text::node_name() const
{
    static Atom atom = intern(u"#text");
    return atom;
}

// --- Element -----------------------------------------------------------------------------------

Element::Element(Document* d, Atom local_name)
    : Node(d)
    , m_local_name(local_name)
    , m_tag_name(intern(ascii_uppercase(atom_text(local_name))))
{
}

Element::~Element() = default;

void Element::visit_edges(Visitor& visitor)
{
    Node::visit_edges(visitor);
    visitor.visit(m_style);
}

String const* Element::find_attribute(StringView name) const
{
    for (auto const& attribute : m_attributes)
        if (attribute.name == name)
            return &attribute.value;
    return nullptr;
}

std::optional<String> Element::get_attribute(StringView name) const
{
    String lower = ascii_lowercase(name);
    if (auto const* value = find_attribute(lower))
        return *value;
    return {};
}

String Element::id() const
{
    auto const* value = find_attribute(u"id");
    return value ? *value : String {};
}

String Element::class_name() const
{
    auto const* value = find_attribute(u"class");
    return value ? *value : String {};
}

static bool is_valid_name(StringView name)
{
    if (name.empty())
        return false;
    for (char16_t c : name)
        if (c == ' ' || c == '\t' || c == '\n' || c == '<' || c == '>' || c == '/' || c == '=' || c == '"' || c == '\'')
            return false;
    return true;
}

void Element::set_attribute_value(StringView name, StringView value)
{
    bool found = false;
    for (auto& attribute : m_attributes) {
        if (attribute.name == name) {
            attribute.value = value;
            found = true;
        }
    }
    if (!found)
        m_attributes.push_back({ String(name), String(value) });
    if (name == u"style") {
        // The style attribute and the inline declaration are one: reparse.
        inline_style.clear();
        style()->set_css_text(value);
    }
}

ExceptionOr<void> Element::set_attribute(StringView name, StringView value)
{
    if (!is_valid_name(name))
        return Error::InvalidCharacterError;
    set_attribute_value(ascii_lowercase(name), value);
    return {};
}

ExceptionOr<void> Element::remove_attribute(StringView name)
{
    String lower = ascii_lowercase(name);
    for (size_t i = 0; i < m_attributes.size(); i++) {
        if (m_attributes[i].name == lower) {
            m_attributes.erase(m_attributes.begin() + static_cast<long>(i));
            if (lower == u"style") {
                inline_style.clear();
                style_changed();
            }
            break;
        }
    }
    return {};
}

CSSStyleDeclaration* Element::style()
{
    if (!m_style)
        m_style = new CSSStyleDeclaration(*this);
    return m_style;
}

// --- Range ---------------------------------------------------------------------------------------

Range::Range(Document& d) : m_start(&d)
{
    d.adjust_counts(0, 1);
}

Range::~Range()
{
    if (m_start)
        m_start->adjust_counts(0, -1);
}

void Range::visit_edges(Visitor& visitor)
{
    visitor.visit(m_start);
}

ExceptionOr<void> Range::set_start(Node& node, u32 offset)
{
    u32 length = 0;
    if (node.is_text())
        length = static_cast<Text&>(node).length_in_utf16_code_units();
    else
        for (auto* c = node.first_child(); c; c = c->next_sibling())
            length++;
    if (offset > length)
        return Error::IndexSizeError;
    if (m_start)
        m_start->adjust_counts(0, -1);
    node.adjust_counts(0, 1);
    m_start = &node;
    m_offset = offset;
    // Eager pin: JS holds this Range (it is calling us), so the target component must keep its
    // listeners until the next collection recomputes pins.
    auto& root = node.root();
    if (has_wrapper() && Heap::the().cross_pin_rule)
        Heap::the().set_pinned(&root, true);
    return {};
}

// --- Document ------------------------------------------------------------------------------------

Document::Document() : Node(this)
{
    auto* html = new HTMLElement(this, intern(u"html"));
    m_body = new HTMLElement(this, intern(u"body"));
    insert_node(*html, nullptr);
    html->insert_node(*m_body, nullptr);
    m_body->set_attribute_value(u"style", u"margin: 8px");
}

Atom Document::node_name() const
{
    static Atom atom = intern(u"#document");
    return atom;
}

Element* Document::document_element() const
{
    for (auto* c = first_child(); c; c = c->next_sibling())
        if (c->is_element())
            return static_cast<Element*>(c);
    return nullptr;
}

ExceptionOr<Element*> Document::create_element(StringView local_name)
{
    if (!is_valid_name(local_name))
        return Error::InvalidCharacterError;
    return static_cast<Element*>(new HTMLElement(this, intern(ascii_lowercase(local_name))));
}

Text* Document::create_text_node(StringView data)
{
    return new Text(this, data);
}

Range* Document::create_range()
{
    return new Range(*this);
}

static Element* find_by_id(Node& node, StringView id)
{
    for (auto* c = node.first_child(); c; c = c->next_sibling()) {
        if (c->is_element()) {
            auto* e = static_cast<Element*>(c);
            if (auto const* v = e->find_attribute(u"id"); v && *v == id)
                return e;
            if (auto* found = find_by_id(*e, id))
                return found;
        }
    }
    return nullptr;
}

Element* Document::get_element_by_id(StringView id)
{
    return find_by_id(*this, id);
}

}
