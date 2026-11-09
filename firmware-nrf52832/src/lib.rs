#![no_std]
#![forbid(unsafe_code)]

//! Shared, host-testable support for the nRF52832 firmware.

pub mod device_name;
pub mod journal;
pub mod led;
pub mod ota;
pub mod provisioning_store;
pub mod settings;
pub mod telemetry;
