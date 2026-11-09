#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

//! Hardware-oriented helpers for Find My / AirTag-compatible advertisements.
//!
//! The crate implements the reverse-engineered Offline Finding rolling-key
//! derivation used by OpenHaystack and the corresponding 31-byte legacy BLE
//! advertising data. It is allocation-free and does not require the master
//! private key on the device.
//!
//! A device stores a SEC1-encoded P-224 master public key, a 32-byte symmetric
//! seed, and a rotation counter. Each call to
//! [`RollingKeyGenerator::advance`] advances the seed and derives the next
//! 28-byte advertisement key. [`BleAdvertisement`] then splits that key across
//! a random-static BLE address and the Offline Finding manufacturer data.

mod broadcast;
mod provisioning;
mod rolling;

pub use broadcast::{
    ADVERTISING_DATA_LEN, APPLE_COMPANY_ID, BleAdvertisement, RANDOM_STATIC_ADDRESS_LEN,
    VOLTAGE_STATUS_MAX_MILLIVOLTS, VOLTAGE_STATUS_MIN_MILLIVOLTS, decode_voltage_status,
    encode_voltage_status,
};
pub use provisioning::{
    PROVISIONING_WIRE_LEN, ProvisioningConfig, ProvisioningError, ProvisioningMode,
};
pub use rolling::{
    ADVERTISEMENT_KEY_LEN, AdvertisementKey, Checkpoint, Error, MASTER_PUBLIC_KEY_UNCOMPRESSED_LEN,
    PrivateRotation, ReportPrivateKey, RollingKeyGenerator, RollingPrivateKeyGenerator, Rotation,
    SYMMETRIC_KEY_LEN,
};
