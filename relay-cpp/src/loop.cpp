#include "loop.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <ctime>

#if defined(__linux__)
#include <sys/epoll.h>
#if WISP_IO_URING
#include <linux/io_uring.h>
#include <poll.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <atomic>
#endif
#else
#include <sys/event.h>
#include <sys/time.h>
#endif

namespace wisp {

i64 monotonic_ms() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return i64(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

bool set_nonblocking(int fd) {
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl < 0) return false;
  if (fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0) return false;
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  return true;
}

class Backend {
 public:
  virtual ~Backend() = default;
  virtual bool add(Handle* h) = 0;
  virtual void remove(Handle* h) = 0;
  // Wait up to timeout_ms (-1 forever) and call fn for each event.
  // The loop's clock is refreshed (*now) right after the kernel returns and before any handler
  // runs, so timers armed by handlers count from the real time, not from before the wait.
  virtual void wait(int timeout_ms, void (*fn)(Handle*, bool r, bool w, bool hup), i64* now) = 0;
  // io_uring: the handle may still get completions after remove(); true = keep it alive.
  virtual bool pending_after_remove(Handle*) { return false; }
  virtual const char* name() const = 0;
};

namespace {
constexpr int kBatch = 256;

#if defined(__linux__)
class Epoll final : public Backend {
 public:
  Epoll() {
    ep_ = epoll_create1(EPOLL_CLOEXEC);
    if (ep_ < 0) { std::perror("epoll_create1"); std::abort(); }
  }
  ~Epoll() override { close(ep_); }
  bool add(Handle* h) override {
    epoll_event ev{};
    ev.events = EPOLLIN | EPOLLOUT | EPOLLRDHUP | EPOLLET;
    ev.data.ptr = h;
    return epoll_ctl(ep_, EPOLL_CTL_ADD, h->fd, &ev) == 0;
  }
  void remove(Handle* h) override { epoll_ctl(ep_, EPOLL_CTL_DEL, h->fd, nullptr); }
  void wait(int timeout_ms, void (*fn)(Handle*, bool, bool, bool), i64* now) override {
    epoll_event evs[kBatch];
    int n = epoll_wait(ep_, evs, kBatch, timeout_ms);
    *now = monotonic_ms();
    for (int i = 0; i < n; i++) {
      auto* h = static_cast<Handle*>(evs[i].data.ptr);
      u32 e = evs[i].events;
      fn(h, e & (EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR), e & (EPOLLOUT | EPOLLERR | EPOLLHUP), e & (EPOLLHUP | EPOLLERR));
    }
  }
  const char* name() const override { return "epoll"; }

 private:
  int ep_;
};

#if WISP_IO_URING
// Readiness through io_uring: one multishot IORING_OP_POLL_ADD per fd (Linux 5.13+), all
// registrations and removals batched into the io_uring_enter() that also waits. Raw syscalls,
// no liburing.
class Uring final : public Backend {
 public:
  Uring() {
    io_uring_params p{};
    fd_ = int(syscall(__NR_io_uring_setup, 4096, &p));
    if (fd_ < 0) { std::perror("io_uring_setup"); std::abort(); }
    sq_sz_ = p.sq_off.array + p.sq_entries * sizeof(u32);
    cq_sz_ = p.cq_off.cqes + p.cq_entries * sizeof(io_uring_cqe);
    single_ = p.features & IORING_FEAT_SINGLE_MMAP;
    if (single_) sq_sz_ = cq_sz_ = std::max(sq_sz_, cq_sz_);
    sq_ = static_cast<u8*>(mmap(nullptr, sq_sz_, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd_, IORING_OFF_SQ_RING));
    cq_ = single_ ? sq_ : static_cast<u8*>(mmap(nullptr, cq_sz_, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd_, IORING_OFF_CQ_RING));
    sqes_sz_ = p.sq_entries * sizeof(io_uring_sqe);
    sqes_ = static_cast<io_uring_sqe*>(mmap(nullptr, sqes_sz_, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, fd_, IORING_OFF_SQES));
    if (sq_ == MAP_FAILED || cq_ == MAP_FAILED || sqes_ == MAP_FAILED) { std::perror("io_uring mmap"); std::abort(); }
    sq_head_ = reinterpret_cast<std::atomic<u32>*>(sq_ + p.sq_off.head);
    sq_tail_ = reinterpret_cast<std::atomic<u32>*>(sq_ + p.sq_off.tail);
    sq_mask_ = *reinterpret_cast<u32*>(sq_ + p.sq_off.ring_mask);
    sq_array_ = reinterpret_cast<u32*>(sq_ + p.sq_off.array);
    cq_head_ = reinterpret_cast<std::atomic<u32>*>(cq_ + p.cq_off.head);
    cq_tail_ = reinterpret_cast<std::atomic<u32>*>(cq_ + p.cq_off.tail);
    cq_mask_ = *reinterpret_cast<u32*>(cq_ + p.cq_off.ring_mask);
    cqes_ = reinterpret_cast<io_uring_cqe*>(cq_ + p.cq_off.cqes);
    entries_ = p.sq_entries;
  }
  ~Uring() override {
    munmap(sqes_, sqes_sz_);
    if (!single_) munmap(cq_, cq_sz_);
    munmap(sq_, sq_sz_);
    close(fd_);
  }
  bool add(Handle* h) override {
    io_uring_sqe* s = sqe();
    s->opcode = IORING_OP_POLL_ADD;
    s->fd = h->fd;
    s->poll32_events = POLLIN | POLLOUT | POLLRDHUP;
    s->len = IORING_POLL_ADD_MULTI;
    s->user_data = reinterpret_cast<u64>(h);
    h->ring_gen = 1;  // a poll is active: completions may arrive until the final one
    return true;
  }
  void remove(Handle* h) override {
    if (!h->ring_gen) return;
    io_uring_sqe* s = sqe();
    s->opcode = IORING_OP_POLL_REMOVE;
    s->fd = -1;
    s->addr = reinterpret_cast<u64>(h);
    s->user_data = 0;  // the removal's own completion carries no handle
  }
  bool pending_after_remove(Handle* h) override { return h->ring_gen != 0; }
  void wait(int timeout_ms, void (*fn)(Handle*, bool, bool, bool), i64* now) override {
    // submit pending SQEs and wait for at least one completion (with a timeout)
    __kernel_timespec ts{};
    io_uring_getevents_arg arg{};
    if (timeout_ms >= 0) {
      ts.tv_sec = timeout_ms / 1000;
      ts.tv_nsec = (timeout_ms % 1000) * 1000000LL;
      arg.ts = reinterpret_cast<u64>(&ts);
    }
    u32 flags = IORING_ENTER_GETEVENTS | IORING_ENTER_EXT_ARG;
    syscall(__NR_io_uring_enter, fd_, pending_, 1, flags, &arg, sizeof arg);
    *now = monotonic_ms();
    pending_ = 0;
    u32 head = cq_head_->load(std::memory_order_relaxed);
    u32 tail = cq_tail_->load(std::memory_order_acquire);
    for (; head != tail; head++) {
      io_uring_cqe c = cqes_[head & cq_mask_];
      if (!c.user_data) continue;
      auto* h = reinterpret_cast<Handle*>(c.user_data);
      bool more = c.flags & IORING_CQE_F_MORE;
      if (!more) h->ring_gen = 0;  // the poll is finished: no more completions for h
      if (c.res < 0) {
        if (!more && !h->retired && h->registered && c.res != -ECANCELED) add(h);  // re-arm after an error
        continue;
      }
      u32 e = u32(c.res);
      if (!more && !h->retired && h->registered) add(h);  // multishot ended (overflow): re-arm
      fn(h, e & (POLLIN | POLLRDHUP | POLLHUP | POLLERR), e & (POLLOUT | POLLERR | POLLHUP), e & (POLLHUP | POLLERR));
    }
    cq_head_->store(head, std::memory_order_release);
  }
  const char* name() const override { return "io_uring"; }

 private:
  io_uring_sqe* sqe() {
    u32 tail = sq_tail_->load(std::memory_order_relaxed);
    if (tail - sq_head_->load(std::memory_order_acquire) >= entries_) {
      // ring full: submit what we have without waiting
      syscall(__NR_io_uring_enter, fd_, pending_, 0, 0, nullptr, 0);
      pending_ = 0;
    }
    u32 idx = tail & sq_mask_;
    io_uring_sqe* s = &sqes_[idx];
    std::memset(s, 0, sizeof *s);
    sq_array_[idx] = idx;
    sq_tail_->store(tail + 1, std::memory_order_release);
    pending_++;
    return s;
  }
  int fd_;
  bool single_;
  std::size_t sq_sz_, cq_sz_, sqes_sz_;
  u8 *sq_, *cq_;
  io_uring_sqe* sqes_;
  std::atomic<u32>*sq_head_, *sq_tail_, *cq_head_, *cq_tail_;
  u32 sq_mask_, cq_mask_, *sq_array_, entries_, pending_ = 0;
  io_uring_cqe* cqes_;
};
#endif

#else
class Kqueue final : public Backend {
 public:
  Kqueue() {
    kq_ = kqueue();
    if (kq_ < 0) { std::perror("kqueue"); std::abort(); }
    fcntl(kq_, F_SETFD, FD_CLOEXEC);
  }
  ~Kqueue() override { close(kq_); }
  bool add(Handle* h) override {
    struct kevent ev[2];
    EV_SET(&ev[0], h->fd, EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, h);
    EV_SET(&ev[1], h->fd, EVFILT_WRITE, EV_ADD | EV_CLEAR, 0, 0, h);
    return kevent(kq_, ev, 2, nullptr, 0, nullptr) == 0;
  }
  void remove(Handle* h) override {
    struct kevent ev[2];
    EV_SET(&ev[0], h->fd, EVFILT_READ, EV_DELETE, 0, 0, nullptr);
    EV_SET(&ev[1], h->fd, EVFILT_WRITE, EV_DELETE, 0, 0, nullptr);
    kevent(kq_, ev, 2, nullptr, 0, nullptr);
  }
  void wait(int timeout_ms, void (*fn)(Handle*, bool, bool, bool), i64* now) override {
    struct kevent evs[kBatch];
    timespec ts{}, *tp = nullptr;
    if (timeout_ms >= 0) {
      ts.tv_sec = timeout_ms / 1000;
      ts.tv_nsec = long(timeout_ms % 1000) * 1000000L;
      tp = &ts;
    }
    int n = kevent(kq_, nullptr, 0, evs, kBatch, tp);
    *now = monotonic_ms();
    for (int i = 0; i < n; i++) {
      auto* h = static_cast<Handle*>(evs[i].udata);
      bool err = evs[i].flags & EV_ERROR;
      bool eof = evs[i].flags & EV_EOF;
      if (evs[i].filter == EVFILT_READ) fn(h, true, false, eof || err);
      else fn(h, false, true, err);
    }
  }
  const char* name() const override { return "kqueue"; }

 private:
  int kq_;
};
#endif
}  // namespace

Loop::Loop(bool io_uring) {
#if defined(__linux__)
#if WISP_IO_URING
  if (io_uring) be_ = new Uring();
  else
#endif
    be_ = new Epoll();
#else
  (void)io_uring;
  be_ = new Kqueue();
#endif
  for (auto& s : slots_) s.prev = s.next = &s;
  now_ = monotonic_ms();
  wheel_tick_ = now_ / kTick;
}

Loop::~Loop() {
  for (Handle* h : graveyard_) delete h;
  delete be_;
}

const char* Loop::backend_name() const { return be_->name(); }

bool Loop::add(Handle* h) {
  h->registered = true;
  return be_->add(h);
}

void Loop::remove(Handle* h) {
  if (!h->registered) return;
  h->registered = false;
  be_->remove(h);
}

void Loop::defer(Handle* h) {
  if (h->queued || h->retired) return;
  h->queued = true;
  runq_next_.push_back(h);
}

void Loop::retire(Handle* h) {
  if (h->retired) return;
  h->retired = true;
  graveyard_.push_back(h);
}

void Loop::arm(Timer& t, i64 delay_ms) {
  if (t.armed()) disarm(t);
  if (delay_ms < 0) delay_ms = 0;
  t.when = now_ + delay_ms;
  i64 tick = t.when / kTick;
  if (tick < wheel_tick_) tick = wheel_tick_;
  Timer& head = slots_[tick % kSlots];
  t.next = &head;
  t.prev = head.prev;
  head.prev->next = &t;
  head.prev = &t;
  armed_++;
}

void Loop::disarm(Timer& t) {
  if (!t.armed()) return;
  t.prev->next = t.next;
  t.next->prev = t.prev;
  t.prev = t.next = nullptr;
  armed_--;
}

i64 Loop::update_now() {
  now_ = monotonic_ms();
  return now_;
}

void Loop::run_timers() {
  i64 target = now_ / kTick;
  // visit every tick up to now (at most one full turn: older ticks share slots)
  i64 from = wheel_tick_;
  if (target - from >= kSlots) from = target - kSlots + 1;
  for (i64 tick = from; tick <= target; tick++) {
    Timer& head = slots_[tick % kSlots];
    for (;;) {
      Timer* due = nullptr;
      for (Timer* t = head.next; t != &head; t = t->next)
        if (t->when <= now_) { due = t; break; }
      if (!due) break;
      disarm(*due);
      due->fn(due->arg);  // may arm/disarm any timer, including ones in this slot
    }
  }
  wheel_tick_ = target;
}

i64 Loop::next_timeout() const {
  if (!runq_next_.empty()) return 0;
  if (!armed_) return 1000;
  // the next tick boundary: cheap, and timers are checked every tick while any are armed
  i64 next = (now_ / kTick + 1) * kTick;
  return std::max<i64>(1, next - now_);
}

static void dispatch(Handle* h, bool r, bool w, bool hup) {
  if (h->retired) return;
  if (r) h->readable = true;
  if (w) h->writable = true;
  h->on_io(r, w, hup);
}

void Loop::run() {
  while (!stop_) run_once();
}

void Loop::run_once(int timeout_ms) {
  {
    be_->wait(timeout_ms >= 0 ? (runq_next_.empty() ? timeout_ms : 0) : int(next_timeout()), dispatch, &now_);
    // run queue: handlers that asked to be revisited (they stopped before EAGAIN)
    runq_.swap(runq_next_);
    for (Handle* h : runq_) {
      h->queued = false;
      if (!h->retired) h->on_io(false, false, false);
    }
    runq_.clear();
    run_timers();
    for (auto& f : end_hooks_) f();
    // destroy what was retired during this iteration (no event for it can be pending any more,
    // except io_uring completions, which keep the handle until its poll has finished)
    if (!graveyard_.empty()) {
      std::size_t keep = 0;
      for (Handle* h : graveyard_) {
        if (h->queued) { graveyard_[keep++] = h; continue; }
        if (be_->pending_after_remove(h)) { graveyard_[keep++] = h; continue; }
        delete h;
      }
      graveyard_.resize(keep);
    }
  }
}

}  // namespace wisp
