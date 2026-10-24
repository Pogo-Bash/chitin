// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
// Checks the pinned toolchain: C++23 library features and Wasm exception handling with libc++.
// Run: make toolchain-check
#include <expected>
#include <print>
#include <ranges>
#include <stdexcept>
#include <string>
#include <vector>

static std::expected<int, std::string> twice(int x)
{
    if (x < 0)
        return std::unexpected("negative");
    return x * 2;
}

int main()
{
    try {
        throw std::runtime_error("thrown across frames");
    } catch (std::exception const& e) {
        std::println("wasm exceptions: caught '{}'", e.what());
    }
    auto squares = std::views::iota(1, 5) | std::views::transform([](int i) { return i * i; });
    std::vector<int> out(squares.begin(), squares.end());
    std::println("std::expected: {}  ranges: {} items  __cplusplus: {}  clang {}.{}  libc++ {}", twice(21).value(), out.size(), __cplusplus, __clang_major__, __clang_minor__, _LIBCPP_VERSION);
    if consteval {
    } else {
        std::println("if consteval: ok");
    }
}
