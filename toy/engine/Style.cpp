// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
/*
 * The toy's style, layout and paint. Deliberately trivial: block boxes stacked vertically,
 * absolute positioning by left/top, monospace text at 8x16 px per character, and a display list of
 * rectangles and text runs. It exists so that layout reads after writes cost a real relayout and so
 * the segment harness has frames to send.
 */
#include "Ganglion.h"

#include <cmath>
#include <cstring>

namespace ganglion {

// --- Parsing -------------------------------------------------------------------------------------

static StringView trim(StringView s)
{
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n'))
        s.remove_prefix(1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n'))
        s.remove_suffix(1);
    return s;
}

static bool parse_px(StringView s, f64& out)
{
    s = trim(s);
    if (s.size() >= 2 && s.substr(s.size() - 2) == u"px")
        s.remove_suffix(2);
    if (s.empty())
        return false;
    f64 value = 0, scale = 0;
    bool negative = false;
    size_t i = 0;
    if (s[0] == '-') {
        negative = true;
        i = 1;
    }
    bool any = false;
    for (; i < s.size(); i++) {
        char16_t c = s[i];
        if (c >= '0' && c <= '9') {
            any = true;
            if (scale == 0) {
                value = value * 10 + (c - '0');
            } else {
                value += (c - '0') * scale;
                scale /= 10;
            }
        } else if (c == '.' && scale == 0) {
            scale = 0.1;
        } else {
            return false;
        }
    }
    if (!any)
        return false;
    out = negative ? -value : value;
    return true;
}

static int hex(char16_t c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

u32 parse_color(StringView s)
{
    s = trim(s);
    if (!s.empty() && s[0] == '#') {
        if (s.size() == 4) {
            int r = hex(s[1]), g = hex(s[2]), b = hex(s[3]);
            if (r < 0 || g < 0 || b < 0)
                return 0;
            return static_cast<u32>((r * 17) << 24 | (g * 17) << 16 | (b * 17) << 8 | 0xff);
        }
        if (s.size() == 7) {
            u32 v = 0;
            for (size_t i = 1; i < 7; i++) {
                int h = hex(s[i]);
                if (h < 0)
                    return 0;
                v = v << 4 | static_cast<u32>(h);
            }
            return v << 8 | 0xff;
        }
        return 0;
    }
    String lower = ascii_lowercase(s);
    struct Named {
        char16_t const* name;
        u32 rgba;
    };
    static constexpr Named named[] = {
        { u"black", 0x000000ff }, { u"white", 0xffffffff }, { u"red", 0xff0000ff }, { u"green", 0x008000ff },
        { u"blue", 0x0000ffff }, { u"gray", 0x808080ff }, { u"grey", 0x808080ff }, { u"orange", 0xffa500ff },
        { u"yellow", 0xffff00ff }, { u"purple", 0x800080ff }, { u"brown", 0xa52a2aff }, { u"olive", 0x808000ff },
        { u"teal", 0x008080ff }, { u"navy", 0x000080ff }, { u"silver", 0xc0c0c0ff }, { u"transparent", 0 },
    };
    for (auto const& n : named)
        if (lower == n.name)
            return n.rgba;
    if (lower.rfind(u"rgb(", 0) == 0 && lower.back() == ')') {
        StringView inner = StringView(lower).substr(4, lower.size() - 5);
        u32 parts[3] = {};
        int index = 0;
        size_t start = 0;
        for (size_t i = 0; i <= inner.size() && index < 3; i++) {
            if (i == inner.size() || inner[i] == ',') {
                f64 v = 0;
                if (!parse_px(inner.substr(start, i - start), v))
                    return 0;
                parts[index++] = static_cast<u32>(std::fmin(255, std::fmax(0, v)));
                start = i + 1;
            }
        }
        if (index == 3)
            return parts[0] << 24 | parts[1] << 16 | parts[2] << 8 | 0xff;
    }
    return 0;
}

void apply_property(Element::Computed& c, Atom name, StringView value)
{
    StringView n = atom_text(name);
    f64 px = 0;
    if (n == u"display")
        c.display_none = trim(value) == u"none";
    else if (n == u"position")
        c.absolute = trim(value) == u"absolute";
    else if (n == u"width")
        c.width = parse_px(value, px) ? px : -1;
    else if (n == u"height")
        c.height = parse_px(value, px) ? px : -1;
    else if (n == u"left")
        c.left = parse_px(value, px) ? px : 0;
    else if (n == u"top")
        c.top = parse_px(value, px) ? px : 0;
    else if (n == u"margin")
        c.margin = parse_px(value, px) ? px : 0;
    else if (n == u"padding")
        c.padding = parse_px(value, px) ? px : 0;
    else if (n == u"background-color" || n == u"background")
        c.background = parse_color(value);
    else if (n == u"color")
        c.color = parse_color(value);
    else if (n == u"border-width")
        c.border = parse_px(value, px) ? px : 0;
    else if (n == u"border-color")
        c.border_color = parse_color(value);
}

// --- CSSStyleDeclaration ---------------------------------------------------------------------

void CSSStyleDeclaration::visit_edges(Visitor& visitor)
{
    visitor.visit(m_owner);
}

Wrappable* CSSStyleDeclaration::component_root()
{
    return &m_owner->root();
}

Node* CSSStyleDeclaration::accounting_node()
{
    return m_owner;
}

String CSSStyleDeclaration::css_text() const
{
    String out;
    for (auto const& p : m_owner->inline_style) {
        if (!out.empty())
            out += u" ";
        out += atom_text(p.name);
        out += u": ";
        out += p.value;
        if (p.important)
            out += u" !important";
        out += u";";
    }
    return out;
}

void CSSStyleDeclaration::set_css_text(StringView text)
{
    m_owner->inline_style.clear();
    size_t start = 0;
    for (size_t i = 0; i <= text.size(); i++) {
        if (i == text.size() || text[i] == ';') {
            StringView decl = text.substr(start, i - start);
            auto colon = decl.find(':');
            if (colon != StringView::npos) {
                StringView name = trim(decl.substr(0, colon));
                StringView value = trim(decl.substr(colon + 1));
                if (!name.empty() && !value.empty())
                    (void)set_property(name, value, u"");
            }
            start = i + 1;
        }
    }
    m_owner->style_changed();
}

u32 CSSStyleDeclaration::length() const
{
    return static_cast<u32>(m_owner->inline_style.size());
}

String CSSStyleDeclaration::get_property_value(StringView property) const
{
    Atom name = intern(ascii_lowercase(property));
    for (auto const& p : m_owner->inline_style)
        if (p.name == name)
            return p.value;
    return {};
}

ExceptionOr<void> CSSStyleDeclaration::set_property(StringView property, StringView value, StringView priority)
{
    if (value.empty()) {
        remove_property(property);
        return {};
    }
    bool important = ascii_lowercase(priority) == u"important";
    if (!priority.empty() && !important)
        return {};
    Atom name = intern(ascii_lowercase(property));
    bool found = false;
    for (auto& p : m_owner->inline_style) {
        if (p.name == name) {
            p.value = value;
            p.important = important;
            found = true;
        }
    }
    if (!found)
        m_owner->inline_style.push_back({ name, String(value), important });
    m_owner->style_changed();
    return {};
}

String CSSStyleDeclaration::remove_property(StringView property)
{
    Atom name = intern(ascii_lowercase(property));
    auto& list = m_owner->inline_style;
    for (size_t i = 0; i < list.size(); i++) {
        if (list[i].name == name) {
            String old = list[i].value;
            list.erase(list.begin() + static_cast<long>(i));
            m_owner->style_changed();
            return old;
        }
    }
    return {};
}

void Element::style_changed()
{
    computed = {};
    for (auto const& p : inline_style)
        apply_property(computed, p.name, p.value);
    document().invalidate_layout();
}

// --- Layout --------------------------------------------------------------------------------------

static constexpr f64 glyph_width = 8;
static constexpr f64 line_height = 16;

static u32 chars_per_line(f64 width)
{
    auto n = static_cast<u32>(width / glyph_width);
    return n ? n : 1;
}

static f64 layout_element(Element& e, f64 x, f64 y, f64 available_width, f64 cb_x, f64 cb_y);

static void layout_children(Element& e, f64 inner_x, f64& cursor_y, f64 inner_width)
{
    f64 cb_x = inner_x, cb_y = cursor_y;
    for (auto* child = e.first_child(); child; child = child->next_sibling()) {
        if (child->is_element()) {
            cursor_y += layout_element(static_cast<Element&>(*child), inner_x, cursor_y, inner_width, cb_x, cb_y);
        } else if (child->is_text()) {
            auto const& text = static_cast<Text&>(*child).data();
            u32 per_line = chars_per_line(inner_width);
            auto lines = static_cast<u32>((text.size() + per_line - 1) / per_line);
            f64 width = std::fmin(static_cast<f64>(text.size()) * glyph_width, inner_width);
            child->box = { inner_x, cursor_y, width, lines * line_height };
            cursor_y += lines * line_height;
        }
    }
}

static f64 layout_element(Element& e, f64 x, f64 y, f64 available_width, f64 cb_x, f64 cb_y)
{
    auto const& c = e.computed;
    if (c.display_none) {
        e.box = { x, y, 0, 0 };
        return 0;
    }
    f64 edge = c.border + c.padding;
    f64 bx, by, width;
    if (c.absolute) {
        bx = cb_x + c.left;
        by = cb_y + c.top;
        width = c.width >= 0 ? c.width + 2 * edge : 2 * edge;
    } else {
        bx = x + c.margin;
        by = y + c.margin;
        width = c.width >= 0 ? c.width + 2 * edge : std::fmax(0, available_width - 2 * c.margin);
    }
    f64 inner_x = bx + edge;
    f64 cursor = by + edge;
    layout_children(e, inner_x, cursor, std::fmax(0, width - 2 * edge));
    f64 height = c.height >= 0 ? c.height + 2 * edge : (cursor - by) + edge;
    e.box = { bx, by, width, height };
    return c.absolute ? 0 : height + 2 * c.margin;
}

void Document::update_layout()
{
    if (!m_layout_dirty)
        return;
    m_layout_dirty = false;
    layout_count++;
    if (auto* html = document_element())
        layout_element(*html, 0, 0, viewport_width, 0, 0);
}

Box Element::get_bounding_client_rect()
{
    document().update_layout();
    return box;
}

i32 HTMLElement::offset_top()
{
    document().update_layout();
    return static_cast<i32>(std::lround(box.y));
}

i32 HTMLElement::offset_left()
{
    document().update_layout();
    return static_cast<i32>(std::lround(box.x));
}

i32 HTMLElement::offset_width()
{
    document().update_layout();
    return static_cast<i32>(std::lround(box.width));
}

i32 HTMLElement::offset_height()
{
    document().update_layout();
    return static_cast<i32>(std::lround(box.height));
}

// --- Paint ---------------------------------------------------------------------------------------
//
// Display list: a sequence of u32 words.
//   1 RECT   x y w h rgba            (x..h as f32 bits)
//   2 TEXT   x y rgba n  chars...    (n UTF-16 code units, packed two per word)
//   3 BORDER x y w h rgba width

static u32 f32_bits(f64 v)
{
    float f = static_cast<float>(v);
    u32 bits;
    std::memcpy(&bits, &f, 4);
    return bits;
}

static void paint_element(Element& e, std::vector<u32>& out, u32 inherited_color)
{
    auto const& c = e.computed;
    if (c.display_none)
        return;
    if (c.background)
        out.insert(out.end(), { 1u, f32_bits(e.box.x), f32_bits(e.box.y), f32_bits(e.box.width), f32_bits(e.box.height), c.background });
    if (c.border > 0 && c.border_color)
        out.insert(out.end(), { 3u, f32_bits(e.box.x), f32_bits(e.box.y), f32_bits(e.box.width), f32_bits(e.box.height), c.border_color, f32_bits(c.border) });
    // The toy has no cascade: color inherits unless set (black counts as unset).
    u32 color = c.color != 0x000000ff ? c.color : inherited_color;
    u32 per_line = chars_per_line(std::fmax(0, e.box.width - 2 * (c.border + c.padding)));
    for (auto* child = e.first_child(); child; child = child->next_sibling()) {
        if (child->is_element()) {
            paint_element(static_cast<Element&>(*child), out, color);
        } else if (child->is_text()) {
            auto const& text = static_cast<Text&>(*child).data();
            for (size_t start = 0, line = 0; start < text.size(); start += per_line, line++) {
                auto n = static_cast<u32>(std::min<size_t>(per_line, text.size() - start));
                out.insert(out.end(), { 2u, f32_bits(child->box.x), f32_bits(child->box.y + static_cast<f64>(line) * line_height), color, n });
                for (u32 i = 0; i < n; i += 2) {
                    u32 lo = text[start + i];
                    u32 hi = (i + 1 < n) ? text[start + i + 1] : 0;
                    out.push_back(lo | hi << 16);
                }
            }
        }
    }
}

void Document::paint(std::vector<u32>& out)
{
    update_layout();
    out.clear();
    if (auto* html = document_element())
        paint_element(*html, out, 0x000000ff);
    m_paint_dirty = false;
}

static void hit(Element& e, f64 x, f64 y, Element*& best)
{
    if (e.computed.display_none)
        return;
    if (x >= e.box.x && y >= e.box.y && x < e.box.x + e.box.width && y < e.box.y + e.box.height)
        best = &e;
    for (auto* child = e.first_child(); child; child = child->next_sibling())
        if (child->is_element())
            hit(static_cast<Element&>(*child), x, y, best);
}

Element* Document::hit_test(f64 x, f64 y)
{
    update_layout();
    Element* best = nullptr;
    if (auto* html = document_element())
        hit(*html, x, y, best);
    return best;
}

}
