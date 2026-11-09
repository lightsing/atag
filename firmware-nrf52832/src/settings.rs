//! Versioned, validated non-secret settings shared by GATT and manufacturing.

pub const SETTINGS_WIRE_LEN: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settings {
    pub led_enabled: bool,
    pub tx_power_dbm: i8,
    pub advertising_interval_ms: u32,
    pub gatt_interval_ms: u32,
    pub rotation_minutes: u32,
    pub gatt_advertising_seconds: u16,
    pub connection_seconds: u16,
    pub battery_idle_seconds: u32,
    pub battery_gatt_seconds: u16,
    pub reset_hold_seconds: u16,
    pub battery_low_mv: u16,
    pub battery_recovery_mv: u16,
    pub battery_calibration_ppm: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            led_enabled: false,
            tx_power_dbm: 0,
            advertising_interval_ms: 2000,
            gatt_interval_ms: 100,
            rotation_minutes: 15,
            gatt_advertising_seconds: 60,
            connection_seconds: 120,
            battery_idle_seconds: 900,
            battery_gatt_seconds: 5,
            reset_hold_seconds: 5,
            battery_low_mv: 2400,
            battery_recovery_mv: 2900,
            battery_calibration_ppm: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsError {
    Format,
    Checksum,
    Range,
}

impl Settings {
    pub fn validate(&self) -> Result<(), SettingsError> {
        if !matches!(
            self.tx_power_dbm,
            -40 | -20 | -16 | -12 | -8 | -4 | 0 | 3 | 4
        ) || !(100..=10240).contains(&self.advertising_interval_ms)
            || !(20..=2000).contains(&self.gatt_interval_ms)
            || self.rotation_minutes == 0
            || !(10..=3600).contains(&self.gatt_advertising_seconds)
            || !(10..=3600).contains(&self.connection_seconds)
            || !(10..=86400).contains(&self.battery_idle_seconds)
            || !(1..=600).contains(&self.battery_gatt_seconds)
            || !(2..=30).contains(&self.reset_hold_seconds)
            || !(1800..=4200).contains(&self.battery_low_mv)
            || !(1800..=4200).contains(&self.battery_recovery_mv)
            || self.battery_low_mv >= self.battery_recovery_mv
            || !(-100000..=100000).contains(&self.battery_calibration_ppm)
        {
            return Err(SettingsError::Range);
        }
        Ok(())
    }

    pub fn encode(&self) -> [u8; SETTINGS_WIRE_LEN] {
        let mut wire = [0; SETTINGS_WIRE_LEN];
        wire[0] = 1;
        wire[1] = u8::from(self.led_enabled);
        wire[2] = self.tx_power_dbm as u8;
        wire[4..8].copy_from_slice(&self.advertising_interval_ms.to_le_bytes());
        wire[8..12].copy_from_slice(&self.gatt_interval_ms.to_le_bytes());
        wire[12..16].copy_from_slice(&self.rotation_minutes.to_le_bytes());
        wire[16..18].copy_from_slice(&self.gatt_advertising_seconds.to_le_bytes());
        wire[18..20].copy_from_slice(&self.connection_seconds.to_le_bytes());
        wire[20..24].copy_from_slice(&self.battery_idle_seconds.to_le_bytes());
        wire[24..26].copy_from_slice(&self.battery_gatt_seconds.to_le_bytes());
        wire[26..28].copy_from_slice(&self.reset_hold_seconds.to_le_bytes());
        wire[28..30].copy_from_slice(&self.battery_low_mv.to_le_bytes());
        wire[30..32].copy_from_slice(&self.battery_recovery_mv.to_le_bytes());
        wire[32..36].copy_from_slice(&self.battery_calibration_ppm.to_le_bytes());
        let crc = crc32(&wire[..60]);
        wire[60..64].copy_from_slice(&crc.to_le_bytes());
        wire
    }

    pub fn decode(wire: &[u8; SETTINGS_WIRE_LEN]) -> Result<Self, SettingsError> {
        if wire[0] != 1
            || wire[1] & !1 != 0
            || wire[3] != 0
            || wire[36..60].iter().any(|value| *value != 0)
        {
            return Err(SettingsError::Format);
        }
        if u32_at(wire, 60) != crc32(&wire[..60]) {
            return Err(SettingsError::Checksum);
        }
        let value = Self {
            led_enabled: wire[1] & 1 != 0,
            tx_power_dbm: wire[2] as i8,
            advertising_interval_ms: u32_at(wire, 4),
            gatt_interval_ms: u32_at(wire, 8),
            rotation_minutes: u32_at(wire, 12),
            gatt_advertising_seconds: u16_at(wire, 16),
            connection_seconds: u16_at(wire, 18),
            battery_idle_seconds: u32_at(wire, 20),
            battery_gatt_seconds: u16_at(wire, 24),
            reset_hold_seconds: u16_at(wire, 26),
            battery_low_mv: u16_at(wire, 28),
            battery_recovery_mv: u16_at(wire, 30),
            battery_calibration_ppm: i32::from_le_bytes(wire[32..36].try_into().unwrap()),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn calibrated_battery_mv(&self, millivolts: u16) -> u16 {
        ((i64::from(millivolts) * (1000000 + i64::from(self.battery_calibration_ppm)) + 500000)
            / 1000000)
            .clamp(0, i64::from(u16::MAX)) as u16
    }
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_round_trips_and_detects_transport_corruption() {
        let settings = Settings::default();
        let mut wire = settings.encode();
        assert_eq!(Settings::decode(&wire), Ok(settings));
        wire[12] ^= 1;
        assert_eq!(Settings::decode(&wire), Err(SettingsError::Checksum));
    }
    #[test]
    fn rejects_inverted_hysteresis_and_unsupported_radio_power() {
        let mut settings = Settings::default();
        settings.battery_low_mv = settings.battery_recovery_mv;
        assert_eq!(settings.validate(), Err(SettingsError::Range));
        settings = Settings::default();
        settings.tx_power_dbm = 2;
        assert_eq!(settings.validate(), Err(SettingsError::Range));
        settings = Settings::default();
        settings.connection_seconds = 0;
        assert_eq!(settings.validate(), Err(SettingsError::Range));
    }
    #[test]
    fn calibration_preserves_units_and_rounds_to_millivolts() {
        let mut settings = Settings::default();
        settings.battery_calibration_ppm = 10000;
        assert_eq!(settings.calibrated_battery_mv(4000), 4040);
        settings.battery_calibration_ppm = -10000;
        assert_eq!(settings.calibrated_battery_mv(4000), 3960);
    }

    #[test]
    fn led_flag_round_trips_and_defaults_to_disabled() {
        let mut settings = Settings::default();
        assert_eq!(settings.encode()[1], 0);
        settings.led_enabled = true;
        let wire = settings.encode();
        assert_eq!(wire[1], 1);
        assert_eq!(Settings::decode(&wire), Ok(settings));
        let mut invalid = wire;
        invalid[1] = 2;
        assert_eq!(Settings::decode(&invalid), Err(SettingsError::Format));
    }
}
