#include "pool.hpp"

#include <sys/mman.h>

#include <cstdio>

namespace wisp {

namespace {
constexpr unsigned kMaxPools = 8;
constexpr unsigned kCache = 32;

struct ThreadCache {
  u32 idx[kMaxPools][kCache];
  unsigned n[kMaxPools] = {};
  BufferPool* owner[kMaxPools] = {};
  // No destructor work: a pool may be gone before a thread's cache is destroyed. Worker threads
  // call flush_thread_cache() before they exit.
};
thread_local ThreadCache t_cache;
std::atomic<unsigned> g_next_id{0};

std::size_t round_pow2(std::size_t n) {
  std::size_t p = 1;
  while (p < n) p <<= 1;
  return p;
}
[[noreturn]] void die(const char* what) {
  std::fprintf(stderr, "wisp: buffer pool: %s\n", what);
  std::abort();
}
}  // namespace

BufferPool::BufferPool(std::size_t block_size, std::size_t count, bool use_malloc)
    : size_((block_size + 63) & ~std::size_t(63)), count_(count), mask_(round_pow2(count ? count : 1) - 1), malloc_(use_malloc),
#if defined(WISP_FUZZ) || defined(WISP_TEST_HOOKS) || defined(WISP_POOL_ABORT) || defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
      abort_double_(true) {
#else
      abort_double_(false) {
#endif
  id_ = g_next_id.fetch_add(1);
  if (id_ >= kMaxPools) die("too many pools");
  if (count_ > 0xffffffffu) die("too many blocks");
  cells_.reset(new Cell[mask_ + 1]);
  for (std::size_t i = 0; i <= mask_; i++) cells_[i].seq.store(i, std::memory_order_relaxed);
  if (!malloc_) {
    slab_bytes_ = size_ * count_;
    int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
    flags |= MAP_NORESERVE;  // address space only: pages are touched (and committed) as blocks are used
#endif
    void* m = mmap(nullptr, slab_bytes_ ? slab_bytes_ : 1, PROT_READ | PROT_WRITE, flags, -1, 0);
    if (m == MAP_FAILED) {
      std::fprintf(stderr, "wisp: buffer pool: cannot reserve %zu MiB of address space (lower --max-connections or set --pool-mib)\n", slab_bytes_ >> 20);
      std::abort();
    }
    slab_ = static_cast<u8*>(m);
    std::size_t words = (count_ + 63) / 64;
    owned_.reset(new std::atomic<u64>[words ? words : 1]);
    for (std::size_t i = 0; i < (words ? words : 1); i++) owned_[i].store(0, std::memory_order_relaxed);
    // The ring starts empty: blocks never used are handed out from the bump index `fresh_`, so the
    // pages touched (RSS) follow the peak number of blocks in use, not the slab size (a FIFO ring
    // seeded with every block would rotate through, and fault in, the whole slab).
  }
}

BufferPool::~BufferPool() {
  if (slab_) munmap(slab_, slab_bytes_ ? slab_bytes_ : 1);
}

bool BufferPool::ring_push(u32 index) {
  std::size_t pos = enq_.load(std::memory_order_relaxed);
  for (;;) {
    Cell& c = cells_[pos & mask_];
    std::size_t seq = c.seq.load(std::memory_order_acquire);
    std::intptr_t dif = std::intptr_t(seq) - std::intptr_t(pos);
    if (dif == 0) {
      if (enq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
        c.index = index;
        c.seq.store(pos + 1, std::memory_order_release);
        return true;
      }
    } else if (dif < 0) {
      return false;  // full: impossible while the ring holds >= count cells
    } else {
      pos = enq_.load(std::memory_order_relaxed);
    }
  }
}

bool BufferPool::ring_pop(u32& index) {
  std::size_t pos = deq_.load(std::memory_order_relaxed);
  for (;;) {
    Cell& c = cells_[pos & mask_];
    std::size_t seq = c.seq.load(std::memory_order_acquire);
    std::intptr_t dif = std::intptr_t(seq) - std::intptr_t(pos + 1);
    if (dif == 0) {
      if (deq_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
        index = c.index;
        c.seq.store(pos + mask_ + 1, std::memory_order_release);
        return true;
      }
    } else if (dif < 0) {
      return false;  // empty
    } else {
      pos = deq_.load(std::memory_order_relaxed);
    }
  }
}

bool BufferPool::take_fresh(u32& index) {
  std::size_t f = fresh_.load(std::memory_order_relaxed);
  while (f < count_)
    if (fresh_.compare_exchange_weak(f, f + 1, std::memory_order_relaxed)) { index = u32(f); return true; }
  return false;
}

u32 BufferPool::index_of(const u8* p) const {
  if (p < slab_ || p >= slab_ + slab_bytes_) die("release of a foreign pointer");
  std::size_t off = std::size_t(p - slab_);
  if (off % size_) die("release of a pointer inside a block");
  return u32(off / size_);
}

u8* BufferPool::acquire(bool privileged) {
  if (!privileged && reserve_ && in_use_.load(std::memory_order_relaxed) + reserve_ >= count_) return nullptr;
  if (malloc_) {
    // stage-(a) baseline: malloc per buffer, still bounded by `count`
    std::size_t n = in_use_.fetch_add(1, std::memory_order_relaxed);
    if (n >= count_) { in_use_.fetch_sub(1, std::memory_order_relaxed); return nullptr; }
    void* m = std::malloc(size_);
    if (!m) { in_use_.fetch_sub(1, std::memory_order_relaxed); return nullptr; }
    return static_cast<u8*>(m);
  }
  ThreadCache& tc = t_cache;
  tc.owner[id_] = this;
  u32 index;
  if (tc.n[id_]) {
    index = tc.idx[id_][--tc.n[id_]];
  } else {
    // refill half the cache in one go (released blocks first, then never-used ones)
    if (!ring_pop(index) && !take_fresh(index)) return nullptr;
    for (unsigned k = 0; k < kCache / 2; k++) {
      u32 more;
      if (!ring_pop(more)) break;
      tc.idx[id_][tc.n[id_]++] = more;
    }
  }
  in_use_.fetch_add(1, std::memory_order_relaxed);
  u64 bit = u64(1) << (index & 63);
  if (owned_[index >> 6].fetch_or(bit, std::memory_order_relaxed) & bit) die("block handed out twice");
  return slab_ + std::size_t(index) * size_;
}

void BufferPool::release(u8* p) {
  if (!p) return;
  if (malloc_) { in_use_.fetch_sub(1, std::memory_order_relaxed); std::free(p); return; }
  u32 index = index_of(p);
  u64 bit = u64(1) << (index & 63);
  if (!(owned_[index >> 6].fetch_and(~bit, std::memory_order_relaxed) & bit)) {
    // AUDIT A-12: released twice (or never handed out). Putting it back would give it two owners.
    if (abort_double_) die("double release");
    if (doubles_.fetch_add(1, std::memory_order_relaxed) == 0) std::fprintf(stderr, "wisp: buffer pool: double release ignored (bug)\n");
    return;
  }
  in_use_.fetch_sub(1, std::memory_order_relaxed);
  ThreadCache& tc = t_cache;
  tc.owner[id_] = this;
  if (tc.n[id_] == kCache) {
    // spill half back to the shared ring
    for (unsigned k = 0; k < kCache / 2; k++)
      if (!ring_push(tc.idx[id_][--tc.n[id_]])) die("ring overflow (double release?)");
  }
  tc.idx[id_][tc.n[id_]++] = index;
}

void BufferPool::flush_thread_cache() {
  ThreadCache& tc = t_cache;
  while (tc.n[id_])
    if (!ring_push(tc.idx[id_][--tc.n[id_]])) die("ring overflow (double release?)");
}

}  // namespace wisp
