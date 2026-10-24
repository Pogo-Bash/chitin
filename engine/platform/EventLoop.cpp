// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])

#include "EventLoop.h"
#include <AK/Format.h>
#include <AK/Time.h>
#include <stdlib.h>
#include <LibCore/Event.h>
#include <LibCore/ThreadEventQueue.h>

// The host's turn (glue/engine/30-host.js): nonzero while page JavaScript has run since the host's microtasks last drained.
// The host then runs a task of its own after them and pumps again (docs/crypto.md, "One task, then the microtasks").
extern "C" int ganglion_host_turn_pending(void);
// A nested wait (glue/engine/30-host.js): blocks the engine's thread for at most `ms` milliseconds (-1: no timer armed) until
// the host has an event of a synchronous stream to hand over, delivers it (ganglion_tcp_* inside the call) and returns how many
// it delivered. A host that cannot block returns 0 at once.
extern "C" int ganglion_host_wait(int ms);

namespace Ganglion {

int g_debug = 0;

static i64 now_ms()
{
    return MonotonicTime::now().milliseconds();
}

NonnullOwnPtr<Core::EventLoopImplementation> EventLoopManager::make_implementation()
{
    return make<EventLoopImplementation>(*this);
}

intptr_t EventLoopManager::register_timer(Core::EventReceiver& owner, int milliseconds, bool should_reload)
{
    auto id = m_next_timer_id++;
    if (g_debug & 1)
        dbgln("ganglion: timer {} in {} ms (now {} ms, reload {})", id, milliseconds, now_ms(), should_reload);
    m_timers.append(Timer { .id = id, .owner = owner.make_weak_ptr(), .deadline_ms = now_ms() + milliseconds, .interval_ms = milliseconds, .should_reload = should_reload });
    return id;
}

void EventLoopManager::unregister_timer(intptr_t timer_id)
{
    for (auto& timer : m_timers) {
        if (timer.id == timer_id)
            timer.dead = true;
    }
}

int g_nested_pumps = 0;

size_t EventLoopManager::pump()
{
    // HTML's event loop performs a microtask checkpoint after every task. Page JavaScript runs on the host's V8, whose
    // microtask queue drains only when the host's stack unwinds: after a task that ran page code nothing more runs here
    // until the host's microtasks have (before, one pump ran several tasks and their promise reactions all came after).
    // Not inside a nested wait (a synchronous XMLHttpRequest): the host's stack cannot unwind there, the HTML event loop is
    // paused by its caller, and what has to run is the platform's own work (the fetch's deferred steps, the network, timers).
    if (g_nested_pumps == 0 && ganglion_host_turn_pending())
        return 0;
    auto now = now_ms();
    // Timers first: a timer that fires posts an event, which the queue then runs. A timer registered while
    // pumping (by a handler) is only seen next time, so this cannot loop forever.
    auto count = m_timers.size();
    for (size_t i = 0; i < count; ++i) {
        auto& timer = m_timers[i];
        if (timer.dead || timer.deadline_ms > now)
            continue;
        auto owner = timer.owner.strong_ref();
        if (!owner) {
            timer.dead = true;
            continue;
        }
        if (timer.should_reload)
            timer.deadline_ms = now + max<i64>(timer.interval_ms, 1);
        else
            timer.dead = true;
        Core::ThreadEventQueue::current().post_event(owner, Core::Event::Type::Timer);
    }
    m_timers.remove_all_matching([](auto& timer) { return timer.dead; });
    return Core::ThreadEventQueue::current().process();
}

i64 EventLoopManager::next_timer_in_ms() const
{
    i64 soonest = -1;
    auto now = now_ms();
    for (auto const& timer : m_timers) {
        if (timer.dead)
            continue;
        auto in = max<i64>(timer.deadline_ms - now, 0);
        if (soonest < 0 || in < soonest)
            soonest = in;
    }
    return soonest;
}

size_t EventLoopImplementation::pump(PumpMode)
{
    // Only a nested wait comes here (Core::EventLoop::spin_until; the host's own turns call EventLoopManager::pump through
    // ganglion_pump). Events normally come from the host, which cannot hand any over while its stack is under this call; what
    // it can hand over is a synchronous stream's (Network.cpp: the connections opened inside a nested wait), so when nothing
    // ran, the host is asked to block until one has news or the next timer is due.
    ++g_nested_pumps;
    auto ran = m_manager.pump();
    if (ran == 0 && !Core::ThreadEventQueue::current().has_pending_events()) {
        auto next = m_manager.next_timer_in_ms();
        ran = static_cast<size_t>(max(ganglion_host_wait(next < 0 ? -1 : static_cast<int>(min<i64>(next, 0x7FFFFFFF))), 0));
    }
    --g_nested_pumps;
    return ran;
}

}
