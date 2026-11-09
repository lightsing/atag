//! GPIO adapter: an absent LED never configures P0.30. Present LEDs idle high.
use atag_firmware_nrf52832::led::{FindError, FindLed, Hardware};
use embassy_nrf::{
    Peri,
    gpio::{Level, Output, OutputDrive},
    peripherals::P0_30,
};
use embassy_time::Instant;

pub struct Led {
    policy: FindLed,
    output: Option<Output<'static>>,
    on: bool,
}

impl Led {
    pub fn new(pin: Peri<'static, P0_30>, hardware: Hardware) -> Self {
        let output = if hardware.has_led {
            Some(Output::new(pin, Level::High, OutputDrive::Standard))
        } else {
            None
        };
        Self {
            policy: FindLed::new(hardware),
            output,
            on: false,
        }
    }
    pub fn hardware(&self) -> Hardware {
        self.policy.hardware()
    }
    pub fn enabled(&self) -> bool {
        self.policy.enabled()
    }
    pub fn identifying(&self) -> bool {
        self.policy.identifying(Instant::now().as_millis())
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        self.policy.set_enabled(enabled);
        self.tick();
    }
    pub fn start(&mut self) -> Result<(), FindError> {
        self.policy.start(Instant::now().as_millis())?;
        self.tick();
        Ok(())
    }
    pub fn stop(&mut self) {
        self.policy.stop();
        self.tick();
    }
    pub fn next_deadline(&self) -> Option<Instant> {
        self.policy
            .next_deadline_ms(Instant::now().as_millis())
            .map(Instant::from_millis)
    }
    pub fn tick(&mut self) {
        let on = self.policy.is_on(Instant::now().as_millis());
        if on != self.on {
            if let Some(output) = self.output.as_mut() {
                if on {
                    output.set_low();
                } else {
                    output.set_high();
                }
            }
            self.on = on;
        }
    }
}
