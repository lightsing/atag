use crate::AdvertisementKey;

/// Length of a BLE device address.
pub const RANDOM_STATIC_ADDRESS_LEN: usize = 6;

/// Length of a complete legacy BLE advertising-data buffer.
pub const ADVERTISING_DATA_LEN: usize = 31;

/// Apple's Bluetooth SIG company identifier, in little-endian wire order.
pub const APPLE_COMPANY_ID: [u8; 2] = [0x4c, 0x00];

/// Highest voltage represented by the six-bit status encoding.
pub const VOLTAGE_STATUS_MAX_MILLIVOLTS: u16 = 4_200;

/// Lowest voltage represented by the six-bit battery encoding.
pub const VOLTAGE_STATUS_MIN_MILLIVOLTS: u16 = 2_400;

const VOLTAGE_STATUS_MAX_CODE: u16 = 0x3f;

/// Encodes a supply voltage into the Offline Finding status byte.
///
/// The descending six-bit voltage code is split across status bits 7..6 and
/// 3..0, leaving the device-type field in bits 5..4 as zero. Code zero means
/// 4.200 V or higher; code 63 means 2.400 V or lower. The upper two bits
/// therefore continue to form four monotonically decreasing coarse battery
/// bands; each step is approximately 28.6 mV.
pub const fn encode_voltage_status(millivolts: u16) -> u8 {
    let code = if millivolts >= VOLTAGE_STATUS_MAX_MILLIVOLTS {
        0
    } else {
        if millivolts <= VOLTAGE_STATUS_MIN_MILLIVOLTS {
            VOLTAGE_STATUS_MAX_CODE as u32
        } else {
            let span = (VOLTAGE_STATUS_MAX_MILLIVOLTS - VOLTAGE_STATUS_MIN_MILLIVOLTS) as u32;
            let difference = (VOLTAGE_STATUS_MAX_MILLIVOLTS - millivolts) as u32;
            (difference * VOLTAGE_STATUS_MAX_CODE as u32 + span / 2) / span
        }
    } as u8;

    ((code & 0x30) << 2) | (code & 0x0f)
}

/// Decodes the six-bit voltage carried in an Offline Finding status byte.
///
/// Bits 5..4 are deliberately ignored because they are the device-type field.
pub const fn decode_voltage_status(status: u8) -> u16 {
    let code = (((status >> 2) & 0x30) | (status & 0x0f)) as u16;
    let span = (VOLTAGE_STATUS_MAX_MILLIVOLTS - VOLTAGE_STATUS_MIN_MILLIVOLTS) as u32;
    VOLTAGE_STATUS_MAX_MILLIVOLTS
        - ((code as u32 * span + VOLTAGE_STATUS_MAX_CODE as u32 / 2)
            / VOLTAGE_STATUS_MAX_CODE as u32) as u16
}

/// Complete radio inputs for an Offline Finding BLE advertisement.
///
/// The address is written in protocol byte order, matching the order used by
/// OpenHaystack's ESP32 implementation. A controller API which represents BLE
/// addresses least-significant byte first may require reversing it at the
/// driver boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BleAdvertisement {
    random_static_address: [u8; RANDOM_STATIC_ADDRESS_LEN],
    advertising_data: [u8; ADVERTISING_DATA_LEN],
}

impl BleAdvertisement {
    /// Builds a complete Offline Finding advertisement.
    ///
    /// `status` is the one-byte Offline Finding state and `hint` is the final
    /// protocol hint byte. Both are normally zero for the separated state used
    /// by simple OpenHaystack-compatible tags.
    pub fn new(key: AdvertisementKey, status: u8, hint: u8) -> Self {
        let key = key.as_bytes();

        let mut address = [0_u8; RANDOM_STATIC_ADDRESS_LEN];
        address.copy_from_slice(&key[..RANDOM_STATIC_ADDRESS_LEN]);
        // The two most significant address bits mark a random-static address.
        address[0] |= 0xc0;

        let mut data = [0_u8; ADVERTISING_DATA_LEN];
        data[0] = 0x1e; // 30 bytes follow this AD-structure length byte.
        data[1] = 0xff; // Manufacturer Specific Data.
        data[2..4].copy_from_slice(&APPLE_COMPANY_ID);
        data[4] = 0x12; // Offline Finding type.
        data[5] = 0x19; // Offline Finding payload length.
        data[6] = status;
        data[7..29].copy_from_slice(&key[6..]);
        // Preserve the key bits replaced by the random-static address marker.
        data[29] = key[0] >> 6;
        data[30] = hint;

        Self {
            random_static_address: address,
            advertising_data: data,
        }
    }

    /// Builds the usual separated-state advertisement (`status = hint = 0`).
    pub fn separated(key: AdvertisementKey) -> Self {
        Self::new(key, 0, 0)
    }

    /// Returns the six-byte random-static BLE address.
    pub const fn random_static_address(&self) -> &[u8; RANDOM_STATIC_ADDRESS_LEN] {
        &self.random_static_address
    }

    /// Returns the complete 31-byte legacy BLE advertising-data buffer.
    ///
    /// This includes the AD-structure length and type bytes. Pass this to radio
    /// APIs which accept raw advertising data.
    pub const fn advertising_data(&self) -> &[u8; ADVERTISING_DATA_LEN] {
        &self.advertising_data
    }

    /// Returns the 29-byte manufacturer-specific portion, starting with the
    /// Apple company identifier and excluding the AD length/type bytes.
    pub fn manufacturer_data(&self) -> &[u8] {
        &self.advertising_data[2..]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_key_across_address_and_payload() {
        let key = AdvertisementKey::from_bytes([
            0x33, 0x5f, 0x9a, 0xaa, 0x89, 0x6b, 0x3a, 0x0c, 0xa8, 0x67, 0xff, 0xfb, 0x91, 0xcb,
            0x62, 0x65, 0x2f, 0x23, 0x25, 0x59, 0xc8, 0x14, 0x1f, 0x13, 0x82, 0xd9, 0x91, 0x2a,
        ]);
        let packet = BleAdvertisement::separated(key);

        assert_eq!(
            packet.random_static_address(),
            &[0xf3, 0x5f, 0x9a, 0xaa, 0x89, 0x6b]
        );
        assert_eq!(
            packet.advertising_data(),
            &[
                0x1e, 0xff, 0x4c, 0x00, 0x12, 0x19, 0x00, 0x3a, 0x0c, 0xa8, 0x67, 0xff, 0xfb, 0x91,
                0xcb, 0x62, 0x65, 0x2f, 0x23, 0x25, 0x59, 0xc8, 0x14, 0x1f, 0x13, 0x82, 0xd9, 0x91,
                0x2a, 0x00, 0x00,
            ]
        );
        assert_eq!(packet.manufacturer_data().len(), 29);
    }

    #[test]
    fn carries_status_and_hint() {
        let packet = BleAdvertisement::new(AdvertisementKey::from_bytes([0; 28]), 0x12, 0x34);
        assert_eq!(packet.advertising_data()[6], 0x12);
        assert_eq!(packet.advertising_data()[30], 0x34);
    }

    #[test]
    fn voltage_status_uses_high_two_and_low_four_bits() {
        let cases = [
            (4_300, 0x00, 4_200),
            (4_200, 0x00, 4_200),
            (4_171, 0x01, 4_171),
            (3_743, 0x40, 3_743),
            (3_286, 0x80, 3_286),
            (2_829, 0xc0, 2_829),
            (2_400, 0xcf, 2_400),
            (2_000, 0xcf, 2_400),
        ];

        for (millivolts, status, decoded) in cases {
            assert_eq!(encode_voltage_status(millivolts), status);
            assert_eq!(decode_voltage_status(status), decoded);
            assert_eq!(status & 0x30, 0, "device-type bits must remain clear");
        }
    }

    #[test]
    fn every_code_round_trips_and_ignores_device_type() {
        for code in 0_u8..64 {
            let status = ((code & 0x30) << 2) | (code & 0x0f);
            assert_eq!(encode_voltage_status(decode_voltage_status(status)), status);
            assert_eq!(
                decode_voltage_status(status | 0x30),
                decode_voltage_status(status)
            );
        }
    }
}
