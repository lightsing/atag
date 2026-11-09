//! Local device authentication runs in a disposable process, without account secrets.
use crate::{
    error::ApiError,
    private_files::{prepare_private_directory, protect},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;

#[cfg(all(windows, target_arch = "x86_64"))]
macro_rules! adi_type { ($($signature:tt)*) => { unsafe extern "sysv64" $($signature)* }; }
#[cfg(not(all(windows, target_arch = "x86_64")))]
macro_rules! adi_type { ($($signature:tt)*) => { unsafe extern "C" $($signature)* }; }
macro_rules! adi_fn {
    (fn $name:ident($($arg:ident:$typ:ty),*$(,)?) -> $ret:ty $body:block) => {
        #[cfg(all(windows, target_arch = "x86_64"))]
        unsafe extern "sysv64" fn $name($($arg:$typ),*) -> $ret $body
        #[cfg(not(all(windows, target_arch = "x86_64")))]
        unsafe extern "C" fn $name($($arg:$typ),*) -> $ret $body
    };
}
#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
mod elf;
#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
mod libraries;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
mod portable;
#[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
mod shim;

pub type Headers = BTreeMap<String, String>;
pub(crate) const LOCAL_WORKER_COMMAND: &str = "__anisette";
pub(crate) const WORKER_TIMEOUT: Duration = Duration::from_secs(240);
#[derive(Clone)]
pub struct LocalProvider {
    directory: PathBuf,
    portable: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum Reply {
    Ok { headers: Headers },
    Error { message: String },
}

impl LocalProvider {
    pub fn new(directory: &Path, portable: bool) -> Self {
        Self {
            directory: directory.to_owned(),
            portable,
        }
    }
    pub async fn headers(&self) -> Result<Headers, ApiError> {
        prepare_private_directory(&self.directory)?;
        let directory = self.directory.canonicalize()?;
        let mut child = tokio::process::Command::new(std::env::current_exe()?)
            .arg("--data-dir")
            .arg(directory)
            .arg(LOCAL_WORKER_COMMAND)
            .arg(if self.portable { "portable" } else { "local" })
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let result = tokio::time::timeout(WORKER_TIMEOUT, async {
            let mut bytes = Vec::new();
            child
                .stdout
                .take()
                .ok_or_else(ApiError::internal)?
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > 64 * 1024 {
                return Err(failure("本地 Anisette 返回的数据过大。"));
            }
            let status = child.wait().await?;
            if !status.success() {
                return Err(failure(
                    "本地 Anisette 运行库退出；请运行 anisette init 检查此平台的支持情况。",
                ));
            }
            match serde_json::from_slice::<Reply>(&bytes)
                .map_err(|_| failure("本地 Anisette 响应无效。"))?
            {
                Reply::Ok { headers } => Ok(headers),
                Reply::Error { message } => Err(failure(&message)),
            }
        })
        .await
        .map_err(|_| ApiError::timeout_for("本地机器认证（Anisette）"))?;
        // kill_on_drop also handles timeout, malformed output and cancelled HTTP requests.
        result
    }
}
pub(crate) fn failure(message: &str) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "UPSTREAM_UNAVAILABLE",
        message,
        true,
    )
}

/// Private pipe protocol only. Never print device headers to an interactive terminal.
pub async fn worker(directory: &Path, backend: &str) -> Result<(), ApiError> {
    if std::io::stdout().is_terminal() || !matches!(backend, "local" | "portable") {
        return Err(ApiError::invalid("Anisette worker 仅用于 agent 内部管道。"));
    }
    prepare_private_directory(directory)?;
    let directory = directory.canonicalize()?.join("anisette");
    prepare_private_directory(&directory)?;
    // Queue concurrent requests in the disposable worker, without blocking the
    // HTTP runtime or running Apple's process-global state concurrently.
    let _lock = lock(&directory, true)?;
    let result = generate(&directory, backend).await;
    let reply = match result {
        Ok(headers) => Reply::Ok { headers },
        Err(message) => Reply::Error { message },
    };
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &reply)?;
    output.flush()?;
    Ok(())
}
pub(super) fn lock(directory: &Path, wait: bool) -> Result<std::fs::File, ApiError> {
    let lock_path = directory.join("worker.lock");
    if std::fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(ApiError::invalid("Anisette 锁文件不能是符号链接。"));
    }
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    protect(&lock_path, false)?;
    if wait {
        fs2::FileExt::lock_exclusive(&lock)
    } else {
        fs2::FileExt::try_lock_exclusive(&lock)
    }
    .map_err(|_| failure("Anisette 正在初始化，请稍后重试。"))?;
    Ok(lock)
}
async fn generate(directory: &Path, backend: &str) -> Result<Headers, String> {
    #[cfg(target_os = "macos")]
    if backend == "local" {
        return macos::headers().map_err(|phase| {
            format!("macOS 系统 Anisette 不可用（{phase}）。请在网页登录的“高级选项 → Anisette 来源”选择“便携运行库”；可先运行 atag-agent anisette init --portable 初始化。")
        });
    }
    let _ = backend;
    #[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
    {
        portable::headers(directory).await
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        let _ = directory;
        Err("本地 Anisette 运行库仅支持 64 位 x86_64 / aarch64；此架构请指定远程服务。".into())
    }
}

pub fn repair(directory: &Path) -> Result<(), ApiError> {
    let root = directory.join("anisette");
    prepare_private_directory(&root)?;
    let _lock = lock(&root, false)?;
    let path = root.join("libraries");
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(ApiError::invalid("运行库目录不能是符号链接。"));
    }
    if path.exists() {
        std::fs::remove_dir_all(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repair_preserves_identity_and_refuses_active_worker() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("anisette");
        prepare_private_directory(&root).unwrap();
        std::fs::create_dir(root.join("libraries")).unwrap();
        std::fs::write(root.join("libraries/libCoreADI.so"), b"cache").unwrap();
        std::fs::write(root.join("identity.json"), b"machine-identity").unwrap();
        let guard = lock(&root, false).unwrap();
        assert!(repair(directory.path()).is_err());
        assert!(root.join("libraries").exists());
        drop(guard);
        repair(directory.path()).unwrap();
        assert!(!root.join("libraries").exists());
        assert_eq!(
            std::fs::read(root.join("identity.json")).unwrap(),
            b"machine-identity"
        );
    }
}
