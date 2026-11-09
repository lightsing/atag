//! Isolated macOS CoreADI emulator. The runtime and cache are machine-only.
use super::local::{self, Headers};
use crate::{error::ApiError, hex, private_files};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

const LIBRARY: &str = "CoreADI.x86_64";
const LIBRARY_HASH: &str = "2eafc3c79c7f41a8afbfbeaaf23ee5dab5ad5bda55ec8e54dbc0ddf1d20ce630";
// os-findmy-e commit d4d2a832baf47d1cf43d989879950ac2aec45f47. Installed
// locally from the upstream checkout; never bundled into an agent release.
const MODULES: &[(&str, &str)] = &[
    (
        "adi_run.py",
        "eb5b7ec35cd488508d1b6927d23da55d551fb385c1b17fb74c5bea0a001760ae",
    ),
    (
        "gsa.py",
        "2e89ab44263376487d79b3cc3d9b70d59a7f9dd55f3d2ef9078732ea9479fc21",
    ),
    (
        "harness.py",
        "2df372afa7f67a19135bf2c744a6ce9f3d5bb7a53a9a32d870bd8566c7c8e139",
    ),
    (
        "mac_anisette.py",
        "d3af1814aaa8dfb63c1033d8e327aecf32a7cb5ab220b8538c9f9001fe0ca94e",
    ),
    (
        "macho.py",
        "6775e284e904debbae59234cb8d0732df5c199f7aaa9c285767d1f3bea09b6d4",
    ),
    (
        "stubs.py",
        "be2ef85170b2dfa2fc23514d487dedada0d9d1f60aeefdebec8fe318a892f24c",
    ),
];
const LIMIT: u64 = 64 * 1024;
const ROOT_CERT: &[u8] = include_bytes!("AppleIncRootCertificate.cer");

#[derive(Clone)]
pub(super) struct Provider {
    directory: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    python: PathBuf,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum Reply {
    Ok { headers: Headers },
    Error { message: String },
}

fn directory(data: &Path) -> PathBuf {
    data.join("anisette/mac-coreadi")
}

fn checked(path: &Path, limit: u64, hash: &str) -> Result<Vec<u8>, ApiError> {
    let bytes = private_files::read_bounded(path, limit)
        .map_err(|_| local::failure("缺少可读取的 macOS CoreADI 运行库文件。"))?;
    if hex(&Sha256::digest(&bytes)) != hash {
        return Err(local::failure("macOS CoreADI 运行库校验失败。"));
    }
    Ok(bytes)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    fs::write(path, bytes)?;
    private_files::protect(path, false)
}

fn store_name(name: &str) -> bool {
    name.strip_prefix("adi-")
        .and_then(|s| s.strip_suffix(".pb"))
        .is_some_and(|id| id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn import_machine(source: &Path, dest: &Path) -> Result<(), ApiError> {
    let identity = private_files::read_bounded(&source.join("identity.json"), LIMIT)?;
    let data: serde_json::Value = serde_json::from_slice(&identity)
        .map_err(|_| ApiError::invalid("CoreADI 机器标识格式无效。"))?;
    let keys = [
        "device_id",
        "local_user_uuid",
        "client_info",
        "host_uuid",
        "serial",
        "routing",
        "provisioned_at",
    ];
    if !data.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    }) {
        return Err(ApiError::invalid("CoreADI 机器标识格式无效。"));
    }
    let store = dest.join("store");
    private_files::prepare_private_directory(&store)?;
    let mut found = false;
    for entry in fs::read_dir(source.join("store"))? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_str().is_some_and(store_name) {
            let bytes = private_files::read_bounded(&entry.path(), LIMIT)?;
            write_private(&store.join(name), &bytes)?;
            found = true;
        }
    }
    if !found {
        return Err(ApiError::invalid("没有找到 CoreADI 机器注册材料。"));
    }
    write_private(&dest.join("identity.json"), &identity)
}

pub(super) fn install(
    data: &Path,
    python: &Path,
    emulator: &Path,
    library: &Path,
    machine: Option<&Path>,
) -> Result<(), ApiError> {
    // Keep the venv executable path: canonicalizing a symlink would lose the venv.
    let python = std::path::absolute(python)?;
    if !python.is_file() {
        return Err(ApiError::invalid(
            "请指定安装了 Unicorn 的 Python 可执行文件。",
        ));
    }
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
    let modules = stage.path().join("emulator");
    private_files::prepare_private_directory(&modules)?;
    for (name, hash) in MODULES {
        write_private(
            &modules.join(name),
            &checked(&emulator.join(name), 256 * 1024, hash)?,
        )?;
    }
    write_private(
        &stage.path().join(LIBRARY),
        &checked(library, 4 * 1024 * 1024, LIBRARY_HASH)?,
    )?;
    write_private(&stage.path().join("apple-root.cer"), ROOT_CERT)?;
    let state = stage.path().join("machine");
    private_files::prepare_private_directory(&state)?;
    if let Some(source) = machine {
        import_machine(source, &state)?;
    }
    write_private(
        &stage.path().join("runtime.json"),
        &serde_json::to_vec(&Runtime { python })?,
    )?;
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
        self.run("prepare", 85).await.map(|_| ())
    }

    pub(super) async fn headers(&self) -> Result<Headers, ApiError> {
        self.run("headers", 25).await
    }

    async fn run(&self, action: &str, seconds: u64) -> Result<Headers, ApiError> {
        if !self.directory.is_dir() {
            return Err(local::failure(
                "尚未安装模拟 macOS CoreADI。请先运行 atag-agent anisette install-mac-coreadi，再运行 anisette init。",
            ));
        }
        private_files::protect(&self.directory, true)?;
        let directory = self.directory.canonicalize()?;
        let _lock = local::lock(&directory, false)?;
        let runtime: Runtime = serde_json::from_slice(&private_files::read_bounded(
            &directory.join("runtime.json"),
            LIMIT,
        )?)
        .map_err(|_| local::failure("macOS CoreADI 运行配置无效。"))?;
        if !runtime.python.is_absolute() || !runtime.python.is_file() {
            return Err(local::failure("找不到模拟 macOS CoreADI 所用的 Python。"));
        }
        let modules = directory.join("emulator");
        private_files::protect(&modules, true)?;
        if fs::read_dir(&modules)?.count() != MODULES.len() {
            return Err(local::failure("macOS CoreADI 模拟器目录包含非预期文件。"));
        }
        for (name, hash) in MODULES {
            checked(&modules.join(name), 256 * 1024, hash)?;
        }
        checked(&directory.join(LIBRARY), 4 * 1024 * 1024, LIBRARY_HASH)?;
        if private_files::read_bounded(&directory.join("apple-root.cer"), LIMIT)? != ROOT_CERT {
            return Err(local::failure("macOS CoreADI 的 Apple 根证书校验失败。"));
        }
        private_files::prepare_private_directory(&directory.join("machine"))?;
        let mut command = tokio::process::Command::new(runtime.python);
        command
            .args(["-I", "-B", "-c", include_str!("mac_coreadi_worker.py")])
            .arg(&directory)
            .arg(action)
            .current_dir(&directory)
            .env_clear()
            .env("LANG", "en_US.UTF-8")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SYSTEMROOT") {
            command.env("SYSTEMROOT", root);
        }
        let mut child = command
            .spawn()
            .map_err(|_| local::failure("无法启动 macOS CoreADI Python 模拟器。"))?;
        tokio::time::timeout(Duration::from_secs(seconds), async {
            let mut output = Vec::new();
            child
                .stdout
                .take()
                .ok_or_else(ApiError::internal)?
                .take(LIMIT + 1)
                .read_to_end(&mut output)
                .await?;
            if output.len() as u64 > LIMIT {
                return Err(local::failure("macOS CoreADI 响应过大。"));
            }
            if !child.wait().await?.success() {
                return Err(local::failure(
                    "macOS CoreADI 模拟器退出；请检查 Python 和 Unicorn。",
                ));
            }
            match serde_json::from_slice::<Reply>(&output)
                .map_err(|_| local::failure("macOS CoreADI 响应无效。"))?
            {
                Reply::Ok { headers } => Ok(headers),
                Reply::Error { message }
                    if message.len() <= 512 && !message.chars().any(char::is_control) =>
                {
                    Err(local::failure(&message))
                }
                Reply::Error { .. } => Err(local::failure("macOS CoreADI 模拟失败。")),
            }
        })
        .await
        .map_err(|_| local::failure("macOS CoreADI 运行超时。"))?
    }
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
        fs::write(source.join("identity.json"), br#"{"device_id":"synthetic","local_user_uuid":"synthetic","client_info":"mac","host_uuid":"synthetic","serial":"0","routing":0,"provisioned_at":1}"#).unwrap();
        fs::write(source.join("store/adi-000001F5.pb"), b"synthetic-machine").unwrap();
        fs::write(source.join("store/account.json"), b"never copy").unwrap();
        import_machine(&source, &dest).unwrap();
        assert_eq!(
            fs::read(dest.join("store/adi-000001F5.pb")).unwrap(),
            b"synthetic-machine"
        );
        assert!(!dest.join("store/account.json").exists());
        assert!(dest.join("identity.json").is_file());
    }
}
