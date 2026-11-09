//! Sparse AIN4 battery-divider and VDD measurements with SAADC off when idle.
use atag_firmware_nrf52832::telemetry::PowerReading;
use embassy_nrf::{
    Peri, bind_interrupts,
    gpio::Flex,
    interrupt::{InterruptExt, Priority, SAADC as SAADC_INTERRUPT},
    peripherals,
    saadc::{self, ChannelConfig, Saadc, VddInput},
};

const AVERAGE_COUNT: u32 = 8;
bind_interrupts!(struct SaadcIrqs { SAADC => saadc::InterruptHandler; });

pub struct VoltageMonitor {
    peripheral: Peri<'static, peripherals::SAADC>,
    battery_pin: Peri<'static, peripherals::P0_28>,
}

impl VoltageMonitor {
    pub fn new(
        peripheral: Peri<'static, peripherals::SAADC>,
        mut battery_pin: Peri<'static, peripherals::P0_28>,
        priority: Priority,
    ) -> Self {
        SAADC_INTERRUPT.set_priority(priority);
        // The analog divider must not power an input buffer at intermediate
        // voltages, nor acquire an internal pull-up/down load.
        {
            let mut pin = Flex::new(battery_pin.reborrow());
            pin.set_as_disconnected();
        }
        Self {
            peripheral,
            battery_pin,
        }
    }

    pub async fn sample(&mut self) -> PowerReading {
        let mut battery = ChannelConfig::single_ended(self.battery_pin.reborrow());
        // 1 MOhm || 1.5 MOhm = 600 kOhm; use the longest acquisition time.
        battery.time = saadc::Time::_40US;
        let supply = ChannelConfig::single_ended(VddInput);
        // Scan channels without hardware oversampling; average in software.
        let mut adc = Saadc::new(
            self.peripheral.reborrow(),
            SaadcIrqs,
            saadc::Config::default(),
            [battery, supply],
        );
        adc.calibrate().await;
        let mut samples = [0_i16; 2];
        adc.sample(&mut samples).await; // Discard the first settled conversion.
        let mut battery_sum = 0;
        let mut supply_sum = 0;
        for _ in 0..AVERAGE_COUNT {
            adc.sample(&mut samples).await;
            battery_sum += samples[0].clamp(0, 4095) as u32;
            supply_sum += samples[1].clamp(0, 4095) as u32;
        }
        // Driver Drop resets/disables SAADC and disconnects the inputs.
        drop(adc);
        PowerReading::from_sums(battery_sum, supply_sum, AVERAGE_COUNT)
    }
}
