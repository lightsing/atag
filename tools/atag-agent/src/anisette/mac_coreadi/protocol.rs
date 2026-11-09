//! Private newline-delimited JSON exchanged with the emulator process.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const LIBRARY_LIMIT: u64 = 4 * 1024 * 1024;
pub(super) const BLOB_LIMIT: usize = 64 * 1024;
pub(super) const FRAME_LIMIT: u64 = 1024 * 1024;

pub(super) type Store = BTreeMap<String, String>;

#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Request {
    Open {
        host_uuid: [u8; 16],
        store: Store,
    },
    Headers,
    Provision {
        spim: String,
    },
    Finish {
        ptm: String,
        tk: String,
        routing: u64,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Reply {
    Opened {
        provisioned: bool,
    },
    Started {
        cpim: String,
    },
    Headers {
        mid: String,
        otp: String,
        routing: u64,
        store: Store,
    },
    Error,
}

pub(super) fn provisioning_file(name: &str) -> bool {
    name.strip_prefix("adi-")
        .and_then(|name| name.strip_suffix(".pb"))
        .is_some_and(|id| id.len() == 8 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(super) fn store_file(name: &str) -> bool {
    matches!(name, "adi.pb" | "adi.pb.lck" | "adi-gb.lck")
        || provisioning_file(name.strip_suffix(".lck").unwrap_or(name))
}

pub(super) fn decode_blob(encoded: &str) -> Option<Vec<u8>> {
    if encoded.len() > BLOB_LIMIT.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(encoded).ok()?;
    (bytes.len() <= BLOB_LIMIT).then_some(bytes)
}
