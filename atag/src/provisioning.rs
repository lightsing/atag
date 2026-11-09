//! Versioned wire format shared by the GATT provisioner and firmware.

use p224::PublicKey;

use crate::{
    AdvertisementKey, MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN, RollingKeyGenerator, SYMMETRIC_KEY_LEN,
};

const MAGIC: [u8; 4] = *b"ATAG";
const VERSION: u8 = 1;
const MODE_OFFSET: usize = 5;
const INTERVAL_OFFSET: usize = 6;
const PAYLOAD_OFFSET: usize = 10;
const CRC_OFFSET: usize = 100;

/// Exact size of one configuration GATT write.
pub const PROVISIONING_WIRE_LEN: usize = 104;

/// Supported post-provisioning advertising modes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum ProvisioningMode {
    /// Advertise one P-224 x-coordinate until the device is reset.
    Fixed = 1,
    /// Derive and advertise a sequence of Offline Finding keys.
    Rotating = 2,
}

/// A validated configuration accepted by the device.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvisioningConfig {
    /// A fixed OpenHaystack advertisement key.
    Fixed {
        /// The 28-byte P-224 x-coordinate placed in the BLE address/payload.
        advertisement_key: AdvertisementKey,
    },
    /// A public-only rolling-key configuration.
    Rotating {
        /// Uncompressed SEC1 P-224 point (`04 || X || Y`).
        master_public_key: [u8; MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN],
        /// Initial Offline Finding symmetric key (`SKN_0`).
        symmetric_seed: [u8; SYMMETRIC_KEY_LEN],
        /// Rotation period in minutes.
        rotation_interval_minutes: u32,
    },
}

/// Validation failures for provisioning input.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProvisioningError {
    /// The `ATAG` prefix is absent.
    BadMagic,
    /// The payload version is not supported.
    UnsupportedVersion,
    /// The advertising mode is not supported.
    UnsupportedMode,
    /// The CRC32 does not match the payload.
    BadChecksum,
    /// The fixed x-coordinate is not on P-224.
    InvalidFixedKey,
    /// The rolling master public key is invalid.
    InvalidMasterPublicKey,
    /// The rolling interval is zero.
    InvalidRotationInterval,
    /// A reserved byte is nonzero.
    NonzeroReservedBytes,
}

impl ProvisioningConfig {
    /// Returns the configured advertising mode.
    pub const fn mode(&self) -> ProvisioningMode {
        match self {
            Self::Fixed { .. } => ProvisioningMode::Fixed,
            Self::Rotating { .. } => ProvisioningMode::Rotating,
        }
    }

    /// Encodes the exact, versioned GATT payload, including CRC32.
    pub fn encode(self) -> [u8; PROVISIONING_WIRE_LEN] {
        let mut wire = [0_u8; PROVISIONING_WIRE_LEN];
        wire[..4].copy_from_slice(&MAGIC);
        wire[4] = VERSION;

        match self {
            Self::Fixed { advertisement_key } => {
                wire[MODE_OFFSET] = ProvisioningMode::Fixed as u8;
                wire[PAYLOAD_OFFSET..PAYLOAD_OFFSET + 28]
                    .copy_from_slice(advertisement_key.as_bytes());
            }
            Self::Rotating {
                master_public_key,
                symmetric_seed,
                rotation_interval_minutes,
            } => {
                wire[MODE_OFFSET] = ProvisioningMode::Rotating as u8;
                wire[INTERVAL_OFFSET..PAYLOAD_OFFSET]
                    .copy_from_slice(&rotation_interval_minutes.to_le_bytes());
                wire[PAYLOAD_OFFSET..PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN]
                    .copy_from_slice(&master_public_key);
                wire[PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN
                    ..PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN + SYMMETRIC_KEY_LEN]
                    .copy_from_slice(&symmetric_seed);
            }
        }

        let checksum = crc32(&wire[..CRC_OFFSET]);
        wire[CRC_OFFSET..].copy_from_slice(&checksum.to_le_bytes());
        wire
    }

    /// Validates and decodes one exact GATT payload.
    pub fn decode(wire: &[u8; PROVISIONING_WIRE_LEN]) -> Result<Self, ProvisioningError> {
        if wire[..4] != MAGIC {
            return Err(ProvisioningError::BadMagic);
        }
        if wire[4] != VERSION {
            return Err(ProvisioningError::UnsupportedVersion);
        }

        let expected = u32::from_le_bytes(wire[CRC_OFFSET..].try_into().unwrap());
        if crc32(&wire[..CRC_OFFSET]) != expected {
            return Err(ProvisioningError::BadChecksum);
        }

        match wire[MODE_OFFSET] {
            value if value == ProvisioningMode::Fixed as u8 => {
                if wire[INTERVAL_OFFSET..PAYLOAD_OFFSET] != [0; 4]
                    || wire[PAYLOAD_OFFSET + 28..CRC_OFFSET]
                        .iter()
                        .any(|byte| *byte != 0)
                {
                    return Err(ProvisioningError::NonzeroReservedBytes);
                }

                let mut bytes = [0_u8; 28];
                bytes.copy_from_slice(&wire[PAYLOAD_OFFSET..PAYLOAD_OFFSET + 28]);
                // Offline Finding transports x only. Checking either compressed
                // parity proves x belongs to a valid non-identity P-224 point.
                let mut compressed = [0_u8; 29];
                compressed[0] = 0x02;
                compressed[1..].copy_from_slice(&bytes);
                if PublicKey::from_sec1_bytes(&compressed).is_err() {
                    return Err(ProvisioningError::InvalidFixedKey);
                }

                Ok(Self::Fixed {
                    advertisement_key: AdvertisementKey::from_bytes(bytes),
                })
            }
            value if value == ProvisioningMode::Rotating as u8 => {
                if wire[CRC_OFFSET - 1] != 0 {
                    return Err(ProvisioningError::NonzeroReservedBytes);
                }
                let rotation_interval_minutes =
                    u32::from_le_bytes(wire[INTERVAL_OFFSET..PAYLOAD_OFFSET].try_into().unwrap());
                if rotation_interval_minutes == 0 {
                    return Err(ProvisioningError::InvalidRotationInterval);
                }

                let mut master_public_key = [0_u8; MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN];
                master_public_key.copy_from_slice(
                    &wire[PAYLOAD_OFFSET..PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN],
                );
                let mut symmetric_seed = [0_u8; SYMMETRIC_KEY_LEN];
                symmetric_seed.copy_from_slice(
                    &wire[PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN
                        ..PAYLOAD_OFFSET + MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN + SYMMETRIC_KEY_LEN],
                );
                if RollingKeyGenerator::new(&master_public_key, symmetric_seed).is_err() {
                    return Err(ProvisioningError::InvalidMasterPublicKey);
                }

                Ok(Self::Rotating {
                    master_public_key,
                    symmetric_seed,
                    rotation_interval_minutes,
                })
            }
            _ => Err(ProvisioningError::UnsupportedMode),
        }
    }

    /// Stable, non-secret identity used to reject checkpoints from old configs.
    pub fn provisioning_id(self) -> u32 {
        let wire = self.encode();
        crc32(&wire[..CRC_OFFSET])
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATOR_UNCOMPRESSED: [u8; MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN] = [
        0x04, 0xb7, 0x0e, 0x0c, 0xbd, 0x6b, 0xb4, 0xbf, 0x7f, 0x32, 0x13, 0x90, 0xb9, 0x4a, 0x03,
        0xc1, 0xd3, 0x56, 0xc2, 0x11, 0x22, 0x34, 0x32, 0x80, 0xd6, 0x11, 0x5c, 0x1d, 0x21, 0xbd,
        0x37, 0x63, 0x88, 0xb5, 0xf7, 0x23, 0xfb, 0x4c, 0x22, 0xdf, 0xe6, 0xcd, 0x43, 0x75, 0xa0,
        0x5a, 0x07, 0x47, 0x64, 0x44, 0xd5, 0x81, 0x99, 0x85, 0x00, 0x7e, 0x34,
    ];

    #[test]
    fn fixed_round_trip() {
        let mut x = [0; 28];
        x.copy_from_slice(&GENERATOR_UNCOMPRESSED[1..29]);
        let config = ProvisioningConfig::Fixed {
            advertisement_key: AdvertisementKey::from_bytes(x),
        };
        assert_eq!(ProvisioningConfig::decode(&config.encode()), Ok(config));
    }

    #[test]
    fn rotating_round_trip() {
        let config = ProvisioningConfig::Rotating {
            master_public_key: GENERATOR_UNCOMPRESSED,
            symmetric_seed: [0x42; 32],
            rotation_interval_minutes: 15,
        };
        assert_eq!(ProvisioningConfig::decode(&config.encode()), Ok(config));
    }

    #[test]
    fn corruption_is_rejected() {
        let config = ProvisioningConfig::Rotating {
            master_public_key: GENERATOR_UNCOMPRESSED,
            symmetric_seed: [0x42; 32],
            rotation_interval_minutes: 15,
        };
        let mut wire = config.encode();
        wire[25] ^= 1;
        assert_eq!(
            ProvisioningConfig::decode(&wire),
            Err(ProvisioningError::BadChecksum)
        );
    }
}
