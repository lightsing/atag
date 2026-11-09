pub mod anisette;
pub mod bridge;
pub mod cli_support;
pub mod error;
pub mod private_files;
pub mod relay;
pub mod server;

use chrono::{SecondsFormat, Utc};
use std::path::PathBuf;

fn default_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|directory| directory.join("atag-agent"))
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
