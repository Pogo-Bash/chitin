// Whole-session fuzzing of the real connection code; see src/fuzz_session.inc.
#include "../src/common.hpp"

namespace wisp { int fuzz_session_one(const u8* data, std::size_t size); }

extern "C" int LLVMFuzzerTestOneInput(const wisp::u8* data, std::size_t size) { return wisp::fuzz_session_one(data, size); }
