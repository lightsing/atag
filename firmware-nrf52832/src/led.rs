//! Optional board hardware and finite find-device LED policy, independent of GPIO.

pub const HARDWARE_ADDRESS: u32 = 0x10001080; // UICR.CUSTOMER[0..2]
pub const LED_DESCRIPTOR: [u8; 8] = *b"ATGH\x01\x01\x1e\x01";
pub const FIND_DURATION_MS: u64 = 10_000;
const PERIOD_MS: u64 = 500;
const ON_MS: u64 = 150;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Hardware {
    pub has_led: bool,
}

impl Hardware {
    /// Unknown/erased descriptors indicate no LED capability. Hardware
    /// presence is provisioned once, never a GATT setting or OTA image feature.
    pub fn decode(descriptor: &[u8; 8]) -> Self {
        Self {
            has_led: descriptor == &LED_DESCRIPTOR,
        }
    }

    /// New settings may enable LED use only when the physical board has one.
    pub fn accepts_led_setting(self, enabled: bool) -> bool {
        self.has_led || !enabled
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FindError {
    NoLed = 1,
    Disabled = 2,
}

pub struct FindLed {
    hardware: Hardware,
    enabled: bool,
    started_ms: Option<u64>,
}

impl FindLed {
    pub const fn new(hardware: Hardware) -> Self {
        Self {
            hardware,
            enabled: false,
            started_ms: None,
        }
    }

    pub fn hardware(&self) -> Hardware {
        self.hardware
    }
    pub fn enabled(&self) -> bool {
        self.hardware.has_led && self.enabled
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !self.enabled() {
            self.stop();
        }
    }
    pub fn start(&mut self, now_ms: u64) -> Result<(), FindError> {
        if !self.hardware.has_led {
            return Err(FindError::NoLed);
        }
        if !self.enabled {
            return Err(FindError::Disabled);
        }
        self.started_ms = Some(now_ms);
        Ok(())
    }
    pub fn stop(&mut self) {
        self.started_ms = None;
    }
    pub fn identifying(&self, now_ms: u64) -> bool {
        self.enabled()
            && self
                .started_ms
                .is_some_and(|start| now_ms.saturating_sub(start) < FIND_DURATION_MS)
    }
    pub fn is_on(&self, now_ms: u64) -> bool {
        self.identifying(now_ms) && (now_ms - self.started_ms.unwrap()) % PERIOD_MS < ON_MS
    }
    pub fn next_deadline_ms(&self, now_ms: u64) -> Option<u64> {
        if !self.identifying(now_ms) {
            return None;
        }
        let start = self.started_ms.unwrap();
        let elapsed = now_ms - start;
        let phase = elapsed % PERIOD_MS;
        let next = now_ms
            + if phase < ON_MS {
                ON_MS - phase
            } else {
                PERIOD_MS - phase
            };
        Some(next.min(start + FIND_DURATION_MS))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_known_board_descriptor_enables_hardware() {
        assert!(!Hardware::decode(&[0xff; 8]).has_led);
        assert!(!Hardware::decode(&[0; 8]).has_led);
        let mut wrong_pin = LED_DESCRIPTOR;
        wrong_pin[6] = 17;
        assert!(!Hardware::decode(&wrong_pin).has_led);
        assert!(Hardware::decode(&LED_DESCRIPTOR).has_led);
        assert!(!Hardware::default().accepts_led_setting(true));
        assert!(Hardware::default().accepts_led_setting(false));
    }

    #[test]
    fn absent_and_disabled_led_cannot_light() {
        let mut absent = FindLed::new(Hardware::default());
        absent.set_enabled(true);
        assert_eq!(absent.start(0), Err(FindError::NoLed));
        assert!(!absent.is_on(0));
        assert_eq!(absent.next_deadline_ms(0), None);
        let mut present = FindLed::new(Hardware { has_led: true });
        assert_eq!(present.start(0), Err(FindError::Disabled));
        assert!(!present.is_on(0));
    }

    #[test]
    fn finite_pattern_disable_and_cancel_stop_without_idle_wakeups() {
        let mut led = FindLed::new(Hardware { has_led: true });
        led.set_enabled(true);
        led.start(1000).unwrap();
        assert!(led.is_on(1000));
        assert!(led.is_on(1149));
        assert!(!led.is_on(1150));
        assert!(!led.is_on(1499));
        assert!(led.is_on(1500));
        assert_eq!(led.next_deadline_ms(1000), Some(1150));
        assert_eq!(led.next_deadline_ms(1150), Some(1500));
        assert!(!led.is_on(11000));
        assert_eq!(led.next_deadline_ms(11000), None);
        led.start(12000).unwrap();
        led.set_enabled(false);
        assert!(!led.is_on(12001));
        assert_eq!(led.next_deadline_ms(12001), None);
        led.set_enabled(true);
        assert!(!led.is_on(12002));
        led.start(13000).unwrap();
        led.stop();
        assert!(!led.is_on(13000));
    }
}
