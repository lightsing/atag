use super::{local, protocol};
use crate::{error::ApiError, hex, private_files};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{fs, io::ErrorKind, path::Path};

const CLIENT_INFO: &str =
    "<MacBookPro13,2> <macOS;13.1;22C65> <com.apple.AuthKit/1 (com.apple.akd/1.0)>";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub device_id: String,
    pub local_user_uuid: String,
    pub client_info: String,
    host_uuid: String,
    pub serial: String,
    routing: Option<u64>,
    provisioned_at: Option<f64>,
}

impl Identity {
    pub fn new() -> Self {
        let mut device_id = [0; 8];
        let mut local_user_uuid = [0; 16];
        let mut host_uuid = [0; 16];
        OsRng.fill_bytes(&mut device_id);
        OsRng.fill_bytes(&mut local_user_uuid);
        OsRng.fill_bytes(&mut host_uuid);
        let alphabet = b"0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
        let mut serial = String::from("C02");
        serial.extend(
            (0..9).map(|_| char::from(alphabet[OsRng.next_u32() as usize % alphabet.len()])),
        );
        Self {
            device_id: format!("00006000-{}", hex(&device_id).to_ascii_uppercase()),
            local_user_uuid: hex(&local_user_uuid).to_ascii_uppercase(),
            client_info: CLIENT_INFO.into(),
            host_uuid: hex(&host_uuid),
            serial,
            routing: None,
            provisioned_at: None,
        }
    }

    pub fn host_uuid(&self) -> Result<[u8; 16], ApiError> {
        let invalid = || ApiError::invalid("CoreADI 机器标识格式无效。");
        let mut uuid = [0; 16];
        if self.host_uuid.len() != uuid.len() * 2
            || !self.host_uuid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        for (i, byte) in uuid.iter_mut().enumerate() {
            let hex = self.host_uuid.get(i * 2..i * 2 + 2).ok_or_else(invalid)?;
            *byte = u8::from_str_radix(hex, 16).map_err(|_| invalid())?;
        }
        Ok(uuid)
    }

    pub fn load(path: &Path) -> Result<Option<Self>, ApiError> {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
            Ok(_) => {
                let bytes = private_files::read_bounded(path, protocol::BLOB_LIMIT as u64)?;
                let identity = Self::parse(&bytes)?;
                private_files::protect(path, false)?;
                Ok(Some(identity))
            }
        }
    }

    fn parse(bytes: &[u8]) -> Result<Self, ApiError> {
        let identity: Self = serde_json::from_slice(bytes)
            .map_err(|_| ApiError::invalid("CoreADI 机器标识格式无效。"))?;
        identity.host_uuid()?;
        Ok(identity)
    }

    pub fn save_registration(&mut self, path: &Path, routing: u64) -> Result<(), ApiError> {
        self.routing = Some(routing);
        self.provisioned_at = Some(chrono::Utc::now().timestamp_millis() as f64 / 1000.0);
        private_files::write_atomic(path, &serde_json::to_vec(self)?)
    }
}

pub(super) fn import(source: &Path, dest: &Path) -> Result<(), ApiError> {
    let identity =
        private_files::read_bounded(&source.join("identity.json"), protocol::BLOB_LIMIT as u64)?;
    Identity::parse(&identity)?;
    let store = dest.join("store");
    private_files::prepare_private_directory(&store)?;
    let mut found = false;
    for entry in fs::read_dir(source.join("store"))? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(protocol::provisioning_file)
        {
            let bytes = private_files::read_bounded(&entry.path(), protocol::BLOB_LIMIT as u64)?;
            private_files::write_atomic(&store.join(entry.file_name()), &bytes)?;
            found = true;
        }
    }
    if !found {
        return Err(ApiError::invalid("没有找到 CoreADI 机器注册材料。"));
    }
    private_files::write_atomic(&dest.join("identity.json"), &identity)
}

pub(super) fn load_store(directory: &Path) -> Result<protocol::Store, ApiError> {
    private_files::prepare_private_directory(directory)?;
    let mut store = protocol::Store::new();
    let mut size = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if !kind.is_file() {
            return Err(local::failure("CoreADI 机器缓存格式无效。"));
        }
        let name = entry.file_name();
        if let Some(name) = name
            .to_str()
            .filter(|name| *name != "adi.pb" && protocol::store_file(name))
        {
            let bytes = private_files::read_bounded(&entry.path(), protocol::BLOB_LIMIT as u64)?;
            let encoded = STANDARD.encode(bytes);
            size += name.len() + encoded.len() + 6;
            if size as u64 > protocol::FRAME_LIMIT - 1024 {
                return Err(local::failure("CoreADI 机器缓存过大。"));
            }
            store.insert(name.into(), encoded);
        }
    }
    Ok(store)
}

pub(super) fn save_store(directory: &Path, store: protocol::Store) -> Result<(), ApiError> {
    let invalid = || local::failure("CoreADI 机器缓存格式无效。");
    let mut files = Vec::new();
    for (name, encoded) in store {
        if !protocol::store_file(&name) {
            return Err(invalid());
        }
        files.push((name, protocol::decode_blob(&encoded).ok_or_else(invalid)?));
    }
    if !files
        .iter()
        .any(|(name, bytes)| protocol::provisioning_file(name) && !bytes.is_empty())
    {
        return Err(invalid());
    }
    private_files::prepare_private_directory(directory)?;
    // Stage auxiliary files before replacing the per-user provisioning blob.
    files.sort_by_key(|(name, _)| protocol::provisioning_file(name));
    for (name, bytes) in files {
        private_files::write_atomic(&directory.join(name), &bytes)?;
    }
    Ok(())
}
