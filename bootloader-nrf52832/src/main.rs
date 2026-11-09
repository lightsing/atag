#![cfg_attr(target_arch = "arm", no_std)]
#![cfg_attr(target_arch = "arm", no_main)]

#[cfg(not(target_arch = "arm"))]
fn main() {}

#[cfg(target_arch = "arm")]
#[cortex_m_rt::entry]
fn main() -> ! {
    use core::cell::RefCell;
    use embassy_boot_nrf::{BootLoader, BootLoaderConfig, WatchdogFlash};
    use embassy_nrf::{nvmc::Nvmc, wdt};
    use embassy_sync::blocking_mutex::{Mutex, raw::NoopRawMutex};

    // No radio/clock/interrupt initialization in the bootloader. S112 starts
    // afresh through the MBR after the power-fail-safe swap/revert completes.
    let p = unsafe { embassy_nrf::Peripherals::steal() };
    let mut watchdog = wdt::Config::default();
    watchdog.timeout_ticks = 32768 * 30;
    watchdog.action_during_sleep = wdt::SleepConfig::Run;
    watchdog.action_during_debug_halt = wdt::HaltConfig::Pause;
    let flash = WatchdogFlash::start(Nvmc::new(p.NVMC), p.WDT, watchdog);
    let flash = Mutex::<NoopRawMutex, _>::new(RefCell::new(flash));
    let config = BootLoaderConfig::from_linkerfile_blocking(&flash, &flash, &flash);
    let boot: BootLoader = BootLoader::prepare(config);
    // This forwards IRQs to S112 and starts its reset handler, which starts
    // the application at S112's hardcoded APP_CODE_BASE = 0x19000.
    unsafe { boot.load(0x19000) }
}

#[cfg(target_arch = "arm")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // A started WDT resets us; unconfirmed trial images are reverted.
    loop {
        cortex_m::asm::wfi();
    }
}
