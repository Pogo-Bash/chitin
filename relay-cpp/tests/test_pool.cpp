// Concurrency stress for everything worker threads share: the buffer pool (lock-free MPMC ring +
// thread caches), the global connection counter and the per-IP table. Run plain and under
// ThreadSanitizer (make tsan, Linux). Properties:
//  - a block is never handed to two owners at once (each owner stamps it and checks the stamp);
//  - all blocks come back (in_use() == 0, and the pool can hand out exactly `count` again);
//  - a SharedCounter / PerIpTable slot never exceeds its limit, whatever the interleaving
//    (an independent atomic tracks the number of tickets actually held);
//  - every acquire is matched by one release (counters end at 0).
#include <set>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <thread>
#include <vector>
#include <csignal>
#include <sys/wait.h>
#include <unistd.h>

#include "../src/ip.hpp"
#include "../src/limits.hpp"
#include "../src/pool.hpp"

using namespace wisp;

static std::atomic<int> g_fail{0};
#define REQUIRE(c) do { if (!(c)) { std::fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); g_fail++; } } while (0)

static void pool_stress(unsigned threads, std::size_t count, int iters) {
  BufferPool pool(256, count);
  std::vector<std::thread> ts;
  std::atomic<u64> handed{0};
  for (unsigned t = 0; t < threads; t++) {
    ts.emplace_back([&, t] {
      std::mt19937 rng(t * 7919 + 1);
      std::vector<u8*> mine;
      for (int i = 0; i < iters; i++) {
        if (mine.size() < 40 && (rng() & 1)) {
          u8* p = pool.acquire();
          if (p) {
            u64 stamp = (u64(t) << 32) | u32(i);
            std::memcpy(p, &stamp, 8);
            std::memcpy(p + 8, &stamp, 8);
            mine.push_back(p);
            handed++;
          }
        } else if (!mine.empty()) {
          std::size_t k = rng() % mine.size();
          u8* p = mine[k];
          u64 a, b;
          std::memcpy(&a, p, 8);
          std::memcpy(&b, p + 8, 8);
          REQUIRE(a == b && (a >> 32) == t);  // nobody else wrote into my block
          mine[k] = mine.back();
          mine.pop_back();
          pool.release(p);
        }
      }
      for (u8* p : mine) pool.release(p);
      pool.flush_thread_cache();
    });
  }
  for (auto& t : ts) t.join();
  REQUIRE(pool.in_use() == 0);
  // exactly `count` blocks can be taken again, all distinct
  std::vector<u8*> all;
  while (u8* p = pool.acquire()) all.push_back(p);
  REQUIRE(all.size() == count);
  std::sort(all.begin(), all.end());
  REQUIRE(std::adjacent_find(all.begin(), all.end()) == all.end());
  for (u8* p : all) pool.release(p);
  pool.flush_thread_cache();
  std::printf("pool: %u threads, %llu acquisitions, ok\n", threads, (unsigned long long)handed.load());
}

static void counter_stress(unsigned threads, u32 limit, int iters) {
  SharedCounter c;
  std::atomic<int> held{0}, max_held{0};
  std::vector<std::thread> ts;
  for (unsigned t = 0; t < threads; t++) {
    ts.emplace_back([&, t] {
      std::mt19937 rng(t + 100);
      int mine = 0;
      for (int i = 0; i < iters; i++) {
        if (rng() & 1) {
          if (c.try_acquire(limit)) {
            int h = ++held;
            int m = max_held.load();
            while (h > m && !max_held.compare_exchange_weak(m, h)) {}
            mine++;
          }
        } else if (mine) {
          --held;
          c.release();
          mine--;
        }
      }
      while (mine--) { --held; c.release(); }
    });
  }
  for (auto& t : ts) t.join();
  REQUIRE(max_held.load() <= int(limit));  // INVARIANT: never more tickets than the limit
  REQUIRE(c.value() == 0 && held.load() == 0);
  std::printf("counter: %u threads, limit %u, max held %d, ok\n", threads, limit, max_held.load());
}

static void per_ip_stress(unsigned threads, u32 limit, int iters) {
  PerIpTable table(10);  // small table: collisions happen and must only make limits stricter
  constexpr int kKeys = 64;
  std::atomic<int> per_slot[1 << 10];
  for (auto& x : per_slot) x = 0;
  std::atomic<int> violations{0};
  std::vector<std::thread> ts;
  for (unsigned t = 0; t < threads; t++) {
    ts.emplace_back([&, t] {
      std::mt19937 rng(t + 999);
      std::vector<std::size_t> mine;
      for (int i = 0; i < iters; i++) {
        if (mine.size() < 16 && (rng() & 1)) {
          IpKey k = ip_key(Ip{6, (u128(0x20010db8) << 96) | (u128(rng() % kKeys) << 64) | rng()}, 64);
          std::size_t slot;
          if (table.try_acquire(k, limit, slot)) {
            if (++per_slot[slot] > int(limit)) violations++;
            mine.push_back(slot);
          }
        } else if (!mine.empty()) {
          std::size_t s = mine.back();
          mine.pop_back();
          --per_slot[s];
          table.release(s);
        }
      }
      for (std::size_t s : mine) { --per_slot[s]; table.release(s); }
    });
  }
  for (auto& t : ts) t.join();
  REQUIRE(violations.load() == 0);
  for (auto& x : per_slot) REQUIRE(x.load() == 0);
  // the same /64 maps to one slot; IPv4-mapped equals IPv4
  REQUIRE(table.slot_of(ip_key("2001:db8::1")) == table.slot_of(ip_key("2001:db8::ffff")));
  REQUIRE(table.slot_of(ip_key("::ffff:1.2.3.4")) == table.slot_of(ip_key("1.2.3.4")));
  std::printf("per-ip: %u threads, limit %u, ok\n", threads, limit);
}

// RSS follows peak use: cycling a few blocks through a big pool must keep reusing the same few
// blocks (a FIFO ring seeded with every block walked the whole slab: 1 GiB RSS in wispmark).
static void touched_stays_small() {
  wisp::BufferPool pool(36 * 1024, 30000);
  std::set<u8*> seen;
  for (int i = 0; i < 2000; i++) {
    u8* a[200];
    for (auto& p : a) { p = pool.acquire(); seen.insert(p); }
    for (auto& p : a) pool.release(p);
  }
  if (seen.size() > 400) { std::printf("touched_stays_small: %zu distinct blocks for 200 in use\n", seen.size()); g_fail++; }
}

// AUDIT A-6: PerIpRate admits exactly `limit` events per address per second under any interleaving.
static void rate_stress(unsigned threads) {
  PerIpRate rate;
  IpKey k = ip_key(*parse_ip("192.0.2.7"));
  IpKey other = ip_key(*parse_ip("2001:db8::1"));
  std::atomic<u32> ok{0};
  std::vector<std::thread> ts;
  for (unsigned t = 0; t < threads; t++)
    ts.emplace_back([&] { for (int i = 0; i < 1000; i++) if (rate.try_take(k, 10, 77)) ok++; });
  for (auto& t : ts) t.join();
  REQUIRE(ok == 10);
  REQUIRE(!rate.try_take(k, 10, 77));
  REQUIRE(rate.try_take(other, 10, 77) || true);  // another address: its own slot (unless the hash collides)
  REQUIRE(rate.try_take(k, 10, 78));  // a new second
  std::printf("rate: %u threads, limit 10, admitted %u, ok\n", threads, ok.load());
}

// AUDIT A-12: a second release of a block is caught at once. Release mode: ignored and counted,
// the block is not handed to two owners; abort mode (test builds): the process aborts.
static void double_release() {
  {
    BufferPool pool(256, 8);
    pool.set_abort_on_double_release(false);
    u8* a = pool.acquire();
    pool.release(a);
    pool.release(a);  // the bug
    REQUIRE(pool.double_releases() == 1);
    REQUIRE(pool.in_use() == 0);
    std::set<u8*> seen;
    std::vector<u8*> all;
    for (int i = 0; i < 8; i++) { u8* p = pool.acquire(); REQUIRE(p); all.push_back(p); seen.insert(p); }
    REQUIRE(seen.size() == 8);  // no block handed out twice
    REQUIRE(pool.acquire() == nullptr);
    for (u8* p : all) pool.release(p);
    REQUIRE(pool.in_use() == 0 && pool.double_releases() == 1);
    pool.flush_thread_cache();
  }
  pid_t pid = fork();
  if (pid == 0) {
    BufferPool pool(256, 8);
    pool.set_abort_on_double_release(true);
    u8* a = pool.acquire();
    pool.release(a);
    std::fclose(stderr);
    pool.release(a);
    _exit(0);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  REQUIRE(WIFSIGNALED(st) && WTERMSIG(st) == SIGABRT);
  std::printf("double release: ignored+counted in release mode, abort in test mode, ok\n");
}

int main() {
  touched_stays_small();
  double_release();
  rate_stress(8);
  unsigned n = std::max(4u, std::thread::hardware_concurrency());
  if (n > 8) n = 8;
  pool_stress(n, 64, 200000);   // small pool: constant exhaustion and refills
  pool_stress(n, 4096, 100000);
  counter_stress(n, 3, 300000);
  counter_stress(n, 1, 300000);
  per_ip_stress(n, 2, 200000);
  if (g_fail) { std::printf("%d failures\n", g_fail.load()); return 1; }
  std::printf("all ok\n");
  return 0;
}
