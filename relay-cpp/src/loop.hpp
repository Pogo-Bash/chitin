// One event loop per worker thread: edge-triggered readiness (kqueue EV_CLEAR on macOS/BSD,
// epoll EPOLLET on Linux, or io_uring multishot POLL_ADD on Linux with WISP_IO_URING and
// --io-uring), a hashed timer wheel, and deferred work lists.
//
// Invariants:
//  - a Handle is registered with at most one loop, and its owner never frees it while an event
//    for it may still be delivered in the current batch: owners call Loop::retire(), the object
//    is destroyed after the batch (no use-after-free from stale events);
//  - readiness is edge-triggered, so every handler keeps its own `readable`/`writable` flags and
//    drains until EAGAIN or until it chooses to stop (then the flag stays set and the handler is
//    revisited from the run queue, not from the kernel).
#pragma once
#include <functional>
#include <vector>

#include "common.hpp"

namespace wisp {

struct Handle {
  virtual ~Handle() = default;
  virtual void on_io(bool readable, bool writable, bool hup) = 0;
  int fd = -1;
  bool readable = false, writable = false;
  bool registered = false;
  bool retired = false;
  bool queued = false;  // in the run queue
  // io_uring bookkeeping
  u32 ring_gen = 0;
};

struct Timer {
  Timer* prev = nullptr;
  Timer* next = nullptr;
  i64 when = 0;
  void (*fn)(void*) = nullptr;
  void* arg = nullptr;
  bool armed() const { return prev != nullptr; }
};

class Backend;

class Loop {
 public:
  explicit Loop(bool io_uring = false);
  ~Loop();
  Loop(const Loop&) = delete;
  Loop& operator=(const Loop&) = delete;

  // Register for read+write readiness (edge-triggered). False on failure.
  bool add(Handle* h);
  void remove(Handle* h);  // before close(fd)
  // Run once more in this iteration's run phase (fairness: handlers that stopped early).
  void defer(Handle* h);
  // Destroy `h` (delete) after the current event batch.
  void retire(Handle* h);
  // Called at the end of every iteration, after events and the run queue (write coalescing).
  void at_end(std::function<void()> fn) { end_hooks_.push_back(std::move(fn)); }

  void arm(Timer& t, i64 delay_ms);
  void disarm(Timer& t);

  i64 now() const { return now_; }
  i64 update_now();
  void run();
  // One iteration: wait up to timeout_ms (-1: the loop's own choice) for events, then run the
  // run queue, timers, end hooks and the graveyard. Used by run() and by the session fuzzer.
  void run_once(int timeout_ms = -1);
  void stop() { stop_ = true; }
  bool stopping() const { return stop_; }
  const char* backend_name() const;

 private:
  void run_timers();
  i64 next_timeout() const;

  Backend* be_;
  i64 now_ = 0;
  bool stop_ = false;
  std::vector<Handle*> runq_, runq_next_, graveyard_;
  std::vector<std::function<void()>> end_hooks_;
  // timer wheel: 8 ms ticks, 4096 slots (~33 s per turn); later timers wait in their slot
  static constexpr int kSlots = 4096;
  static constexpr i64 kTick = 8;
  Timer slots_[kSlots];  // list heads (circular)
  i64 wheel_tick_ = 0;
  std::size_t armed_ = 0;
};

i64 monotonic_ms();
bool set_nonblocking(int fd);

}  // namespace wisp
