// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The engine's font provider: the base faces and the lazily loaded fallback subsets (Fonts.h, docs/fonts.md).

#include "Fonts.h"

#include <AK/QuickSort.h>
#include <LibGfx/Font/Font.h>
#include <LibGfx/Font/Typeface.h>
#include <LibGfx/Font/WOFF2/Loader.h>

extern "C" {
// Fetch fallback subset `id` (its file name in the manifest) and hand it to ganglion_add_fallback_font. Asked once per subset.
void ganglion_host_load_fallback_font(uint32_t id, char const* file, size_t file_length);
void ganglion_host_log(char const* text, size_t length);
}

namespace Ganglion {

// The lang of the top-level document's root element ("" without one).
ByteString document_language();

namespace {

void host_log(StringView text)
{
    ganglion_host_log(text.characters_without_null_termination(), text.length());
}

class Reader {
public:
    explicit Reader(ReadonlyBytes bytes)
        : m_bytes(bytes)
    {
    }
    bool ok() const { return m_ok; }
    u32 varint()
    {
        u32 value = 0;
        for (u32 shift = 0; shift < 35; shift += 7) {
            if (m_at >= m_bytes.size()) {
                m_ok = false;
                return 0;
            }
            u8 byte = m_bytes[m_at++];
            value |= static_cast<u32>(byte & 0x7f) << shift;
            if (!(byte & 0x80))
                return value;
        }
        m_ok = false;
        return 0;
    }
    u8 byte()
    {
        if (m_at >= m_bytes.size()) {
            m_ok = false;
            return 0;
        }
        return m_bytes[m_at++];
    }
    u32 u32le()
    {
        u32 value = 0;
        for (int i = 0; i < 4; ++i)
            value |= static_cast<u32>(byte()) << (8 * i);
        return value;
    }
    ByteString string()
    {
        auto length = varint();
        if (!m_ok || m_at + length > m_bytes.size()) {
            m_ok = false;
            return {};
        }
        auto string = ByteString(reinterpret_cast<char const*>(m_bytes.data() + m_at), length);
        m_at += length;
        return string;
    }

private:
    ReadonlyBytes m_bytes;
    size_t m_at { 0 };
    bool m_ok { true };
};

// A BCP 47 tag to the CJK face tag that serves it, as Chrome's Han unification by locale does.
ByteString cjk_tag_for(StringView language)
{
    auto lower = language.to_ascii_lowercase_string();
    StringView tag = lower;
    if (tag.starts_with("ja"sv))
        return "ja";
    if (tag.starts_with("ko"sv))
        return "ko";
    if (tag.starts_with("zh"sv)) {
        if (tag.contains("hant"sv) || tag.contains("-tw"sv) || tag.contains("-hk"sv) || tag.contains("-mo"sv))
            return "zh-Hant";
        return "zh-Hans";
    }
    return {};
}

}

bool FontProvider::Subset::covers(u32 code_point) const
{
    size_t low = 0, high = runs.size();
    while (low < high) {
        auto middle = (low + high) / 2;
        if (code_point < runs[middle].start)
            high = middle;
        else if (code_point >= runs[middle].end)
            low = middle + 1;
        else
            return true;
    }
    return false;
}

void FontProvider::add(NonnullRefPtr<Gfx::Typeface> typeface)
{
    // Cousine is reached only by name (the Courier aliases below), not as a system fallback, so the fallback order of
    // docs/fonts.md is unchanged by it.
    if (!typeface->family().equals_ignoring_ascii_case("Cousine"sv))
        m_base.append(typeface);
    m_provider.add_typeface(move(typeface));
}

// Metric-compatible aliases, as fontconfig's 30-metric-aliases.conf gives Chrome on Linux: a page that names Courier New
// (or Courier, which fontconfig maps to Courier New) gets Cousine, whose advances and vertical metrics match Courier New's,
// so its lines are as tall and as wide as in Chrome. Matching is ASCII case-insensitive, as Chrome's; an identifier such as
// `courier-new` is a different name and matches nothing, in Chrome as here. A face installed under the real name wins.
Optional<FlyString> FontProvider::metric_alias(FlyString const& family)
{
    if (family.equals_ignoring_ascii_case("Courier New"sv) || family.equals_ignoring_ascii_case("Courier"sv))
        return "Cousine"_fly_string;
    return {};
}

RefPtr<Gfx::Font> FontProvider::get_font(FlyString const& family, float point_size, unsigned weight, unsigned width, unsigned slope, Optional<Gfx::FontVariationSettings> const& variation, Optional<Gfx::ShapeFeatures> const& features)
{
    if (auto font = m_provider.get_font(family, point_size, weight, width, slope, variation, features))
        return font;
    if (auto alias = metric_alias(family); alias.has_value())
        return m_provider.get_font(*alias, point_size, weight, width, slope, variation, features);
    return nullptr;
}

void FontProvider::for_each_typeface_with_family_name(FlyString const& family_name, Function<void(Gfx::Typeface const&)> callback)
{
    bool found = false;
    m_provider.for_each_typeface_with_family_name(family_name, [&](Gfx::Typeface const& typeface) {
        found = true;
        callback(typeface);
    });
    if (found)
        return;
    if (auto alias = metric_alias(family_name); alias.has_value())
        m_provider.for_each_typeface_with_family_name(*alias, move(callback));
}

// Chrome's defaults on Linux with the Noto set: serif, sans-serif and monospace are the three base faces; cursive,
// fantasy, system-ui and the ui-* families come to sans-serif (FontPlugin::generic_font_name asks for these three).
Optional<FlyString> FontProvider::resolve_generic_family(StringView family_name, u16, u8)
{
    if (family_name == "serif"sv)
        return "Noto Serif"_fly_string;
    if (family_name == "sans-serif"sv)
        return "Noto Sans"_fly_string;
    if (family_name == "monospace"sv)
        return "Noto Sans Mono"_fly_string;
    return {};
}

bool FontProvider::set_fallback_manifest(ReadonlyBytes bytes, StringView languages)
{
    m_families.clear();
    m_languages.clear();
    for (auto language : languages.split_view(',')) {
        auto trimmed = language.trim_whitespace();
        if (!trimmed.is_empty())
            m_languages.append(trimmed);
    }
    if (bytes.size() < 12 || memcmp(bytes.data(), "CHFB", 4) != 0) {
        host_log("ganglion: the fallback font manifest is not one"sv);
        return false;
    }
    Reader reader(bytes.slice(4));
    auto version = reader.u32le();
    auto family_count = reader.u32le();
    if (version != 1) {
        host_log(ByteString::formatted("ganglion: fallback font manifest version {} (this engine reads 1)", version));
        return false;
    }
    u32 next_id = 0;
    for (u32 f = 0; f < family_count && reader.ok(); ++f) {
        Family family;
        family.flags = reader.byte();
        family.name = reader.string();
        family.lang = reader.string();
        family.first_id = next_id;
        auto subset_count = reader.varint();
        for (u32 s = 0; s < subset_count && reader.ok(); ++s) {
            Subset subset;
            subset.file = reader.string();
            subset.size = reader.varint();
            auto run_count = reader.varint();
            u32 previous = 0;
            for (u32 r = 0; r < run_count && reader.ok(); ++r) {
                auto start = previous + reader.varint();
                auto end = start + reader.varint();
                subset.runs.append({ start, end });
                previous = end;
            }
            family.subsets.append(move(subset));
            ++next_id;
        }
        m_families.append(move(family));
    }
    if (!reader.ok()) {
        host_log("ganglion: the fallback font manifest is truncated"sv);
        m_families.clear();
        return false;
    }
    host_log(ByteString::formatted("ganglion: fallback fonts: {} families, {} subsets", m_families.size(), next_id));
    return true;
}

bool FontProvider::add_fallback_subset(u32 id, ReadonlyBytes bytes)
{
    for (auto& family : m_families) {
        if (id < family.first_id || id >= family.first_id + family.subsets.size())
            continue;
        auto& subset = family.subsets[id - family.first_id];
        if (subset.typeface)
            return false;
        auto typeface = bytes.size() >= 4 && memcmp(bytes.data(), "wOF2", 4) == 0
            ? WOFF2::try_load_from_bytes(bytes)
            : Gfx::Typeface::try_load_from_temporary_memory(bytes);
        if (typeface.is_error()) {
            host_log(ByteString::formatted("ganglion: fallback subset {} ({}) did not load: {}", id, subset.file, typeface.error()));
            return false;
        }
        subset.typeface = typeface.release_value();
        ++m_loaded;
        return true;
    }
    return false;
}

ByteString FontProvider::cjk_preference() const
{
    // The document's own language first (its root's lang), then the host's languages, then Simplified Chinese.
    if (auto tag = cjk_tag_for(document_language()); !tag.is_empty())
        return tag;
    for (auto const& language : m_languages) {
        if (auto tag = cjk_tag_for(language); !tag.is_empty())
            return tag;
    }
    return "zh-Hans";
}

Vector<size_t> FontProvider::family_order(u32 code_point, bool prefer_color_emoji) const
{
    Vector<size_t> order;
    if (prefer_color_emoji) {
        for (size_t i = 0; i < m_families.size(); ++i) {
            if (m_families[i].flags & flag_emoji)
                order.append(i);
        }
    }
    // Kana are Japanese and Hangul Korean whatever the lang says (every CJK face has some of each); Han and the
    // shared punctuation follow the language.
    bool kana = (code_point >= 0x3040 && code_point <= 0x30FF) || (code_point >= 0x31F0 && code_point <= 0x31FF) || (code_point >= 0xFF66 && code_point <= 0xFF9F);
    bool hangul = (code_point >= 0x1100 && code_point <= 0x11FF) || (code_point >= 0x3130 && code_point <= 0x318F) || (code_point >= 0xA960 && code_point <= 0xA97F) || (code_point >= 0xAC00 && code_point <= 0xD7FF);
    auto preferred_cjk = kana ? ByteString("ja") : hangul ? ByteString("ko") : cjk_preference();
    bool cjk_placed = false;
    for (size_t i = 0; i < m_families.size(); ++i) {
        auto const& family = m_families[i];
        if (prefer_color_emoji && (family.flags & flag_emoji))
            continue;
        if (family.flags & flag_cjk) {
            // The CJK faces in one block, the preferred one first: kana go to the Japanese face and Hangul to the
            // Korean one by coverage either way, and shared Han ideographs to the language's face.
            if (cjk_placed)
                continue;
            cjk_placed = true;
            for (size_t j = 0; j < m_families.size(); ++j) {
                if ((m_families[j].flags & flag_cjk) && m_families[j].lang == preferred_cjk)
                    order.append(j);
            }
            for (size_t j = 0; j < m_families.size(); ++j) {
                if ((m_families[j].flags & flag_cjk) && m_families[j].lang != preferred_cjk)
                    order.append(j);
            }
            continue;
        }
        order.append(i);
    }
    return order;
}

RefPtr<Gfx::Font> FontProvider::get_font_for_code_point(u32 code_point, float point_size, u16, u16, u8, bool prefer_color_emoji)
{
    // The base faces first (a page font without U+2026 gets Noto Sans's, as Chrome finds one in the system's
    // fonts), unless the text asks for colour emoji.
    auto from_base = [&]() -> RefPtr<Gfx::Font> {
        for (auto const& typeface : m_base) {
            if (typeface->glyph_id_for_code_point(code_point) != 0)
                return typeface->font(point_size);
        }
        return nullptr;
    };
    if (!prefer_color_emoji) {
        if (auto font = from_base())
            return font;
    }
    for (auto index : family_order(code_point, prefer_color_emoji)) {
        auto& family = m_families[index];
        for (size_t s = 0; s < family.subsets.size(); ++s) {
            auto& subset = family.subsets[s];
            if (!subset.covers(code_point))
                continue;
            if (subset.typeface) {
                if (subset.typeface->glyph_id_for_code_point(code_point) != 0)
                    return subset.typeface->font(point_size);
                break;
            }
            // The one subset this code point needs: asked for once; until it arrives the text has no glyph for it.
            if (!subset.requested) {
                subset.requested = true;
                ++m_requested;
                ganglion_host_load_fallback_font(family.first_id + s, subset.file.characters(), subset.file.length());
            }
            return nullptr;
        }
    }
    if (prefer_color_emoji)
        return from_base();
    return nullptr;
}

}
