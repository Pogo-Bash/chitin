// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 [OWNER NAME]
// Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
//
// LibCore's event loop for a segment Worker: there is no poll() and no thread of our own, so the host
// pumps it (ganglion_pump) whenever it has handed the engine something or a timer is due.

#pragma once

#include <AK/Vector.h>
#include <AK/WeakPtr.h>
#include <LibCore/EventLoopImplementation.h>
#include <LibCore/EventReceiver.h>

namespace Ganglion {

// Diagnostics the host switches on (ganglion_debug): bit 0 timers, bit 1 paint.
extern int g_debug;
// Nonzero while a nested wait (Core::EventLoop::spin_until: a synchronous XMLHttpRequest) pumps the loop.
extern int g_nested_pumps;

class EventLoopManager final : public Core::EventLoopManager {
public:
    EventLoopManager() = default;
    virtual ~EventLoopManager() override = default;

    virtual NonnullOwnPtr<Core::EventLoopImplementation> make_implementation() override;
    virtual intptr_t register_timer(Core::EventReceiver&, int milliseconds, bool should_reload) override;
    virtual void unregister_timer(intptr_t timer_id) override;
    virtual void register_notifier(Core::Notifier&) override { }
    virtual void unregister_notifier(Core::Notifier&) override { }
    virtual void did_post_event() override { }
    virtual int register_signal(int, Function<void(int)>) override { return 0; }
    virtual void unregister_signal(int) override { }

    // Fires the timers that are due and runs the queued events. Returns how many events ran.
    size_t pump();
    // Milliseconds until the next timer fires, or -1 with no timer armed.
    i64 next_timer_in_ms() const;

private:
    struct Timer {
        intptr_t id;
        WeakPtr<Core::EventReceiver> owner;
        i64 deadline_ms;
        i64 interval_ms;
        bool should_reload;
        bool dead { false };
    };
    Vector<Timer> m_timers;
    intptr_t m_next_timer_id { 1 };
};

class EventLoopImplementation final : public Core::EventLoopImplementation {
public:
    explicit EventLoopImplementation(EventLoopManager& manager)
        : m_manager(manager)
    {
    }
    virtual int exec() override { VERIFY_NOT_REACHED(); }
    virtual size_t pump(PumpMode) override;
    virtual void quit(int) override { }
    virtual void wake() override { }

private:
    EventLoopManager& m_manager;
};

}
