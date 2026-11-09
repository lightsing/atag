//! RTC1-backed Embassy time driver that coexists with Nordic SoftDevice.
//!
//! `nrf-softdevice` already supplies the nRF52832 interrupt vector table.
//! Enabling embassy-nrf's `rt` feature would supply a second vector table,
//! while disabling it also omits embassy-nrf's private RTC1 handler. This
//! module installs the missing handler without defining another vector table.

use core::{
    cell::{Cell, RefCell},
    ptr::{read_volatile, write_volatile},
    sync::atomic::{AtomicU32, Ordering, compiler_fence},
    task::Waker,
};

use critical_section::Mutex;
use embassy_nrf::interrupt::{InterruptExt, Priority, RTC1 as RTC1_INTERRUPT};
use embassy_time_driver::Driver;
use embassy_time_queue_utils::Queue;

const RTC1_BASE: usize = 0x4001_1000;
const TASKS_START: usize = 0x000;
const TASKS_CLEAR: usize = 0x008;
const EVENTS_OVRFLW: usize = 0x104;
const EVENTS_COMPARE_0: usize = 0x140;
const EVENTS_COMPARE_3: usize = 0x14c;
const INTENSET: usize = 0x304;
const INTENCLR: usize = 0x308;
const COUNTER: usize = 0x504;
const CC_0: usize = 0x540;
const CC_3: usize = 0x54c;

const INT_OVRFLW: u32 = 1 << 1;
const INT_COMPARE_0: u32 = 1 << 16;
const INT_COMPARE_3: u32 = 1 << 19;
const RTC_MASK: u32 = 0x00ff_ffff;
const HALF_PERIOD: u32 = 0x0080_0000;

struct AlarmState {
    timestamp: Cell<u64>,
}

unsafe impl Send for AlarmState {}

struct RtcDriver {
    /// Number of completed 2^23-tick half-periods.
    period: AtomicU32,
    alarm: Mutex<AlarmState>,
    queue: Mutex<RefCell<Queue>>,
}

embassy_time_driver::time_driver_impl!(static DRIVER: RtcDriver = RtcDriver {
    period: AtomicU32::new(0),
    alarm: Mutex::new(AlarmState { timestamp: Cell::new(u64::MAX) }),
    queue: Mutex::new(RefCell::new(Queue::new())),
});

/// Initializes RTC1 and its application interrupt.
pub fn init(priority: Priority) {
    write(TASKS_CLEAR, 1);
    while read(COUNTER) != 0 {}

    write(EVENTS_OVRFLW, 0);
    write(EVENTS_COMPARE_0, 0);
    write(EVENTS_COMPARE_3, 0);
    write(CC_3, HALF_PERIOD);
    write(INTENSET, INT_OVRFLW | INT_COMPARE_3);
    write(TASKS_START, 1);

    RTC1_INTERRUPT.set_priority(priority);
    // SAFETY: RTC1 is dedicated to this global time driver, its handler is
    // installed below, and the selected priority is permitted by SoftDevice.
    unsafe { RTC1_INTERRUPT.enable() };
}

impl RtcDriver {
    fn on_interrupt(&self) {
        if read(EVENTS_OVRFLW) != 0 {
            write(EVENTS_OVRFLW, 0);
            self.next_period();
        }
        if read(EVENTS_COMPARE_3) != 0 {
            write(EVENTS_COMPARE_3, 0);
            self.next_period();
        }
        if read(EVENTS_COMPARE_0) != 0 {
            write(EVENTS_COMPARE_0, 0);
            critical_section::with(|cs| self.trigger_alarm(cs));
        }
    }

    fn next_period(&self) {
        critical_section::with(|cs| {
            let period = self.period.load(Ordering::Relaxed).wrapping_add(1);
            self.period.store(period, Ordering::Relaxed);
            let period_start = u64::from(period) << 23;
            let timestamp = self.alarm.borrow(cs).timestamp.get();
            if timestamp < period_start + 0x00c0_0000 {
                write(INTENSET, INT_COMPARE_0);
            }
        });
    }

    fn trigger_alarm(&self, cs: critical_section::CriticalSection<'_>) {
        write(INTENCLR, INT_COMPARE_0);
        self.alarm.borrow(cs).timestamp.set(u64::MAX);

        let mut next = self
            .queue
            .borrow(cs)
            .borrow_mut()
            .next_expiration(self.now());
        while !self.set_alarm(cs, next) {
            next = self
                .queue
                .borrow(cs)
                .borrow_mut()
                .next_expiration(self.now());
        }
    }

    fn set_alarm(&self, cs: critical_section::CriticalSection<'_>, timestamp: u64) -> bool {
        self.alarm.borrow(cs).timestamp.set(timestamp);

        loop {
            let now = self.now();
            if timestamp <= now {
                write(INTENCLR, INT_COMPARE_0);
                self.alarm.borrow(cs).timestamp.set(u64::MAX);
                return false;
            }

            // nRF52 does not reliably generate COMPARE for COUNTER+0/1, so
            // keep a three-tick guard just like Embassy's upstream driver.
            let safe_timestamp = timestamp.max(now + 3);
            write(CC_0, safe_timestamp as u32 & RTC_MASK);
            if timestamp - now < 0x00c0_0000 {
                write(INTENSET, INT_COMPARE_0);
                if self.now() + 2 <= timestamp {
                    return true;
                }
            } else {
                write(INTENCLR, INT_COMPARE_0);
                return true;
            }
        }
    }
}

impl Driver for RtcDriver {
    fn now(&self) -> u64 {
        // Read the half-period first. If RTC crossed a half-period boundary
        // before COUNTER was read, the parity correction selects the new one.
        let period = self.period.load(Ordering::Relaxed);
        compiler_fence(Ordering::Acquire);
        let counter = read(COUNTER);
        (u64::from(period) << 23) + u64::from(counter ^ ((period & 1) << 23))
    }

    fn schedule_wake(&self, at: u64, waker: &Waker) {
        critical_section::with(|cs| {
            let mut queue = self.queue.borrow(cs).borrow_mut();
            if queue.schedule_wake(at, waker) {
                let mut next = queue.next_expiration(self.now());
                while !self.set_alarm(cs, next) {
                    next = queue.next_expiration(self.now());
                }
            }
        });
    }
}

#[allow(non_snake_case)]
#[unsafe(no_mangle)]
unsafe extern "C" fn RTC1() {
    DRIVER.on_interrupt();
}

fn read(offset: usize) -> u32 {
    // SAFETY: offsets are fixed, aligned RTC1 task/event/register addresses.
    unsafe { read_volatile((RTC1_BASE + offset) as *const u32) }
}

fn write(offset: usize, value: u32) {
    // SAFETY: offsets are fixed, aligned RTC1 task/event/register addresses.
    unsafe { write_volatile((RTC1_BASE + offset) as *mut u32, value) }
}
