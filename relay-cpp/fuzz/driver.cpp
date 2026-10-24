// A small coverage-guided fuzzing driver for libFuzzer-style targets (LLVMFuzzerTestOneInput),
// for toolchains that ship the sanitizers but not libFuzzer (Apple clang). Targets are built with
// -fsanitize-coverage=trace-pc-guard plus ASan/UBSan; this file is built WITHOUT coverage.
// With a clang that has libFuzzer, build the same targets with FUZZ_ENGINE=libfuzzer instead.
//
//   fuzz_x [-max_total_time=S] [-runs=N] [-seed=N] [-max_len=N] CORPUS_DIR [SEED_DIR...]
//
// Inputs that reach new edges (or new hit-count buckets of an edge) are kept in memory and written
// to CORPUS_DIR. On a sanitizer report the current input is written to crash-<hash> (cwd).
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <random>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);
extern "C" __attribute__((weak)) int LLVMFuzzerInitialize(int*, char***) { return 0; }
extern "C" void __sanitizer_set_death_callback(void (*)(void));

namespace {
uint32_t g_edges = 0;
uint8_t* g_hits = nullptr;     // per-edge hit counter for the current run (saturating)
uint8_t* g_seen = nullptr;     // per-edge bitmask of hit-count buckets ever seen
const std::vector<uint8_t>* g_current = nullptr;

inline uint8_t bucket(uint8_t n) {
  if (n == 0) return 0;
  if (n == 1) return 1;
  if (n == 2) return 2;
  if (n == 3) return 4;
  if (n < 8) return 8;
  if (n < 16) return 16;
  if (n < 32) return 32;
  if (n < 128) return 64;
  return 128;
}

uint64_t fnv(const std::vector<uint8_t>& v) {
  uint64_t h = 1469598103934665603ull;
  for (uint8_t c : v) { h ^= c; h *= 1099511628211ull; }
  return h;
}

void write_file(const std::string& path, const std::vector<uint8_t>& v) {
  std::ofstream f(path, std::ios::binary);
  f.write(reinterpret_cast<const char*>(v.data()), std::streamsize(v.size()));
}

void on_death() {
  if (!g_current) return;
  char name[64];
  std::snprintf(name, sizeof name, "crash-%016llx", (unsigned long long)fnv(*g_current));
  write_file(name, *g_current);
  std::fprintf(stderr, "driver: input written to %s (%zu bytes)\n", name, g_current->size());
}

bool new_coverage() {
  bool novel = false;
  for (uint32_t i = 1; i <= g_edges; i++) {
    uint8_t h = g_hits[i];
    if (!h) continue;
    uint8_t b = bucket(h);
    if (!(g_seen[i] & b)) { g_seen[i] |= b; novel = true; }
    g_hits[i] = 0;
  }
  return novel;
}

std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

void load_dir(const std::string& dir, std::vector<std::vector<uint8_t>>& out) {
  DIR* d = opendir(dir.c_str());
  if (!d) return;
  while (dirent* e = readdir(d)) {
    if (e->d_name[0] == '.') continue;
    std::string p = dir + "/" + e->d_name;
    struct stat st;
    if (stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode)) out.push_back(read_file(p));
  }
  closedir(d);
}

struct Mutator {
  std::mt19937_64 rng;
  size_t max_len;
  const std::vector<std::vector<uint8_t>>* corpus;
  uint64_t r(uint64_t n) { return n ? rng() % n : 0; }
  uint8_t interesting8() {
    static const uint8_t v[] = {0, 1, 2, 3, 4, 5, 0x7e, 0x7f, 0x80, 0x81, 0xfe, 0xff, 0x40, 0x41, 0x48, 0xc0, 0x0a, 0x0d, 126, 127, '.', ':', '%', '['};
    return v[r(sizeof v)];
  }
  void mutate(std::vector<uint8_t>& v) {
    int rounds = 1 + int(r(6));
    for (int k = 0; k < rounds; k++) {
      switch (r(11)) {
        case 0: if (!v.empty()) v[r(v.size())] ^= uint8_t(1u << r(8)); break;
        case 1: if (!v.empty()) v[r(v.size())] = uint8_t(rng()); break;
        case 2: if (!v.empty()) v[r(v.size())] = interesting8(); break;
        case 3: if (v.size() < max_len) v.insert(v.begin() + long(r(v.size() + 1)), uint8_t(rng())); break;
        case 4: if (!v.empty()) { size_t a = r(v.size()), n = 1 + r(std::min<size_t>(16, v.size() - a)); v.erase(v.begin() + long(a), v.begin() + long(a + n)); } break;
        case 5: if (!v.empty() && v.size() < max_len) {  // duplicate a range
          size_t a = r(v.size()), n = 1 + r(std::min<size_t>(64, v.size() - a));
          std::vector<uint8_t> piece(v.begin() + long(a), v.begin() + long(a + n));
          v.insert(v.begin() + long(r(v.size() + 1)), piece.begin(), piece.end());
        } break;
        case 6: if (!corpus->empty()) {  // splice with another input
          const auto& o = (*corpus)[r(corpus->size())];
          if (!o.empty()) {
            size_t a = r(o.size()), n = 1 + r(std::min<size_t>(128, o.size() - a));
            v.insert(v.begin() + long(r(v.size() + 1)), o.begin() + long(a), o.begin() + long(a + n));
          }
        } break;
        case 7: if (v.size() >= 2) {  // 16-bit value (both orders)
          size_t a = r(v.size() - 1);
          uint16_t x = uint16_t(r(4) == 0 ? 0xffff : r(4) == 0 ? 126 : r(70000));
          if (r(2)) { v[a] = uint8_t(x); v[a + 1] = uint8_t(x >> 8); } else { v[a] = uint8_t(x >> 8); v[a + 1] = uint8_t(x); }
        } break;
        case 8: if (v.size() >= 4) {  // 32-bit value
          size_t a = r(v.size() - 3);
          uint32_t x = uint32_t(r(3) == 0 ? 0xffffffffu : r(1u << 20));
          for (int i = 0; i < 4; i++) v[a + size_t(i)] = uint8_t(x >> (8 * i));
        } break;
        case 9: if (!v.empty()) { size_t a = r(v.size()); v.resize(a); } break;  // truncate
        case 10: if (v.size() < max_len) { size_t n = 1 + r(32); for (size_t i = 0; i < n; i++) v.push_back(uint8_t(rng())); } break;
      }
    }
    if (v.size() > max_len) v.resize(max_len);
  }
};
}  // namespace

extern "C" void __sanitizer_cov_trace_pc_guard_init(uint32_t* start, uint32_t* stop) {
  if (start == stop || *start) return;
  uint32_t n = uint32_t(stop - start);
  for (uint32_t* x = start; x < stop; x++) *x = ++g_edges;
  (void)n;
  g_hits = static_cast<uint8_t*>(std::realloc(g_hits, g_edges + 1));
  g_seen = static_cast<uint8_t*>(std::realloc(g_seen, g_edges + 1));
  std::memset(g_hits, 0, g_edges + 1);
  std::memset(g_seen, 0, g_edges + 1);
}

extern "C" void __sanitizer_cov_trace_pc_guard(uint32_t* guard) {
  uint32_t g = *guard;
  if (g && g_hits[g] != 255) g_hits[g]++;
}

int main(int argc, char** argv) {
  LLVMFuzzerInitialize(&argc, &argv);
  double max_time = 60;
  uint64_t runs = UINT64_MAX, seed = uint64_t(std::random_device{}());
  size_t max_len = 4096;
  std::vector<std::string> dirs;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a.rfind("-max_total_time=", 0) == 0) max_time = std::atof(a.c_str() + 16);
    else if (a.rfind("-runs=", 0) == 0) runs = std::strtoull(a.c_str() + 6, nullptr, 10);
    else if (a.rfind("-seed=", 0) == 0) seed = std::strtoull(a.c_str() + 6, nullptr, 10);
    else if (a.rfind("-max_len=", 0) == 0) max_len = std::strtoull(a.c_str() + 9, nullptr, 10);
    else if (a[0] != '-') dirs.push_back(a);
  }
  if (dirs.empty()) { std::fprintf(stderr, "usage: %s [-max_total_time=S] [-runs=N] [-seed=N] CORPUS [SEEDS...]\n", argv[0]); return 2; }
  __sanitizer_set_death_callback(on_death);
  std::signal(SIGABRT, [](int) {  // property violations in the targets call abort()
    std::fprintf(stderr, "driver: abort() in the target (a property failed)\n");
    on_death();
    std::_Exit(134);
  });
  mkdir(dirs[0].c_str(), 0755);
  std::vector<std::vector<uint8_t>> corpus, initial;
  for (auto& d : dirs) load_dir(d, initial);
  if (initial.empty()) initial.push_back({});
  // run the initial inputs; keep those that add coverage
  for (auto& in : initial) {
    g_current = &in;
    LLVMFuzzerTestOneInput(in.data(), in.size());
    if (new_coverage() || corpus.empty()) corpus.push_back(in);
  }
  Mutator m{std::mt19937_64(seed), max_len, &corpus};
  auto t0 = std::chrono::steady_clock::now();
  uint64_t n = 0, last_report = 0;
  std::vector<uint8_t> cur;
  for (; n < runs; n++) {
    if ((n & 255) == 0) {
      double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      if (el > max_time) break;
      if (el - double(last_report) >= 10) {
        last_report = uint64_t(el);
        uint32_t cov = 0;
        for (uint32_t i = 1; i <= g_edges; i++) cov += g_seen[i] != 0;
        std::fprintf(stderr, "#%llu  %.0fs  edges %u/%u  corpus %zu  exec/s %.0f\n", (unsigned long long)n, el, cov, g_edges, corpus.size(), double(n) / el);
      }
    }
    cur = corpus[m.r(corpus.size())];
    m.mutate(cur);
    g_current = &cur;
    LLVMFuzzerTestOneInput(cur.data(), cur.size());
    if (new_coverage()) {
      corpus.push_back(cur);
      char name[64];
      std::snprintf(name, sizeof name, "/%016llx", (unsigned long long)fnv(cur));
      write_file(dirs[0] + name, cur);
    }
  }
  double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  uint32_t cov = 0;
  for (uint32_t i = 1; i <= g_edges; i++) cov += g_seen[i] != 0;
  std::fprintf(stderr, "done: %llu runs in %.0f s (%.0f exec/s), edges %u/%u, corpus %zu, no crash\n", (unsigned long long)n, el,
               double(n) / (el > 0 ? el : 1), cov, g_edges, corpus.size());
  return 0;
}
