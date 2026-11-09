//! Isolated macOS CoreADI emulator. The runtime and cache are machine-only.
mod machine;
mod protocol;
mod provisioning;
mod worker;

use super::local::{self, Headers};
use crate::{error::ApiError, hex, private_files};
use base64::{Engine, engine::general_purpose::STANDARD};
use machine::Identity;
use protocol::{Reply, Request};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use worker::Worker;

const LIBRARY: &str = "CoreADI.x86_64";
const LIBRARY_HASH: &str = "2eafc3c79c7f41a8afbfbeaaf23ee5dab5ad5bda55ec8e54dbc0ddf1d20ce630";

#[derive(Clone)]
pub(super) struct Provider {
    directory: PathBuf,
}

fn directory(data: &Path) -> PathBuf {
    data.join("anisette/mac-coreadi")
}

fn checked_library(path: &Path) -> Result<Vec<u8>, ApiError> {
    let bytes = private_files::read_bounded(path, protocol::LIBRARY_LIMIT)
        .map_err(|_| local::failure("缺少可读取的 macOS CoreADI 运行库文件。"))?;
    if hex(&Sha256::digest(&bytes)) != LIBRARY_HASH {
        return Err(local::failure("macOS CoreADI 运行库校验失败。"));
    }
    Ok(bytes)
}

pub(super) fn install(data: &Path, library: &Path, machine: Option<&Path>) -> Result<(), ApiError> {
    private_files::prepare_private_directory(data)?;
    let parent = data.join("anisette");
    private_files::prepare_private_directory(&parent)?;
    let target = directory(data);
    if target.symlink_metadata().is_ok() {
        return Err(ApiError::invalid(
            "已安装 macOS CoreADI；现有机器身份未修改。",
        ));
    }
    let stage = tempfile::Builder::new()
        .prefix("mac-coreadi-")
        .tempdir_in(&parent)?;
    private_files::protect(stage.path(), true)?;
    private_files::write_atomic(&stage.path().join(LIBRARY), &checked_library(library)?)?;
    if let Some(source) = machine {
        machine::import(source, &stage.path().join("machine"))?;
    }
    fs::rename(stage.path(), target)?;
    Ok(())
}

impl Provider {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            directory: directory(data),
        }
    }

    pub(super) async fn initialize(&self) -> Result<(), ApiError> {
        self.run(true, 85).await.map(|_| ())
    }

    pub(super) async fn headers(&self) -> Result<Headers, ApiError> {
        self.run(false, 25).await
    }

    async fn run(&self, initialize: bool, seconds: u64) -> Result<Headers, ApiError> {
        tokio::time::timeout(Duration::from_secs(seconds), self.generate(initialize))
            .await
            .map_err(|_| local::failure("macOS CoreADI 运行超时。"))?
    }

    async fn generate(&self, initialize: bool) -> Result<Headers, ApiError> {
        if !self.directory.is_dir() {
            return Err(local::failure(
                "尚未安装模拟 macOS CoreADI。请先运行 atag-agent anisette install-mac-coreadi，再运行 anisette init。",
            ));
        }
        private_files::protect(&self.directory, true)?;
        let directory = self.directory.canonicalize()?;
        let _lock = local::lock(&directory, false)?;
        let library = directory.join(LIBRARY);
        checked_library(&library)?;
        let machine = directory.join("machine");
        private_files::prepare_private_directory(&machine)?;
        let identity_path = machine.join("identity.json");
        let store_path = machine.join("store");
        let (mut identity, store) = match Identity::load(&identity_path)? {
            Some(identity) => (identity, machine::load_store(&store_path)?),
            // The identity is the commit marker for a newly registered machine.
            None if initialize => (Identity::new(), protocol::Store::new()),
            None => return Err(unprovisioned()),
        };
        let mut worker = Worker::spawn(&library)?;
        let Reply::Opened { provisioned } = worker
            .exchange(&Request::Open {
                host_uuid: identity.host_uuid()?,
                store,
            })
            .await?
        else {
            return Err(worker::failure());
        };
        let (reply, registered_routing) = if provisioned {
            (worker.exchange(&Request::Headers).await?, None)
        } else if initialize {
            let (reply, routing) = provisioning::run(&mut worker, &identity).await?;
            (reply, Some(routing))
        } else {
            return Err(unprovisioned());
        };
        let Reply::Headers {
            mid,
            otp,
            routing,
            store,
        } = reply
        else {
            return Err(worker::failure());
        };
        worker.finish().await?;
        machine::save_store(&store_path, store)?;
        if let Some(routing) = registered_routing {
            identity.save_registration(&identity_path, routing)?;
        }
        Ok(Headers::from([
            ("X-Apple-I-MD".into(), otp),
            ("X-Apple-I-MD-M".into(), mid),
            ("X-Apple-I-MD-RINFO".into(), routing.to_string()),
            (
                "X-Apple-I-MD-LU".into(),
                STANDARD.encode(&identity.local_user_uuid),
            ),
            ("X-Apple-I-SRL-NO".into(), identity.serial),
            ("X-Mme-Device-Id".into(), identity.device_id),
            ("X-Mme-Client-Info".into(), identity.client_info),
            (
                "User-Agent".into(),
                "akd/1.0 CFNetwork/1404.0.5 Darwin/22.2.0".into(),
            ),
        ]))
    }
}

fn unprovisioned() -> ApiError {
    local::failure("模拟 macOS CoreADI 尚未注册，请运行 atag-agent anisette init。")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_only_copies_machine_provisioning() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let dest = root.path().join("dest");
        fs::create_dir_all(source.join("store")).unwrap();
        fs::write(source.join("identity.json"), br#"{"device_id":"synthetic","local_user_uuid":"synthetic","client_info":"mac","host_uuid":"0123456789abcdef0123456789abcdef","serial":"0","routing":0,"provisioned_at":1}"#).unwrap();
        fs::write(source.join("store/adi-000001F5.pb"), b"synthetic-machine").unwrap();
        fs::write(source.join("store/account.json"), b"never copy").unwrap();
        machine::import(&source, &dest).unwrap();
        assert_eq!(
            fs::read(dest.join("store/adi-000001F5.pb")).unwrap(),
            b"synthetic-machine"
        );
        assert!(!dest.join("store/account.json").exists());
        assert!(dest.join("identity.json").is_file());
    }
}
