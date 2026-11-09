//! Battery conversion, hysteresis and the versioned GATT telemetry packet.

/// Voltage at or below which the low-voltage indication is set.
pub const OVERDISCHARGE_MV: u16 = 2400;
/// Voltage at or above which the low-voltage indication is cleared.
pub const RECOVERY_MV: u16 = 2900;
/// Size of the version-one GATT telemetry packet.
pub const TELEMETRY_LEN: usize = 40;

/// Averaged ADC results converted to physical voltages.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PowerReading {
    /// Battery terminal voltage, corrected for the 1 MOhm / 1.5 MOhm divider.
    pub battery_mv: u16,
    /// Chip supply voltage from the internal VDD channel.
    pub supply_mv: u16,
    /// Averaged raw battery sample.
    pub battery_raw: u16,
    /// Averaged raw supply sample.
    pub supply_raw: u16,
}

impl PowerReading {
    /// Converts summed 12-bit samples with 0.6 V reference and gain 1/6.
    /// AIN4 = VBAT * 3/5; the effective battery full scale is 6000 mV.
    pub fn from_sums(battery: u32, supply: u32, count: u32) -> Self {
        assert!(count != 0);
        let denominator = 4096 * count;
        Self {
            battery_mv: ((battery * 6000 + denominator / 2) / denominator) as u16,
            supply_mv: ((supply * 3600 + denominator / 2) / denominator) as u16,
            battery_raw: ((battery + count / 2) / count) as u16,
            supply_raw: ((supply + count / 2) / count) as u16,
        }
    }
}

/// Low-voltage indication with recovery hysteresis.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BatteryState {
    undervoltage: bool,
}

impl BatteryState {
    /// Updates the indication; it does not cut power or stop the radio.
    pub fn update(&mut self, battery_mv: u16) {
        self.update_with_thresholds(battery_mv, OVERDISCHARGE_MV, RECOVERY_MV);
    }
    pub fn update_with_thresholds(&mut self, battery_mv: u16, low_mv: u16, recovery_mv: u16) {
        if battery_mv <= low_mv {
            self.undervoltage = true;
        } else if battery_mv >= recovery_mv {
            self.undervoltage = false;
        }
    }
    /// Whether recovery voltage has not yet been reached after undervoltage.
    pub const fn undervoltage(&self) -> bool {
        self.undervoltage
    }
}

/// Non-secret device information available during the GATT window.
#[derive(Clone, Copy, Debug, Default)]
pub struct Telemetry {
    /// 0=unconfigured, 1=fixed, 2=rotating.
    pub mode: u8,
    /// 0=idle, 1=Offline Finding, 2=GATT advertising, 3=connected.
    pub phase: u8,
    /// Button, undervoltage, encryption, reset-pin, LFXO, DC/DC bits.
    pub flags: u8,
    /// Measured battery voltage.
    pub battery_mv: u16,
    /// Measured chip supply voltage.
    pub supply_mv: u16,
    /// Seconds since boot.
    pub uptime_seconds: u32,
    /// Current key round, or zero when not rotating.
    pub rotation: u32,
    /// Rotation interval in seconds.
    pub rotation_seconds: u32,
    /// POWER.RESETREAS captured at boot.
    pub reset_reason: u32,
    /// FICR.DEVICEID in little-endian word order.
    pub device_id: [u8; 8],
    /// Remaining GATT advertising time.
    pub advertising_seconds_left: u16,
    /// Remaining connection time.
    pub connection_seconds_left: u16,
}

impl Telemetry {
    /// Encodes the little-endian packet without seeds or private keys.
    pub fn encode(&self) -> [u8; TELEMETRY_LEN] {
        self.encode_with_thresholds(OVERDISCHARGE_MV, RECOVERY_MV)
    }
    pub fn encode_with_thresholds(&self, low_mv: u16, recovery_mv: u16) -> [u8; TELEMETRY_LEN] {
        let mut out = [0; TELEMETRY_LEN];
        out[0..4].copy_from_slice(&[1, self.mode, self.phase, self.flags]);
        out[4..6].copy_from_slice(&self.battery_mv.to_le_bytes());
        out[6..8].copy_from_slice(&self.supply_mv.to_le_bytes());
        out[8..12].copy_from_slice(&self.uptime_seconds.to_le_bytes());
        out[12..16].copy_from_slice(&self.rotation.to_le_bytes());
        out[16..20].copy_from_slice(&self.rotation_seconds.to_le_bytes());
        out[20..24].copy_from_slice(&self.reset_reason.to_le_bytes());
        out[24..32].copy_from_slice(&self.device_id);
        out[32..34].copy_from_slice(&self.advertising_seconds_left.to_le_bytes());
        out[34..36].copy_from_slice(&self.connection_seconds_left.to_le_bytes());
        out[36..38].copy_from_slice(&low_mv.to_le_bytes());
        out[38..40].copy_from_slice(&recovery_mv.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn divider_conversion_uses_five_thirds() {
        let reading = PowerReading::from_sums(2867 * 8, 3755 * 8, 8);
        assert_eq!(reading.battery_mv, 4200);
        assert_eq!(reading.supply_mv, 3300);
        assert_eq!(PowerReading::from_sums(1638, 0, 1).battery_mv, 2399);
    }
    #[test]
    fn low_voltage_latches_until_recovery() {
        let mut state = BatteryState::default();
        state.update(2401);
        assert!(!state.undervoltage());
        state.update(2400);
        assert!(state.undervoltage());
        state.update(2899);
        assert!(state.undervoltage());
        state.update(2900);
        assert!(!state.undervoltage());
    }
    #[test]
    fn packet_is_little_endian_and_includes_thresholds() {
        let out = Telemetry {
            battery_mv: 4200,
            rotation: 0x12345678,
            device_id: [1, 2, 3, 4, 5, 6, 7, 8],
            ..Default::default()
        }
        .encode();
        assert_eq!(out[0], 1);
        assert_eq!(&out[4..6], &4200_u16.to_le_bytes());
        assert_eq!(&out[12..16], &[0x78, 0x56, 0x34, 0x12]);
        assert_eq!(&out[24..32], &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(&out[36..40], &[0x60, 0x09, 0x54, 0x0b]);
    }
}
