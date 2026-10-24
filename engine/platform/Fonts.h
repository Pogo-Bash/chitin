// SPDX-License-Identifier: GPL-2.0-only
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// The engine's fonts (docs/fonts.md). The host adds the base faces (Noto Sans, Serif, Sans Mono) before start, and
// hands over a manifest of fallback subsets: Unicode-range cuts of Noto fonts for other scripts, symbols, math and
// emoji. When text needs a code point no page font and no loaded face has, LibWeb asks the system font provider
// (FontCascadeList's system fallback); this provider answers from a loaded subset, or asks the host for the one
// subset that covers the code point and answers nothing until it arrives. Its arrival re-resolves every
// document's font cascades (Ladybird patch 0036), so the text that missed it lays out again, as after a web font load.

#pragma once

#include <AK/ByteString.h>
#include <AK/Vector.h>
#include <LibGfx/Font/FontDatabase.h>
#include <LibGfx/Font/PathFontProvider.h>

namespace Ganglion {

class FontProvider final : public Gfx::SystemFontProvider {
public:
    AK_ALLOC_WITH_KMALLOC;
    FontProvider() = default;

    void add(NonnullRefPtr<Gfx::Typeface>);
    // The manifest (tools/fallback-fonts.py writes it; docs/fonts.md has the layout) and the host's languages
    // (navigator.languages, comma-separated), which order the CJK faces for Han when the document names no lang.
    bool set_fallback_manifest(ReadonlyBytes, StringView languages);
    // A subset the host fetched for ganglion_host_load_fallback_font. Answers whether it was installed.
    bool add_fallback_subset(u32 id, ReadonlyBytes);
    // How many subsets were asked for (each at most once), and how many arrived.
    u32 requested_count() const { return m_requested; }
    u32 loaded_count() const { return m_loaded; }

    virtual RefPtr<Gfx::Font> get_font(FlyString const& family, float point_size, unsigned weight, unsigned width, unsigned slope, Optional<Gfx::FontVariationSettings> const& variation, Optional<Gfx::ShapeFeatures> const& features) override;
    virtual void for_each_typeface_with_family_name(FlyString const& family_name, Function<void(Gfx::Typeface const&)> callback) override;
    virtual RefPtr<Gfx::Font> get_font_for_code_point(u32 code_point, float point_size, u16 weight, u16 width, u8 slope, bool prefer_color_emoji) override;
    virtual Optional<FlyString> resolve_generic_family(StringView family_name, u16 weight, u8 slope) override;

private:
    struct Run {
        u32 start;
        u32 end; // exclusive
    };
    struct Subset {
        ByteString file;
        u32 size { 0 };
        Vector<Run> runs;
        RefPtr<Gfx::Typeface> typeface;
        bool requested { false };
        bool covers(u32 code_point) const;
    };
    struct Family {
        u8 flags { 0 };
        ByteString name;
        ByteString lang; // "zh-Hans", "zh-Hant", "ja", "ko" or empty
        Vector<Subset> subsets;
        u32 first_id { 0 };
    };
    static constexpr u8 flag_emoji = 1;
    static constexpr u8 flag_cjk = 2;

    static Optional<FlyString> metric_alias(FlyString const& family);
    Vector<size_t> family_order(u32 code_point, bool prefer_color_emoji) const;
    ByteString cjk_preference() const;

    Gfx::PathFontProvider m_provider;
    Vector<NonnullRefPtr<Gfx::Typeface>> m_base;
    Vector<Family> m_families;
    Vector<ByteString> m_languages;
    u32 m_requested { 0 };
    u32 m_loaded { 0 };
};

}
