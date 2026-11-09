//! Level-sense button wakeup that coexists with the SoftDevice vector table.
//!
//! The nRF52832 GPIO `SENSE` mechanism feeds the GPIOTE PORT event without
//! consuming a GPIOTE channel. `nrf-softdevice` owns the interrupt vector
//! table, so this module supplies only the application GPIOTE handler.

use core::{
    future::poll_fn,
    ptr::{read_volatile, write_volatile},
    task::Poll,
};

use embassy_nrf::{
    gpio::Input,
    interrupt::{GPIOTE as GPIOTE_INTERRUPT, InterruptExt, Priority},
};
use embassy_sync::waitqueue::AtomicWaker;

const BUTTON_PIN: u32 = 13;
const BUTTON_MASK: u32 = 1 << BUTTON_PIN;

const P0_BASE: usize = 0x5000_0000;
const P0_LATCH: usize = 0x520;
const P0_DETECTMODE: usize = 0x524;
const P0_PIN_CNF_0: usize = 0x700;

const GPIOTE_BASE: usize = 0x4000_6000;
const GPIOTE_EVENTS_PORT: usize = 0x17c;
const GPIOTE_INTENSET: usize = 0x304;
const GPIOTE_PORT_INTERRUPT: u32 = 1 << 31;

const SENSE_SHIFT: u32 = 16;
const SENSE_MASK: u32 = 0x03 << SENSE_SHIFT;
const SENSE_DISABLED: u32 = 0;
const SENSE_HIGH: u32 = 0x02;
const SENSE_LOW: u32 = 0x03;
const DETECTMODE_LDETECT: u32 = 1;

static WAKER: AtomicWaker = AtomicWaker::new();

/// Active-low board button backed by GPIO level sensing.
pub struct EventButton<'d> {
    input: Input<'d>,
}

impl<'d> EventButton<'d> {
    /// Wraps the already configured P0.13 input.
    pub fn new(input: Input<'d>) -> Self {
        Self { input }
    }

    /// Returns true while the button is held down.
    pub fn is_low(&self) -> bool {
        self.input.is_low()
    }

    /// Sleeps until the active-low button is pressed.
    pub async fn wait_for_low(&mut self) {
        self.wait_for_level(false).await;
    }

    /// Sleeps until the active-low button is released.
    pub async fn wait_for_high(&mut self) {
        self.wait_for_level(true).await;
    }

    async fn wait_for_level(&mut self, high: bool) {
        poll_fn(|context| {
            if self.input.is_high() == high {
                set_sense(SENSE_DISABLED);
                return Poll::Ready(());
            }

            WAKER.register(context.waker());
            set_sense(if high { SENSE_HIGH } else { SENSE_LOW });

            // Close the race between the first level read and arming SENSE.
            if self.input.is_high() == high {
                set_sense(SENSE_DISABLED);
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await
    }
}

/// Initializes latched GPIO detection and the application GPIOTE interrupt.
pub fn init(priority: Priority) {
    set_sense(SENSE_DISABLED);
    write_p0(P0_DETECTMODE, DETECTMODE_LDETECT);
    write_p0(P0_LATCH, u32::MAX);
    write_gpiote(GPIOTE_EVENTS_PORT, 0);
    write_gpiote(GPIOTE_INTENSET, GPIOTE_PORT_INTERRUPT);

    GPIOTE_INTERRUPT.unpend();
    GPIOTE_INTERRUPT.set_priority(priority);
    // SAFETY: P0.13 is the only pin armed by this module, the handler is
    // installed below, and P2 is an application priority allowed by S112.
    unsafe { GPIOTE_INTERRUPT.enable() };
}

#[allow(non_snake_case)]
#[unsafe(no_mangle)]
unsafe extern "C" fn GPIOTE() {
    if read_gpiote(GPIOTE_EVENTS_PORT) == 0 {
        return;
    }

    write_gpiote(GPIOTE_EVENTS_PORT, 0);
    let latched = read_p0(P0_LATCH);
    write_p0(P0_LATCH, latched);
    if latched & BUTTON_MASK != 0 {
        set_sense(SENSE_DISABLED);
        WAKER.wake();
    }
}

fn set_sense(sense: u32) {
    let offset = P0_PIN_CNF_0 + BUTTON_PIN as usize * core::mem::size_of::<u32>();
    let value = read_p0(offset);
    write_p0(offset, (value & !SENSE_MASK) | (sense << SENSE_SHIFT));
}

fn read_p0(offset: usize) -> u32 {
    // SAFETY: every caller supplies a fixed, aligned P0 register offset.
    unsafe { read_volatile((P0_BASE + offset) as *const u32) }
}

fn write_p0(offset: usize, value: u32) {
    // SAFETY: every caller supplies a fixed, aligned P0 register offset.
    unsafe { write_volatile((P0_BASE + offset) as *mut u32, value) }
}

fn read_gpiote(offset: usize) -> u32 {
    // SAFETY: every caller supplies a fixed, aligned GPIOTE register offset.
    unsafe { read_volatile((GPIOTE_BASE + offset) as *const u32) }
}

fn write_gpiote(offset: usize, value: u32) {
    // SAFETY: every caller supplies a fixed, aligned GPIOTE register offset.
    unsafe { write_volatile((GPIOTE_BASE + offset) as *mut u32, value) }
}
