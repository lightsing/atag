use super::{
    local,
    protocol::{FRAME_LIMIT, Reply, Request},
};
use crate::error::ApiError;
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub(super) struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Worker {
    pub fn spawn(library: &Path) -> Result<Self, ApiError> {
        let executable = std::env::current_exe()?.with_file_name(format!(
            "atag-coreadi-worker{}",
            std::env::consts::EXE_SUFFIX
        ));
        let mut command = Command::new(executable);
        command
            .arg(library)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SYSTEMROOT") {
            command.env("SYSTEMROOT", root);
        }
        let mut child = command.spawn().map_err(|_| {
            local::failure("无法启动 atag-coreadi-worker，请将它与 atag-agent 放在同一目录。")
        })?;
        let input = child.stdin.take().ok_or_else(ApiError::internal)?;
        let output = BufReader::new(child.stdout.take().ok_or_else(ApiError::internal)?);
        Ok(Self {
            child,
            input,
            output,
        })
    }

    pub async fn exchange(&mut self, request: &Request) -> Result<Reply, ApiError> {
        let mut request = serde_json::to_vec(request)?;
        if request.len() as u64 >= FRAME_LIMIT {
            return Err(local::failure("CoreADI 机器认证请求过大。"));
        }
        request.push(b'\n');
        self.input
            .write_all(&request)
            .await
            .map_err(|_| failure())?;
        let mut reply = Vec::new();
        (&mut self.output)
            .take(FRAME_LIMIT + 1)
            .read_until(b'\n', &mut reply)
            .await
            .map_err(|_| failure())?;
        if reply.len() as u64 > FRAME_LIMIT || reply.last() != Some(&b'\n') {
            return Err(failure());
        }
        match serde_json::from_slice(&reply) {
            Ok(Reply::Error) | Err(_) => Err(failure()),
            Ok(reply) => Ok(reply),
        }
    }

    pub async fn finish(mut self) -> Result<(), ApiError> {
        drop(self.input);
        if !self.child.wait().await.map_err(|_| failure())?.success() {
            return Err(failure());
        }
        Ok(())
    }
}

pub(super) fn failure() -> ApiError {
    local::failure("macOS CoreADI 模拟失败；请运行 atag-agent anisette init 检查机器状态。")
}
