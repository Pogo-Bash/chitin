// Fixed-size buffer pools. Each pool is one slab of `count` blocks reserved at start-up; the free
// list is a bounded lock-free MPMC ring of block indices (Vyukov's sequence-numbered queue), with
// a small per-thread cache in front so the common case touches no shared cache line.
//
// Invariants (checked in debug builds and by tests/test_pool.cpp under TSan):
//  - a block index is in at most one place: the shared ring, one thread cache, or one owner;
//  - the pool never allocates after construction; when it is empty acquire() returns nullptr and
//    the caller degrades (backpressure or a stream reset), never mallocs;
//  - release() of a pointer that is not a block start of this pool aborts (no silent corruption);
//  - a block released twice is caught at once by a bitmap of the blocks handed out (AUDIT A-12):
//    test, fuzz and sanitizer builds abort; a release build logs it, counts it and ignores the
//    second release (the block is not put back twice, so it can never get two owners).
#pragma once
#include <atomic>
#include <cstdlib>
#include <memory>

#include "common.hpp"

namespace wisp {

class BufferPool {
 public:
  // use_malloc: benchmark stage (a) without pools: every acquire is a malloc (still capped by count).
  BufferPool(std::size_t block_size, std::size_t count, bool use_malloc = false);
  ~BufferPool();
  BufferPool(const BufferPool&) = delete;
  BufferPool& operator=(const BufferPool&) = delete;

  // nullptr when exhausted. Ordinary callers cannot take the last `reserve` blocks; `privileged`
  // ones (protocol replies: CLOSE, PONG, CONTINUE, HTTP status) can (AUDIT A-4).
  u8* acquire(bool privileged = false);
  void set_reserve(std::size_t n) { reserve_ = n < count_ ? n : count_; }
  void release(u8* p);         // p from acquire() of this pool
  std::size_t block_size() const { return size_; }
  std::size_t capacity() const { return count_; }
  std::size_t in_use() const { return in_use_.load(std::memory_order_relaxed); }
  // Return this thread's cached blocks to the shared ring (call before a worker thread exits).
  void flush_thread_cache();
  // double releases ignored so far (release builds); abort instead when set (the default in test builds)
  std::size_t double_releases() const { return doubles_.load(std::memory_order_relaxed); }
  void set_abort_on_double_release(bool on) { abort_double_ = on; }

 private:
  struct Cell {
    std::atomic<std::size_t> seq;
    u32 index;
  };
  bool ring_push(u32 index);
  bool ring_pop(u32& index);
  bool take_fresh(u32& index);
  u32 index_of(const u8* p) const;

  std::size_t size_, count_, mask_;
  bool malloc_;
  u8* slab_ = nullptr;
  std::size_t slab_bytes_ = 0;
  std::unique_ptr<Cell[]> cells_;
  alignas(64) std::atomic<std::size_t> enq_{0};
  alignas(64) std::atomic<std::size_t> deq_{0};
  alignas(64) std::atomic<std::size_t> in_use_{0};
  alignas(64) std::atomic<std::size_t> fresh_{0};  // blocks [fresh_, count_) were never handed out
  unsigned id_;  // selects this pool's slot in the thread caches
  std::unique_ptr<std::atomic<u64>[]> owned_;  // bit i: block i is handed out (pool mode only)
  std::atomic<std::size_t> doubles_{0};
  bool abort_double_;
  std::size_t reserve_ = 0;
};

// A writable region of a pool block with read/write cursors; the unit of every byte queue.
struct Block {
  Block* next = nullptr;
  BufferPool* pool = nullptr;  // the pool it came from (site reads use two sizes)
  u8* data = nullptr;   // block start (pool memory)
  u32 begin = 0;        // first unsent byte
  u32 end = 0;          // one past the last valid byte
  u32 cap = 0;
  u32 room() const { return cap - end; }
  u32 size() const { return end - begin; }
};

}  // namespace wisp
