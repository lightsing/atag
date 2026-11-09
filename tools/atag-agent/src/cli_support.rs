//! Shared command-line options and the private worker entry point for executable hosts.
use crate::{
    anisette::local::{self, LOCAL_WORKER_COMMAND},
    error::ApiError,
    server::ServerConfig,
};
use clap::{Args, Subcommand};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Args)]
pub struct ListenArgs {
    /// Exact loopback address. If omitted, use the first available discovery port.
    #[arg(long)]
    listen: Option<SocketAddr>,
    /// Exact web origin; repeat for multiple sites. Defaults to local ports 5173 and 3000.
    #[arg(long)]
    allow_origin: Vec<String>,
}

impl ListenArgs {
    pub fn config(self, data_dir: Option<PathBuf>) -> ServerConfig {
        let mut config = ServerConfig {
            listen: self.listen,
            data_dir,
            ..ServerConfig::default()
        };
        if !self.allow_origin.is_empty() {
            config.allowed_origins = self.allow_origin;
        }
        config
    }
}

/// Dispatch this hidden command before starting a graphical event loop. The `local` and `portable`
/// Anisette providers launch the host executable with this command to isolate the native runtime.
#[derive(Subcommand)]
pub enum WorkerCommand {
    #[command(name = LOCAL_WORKER_COMMAND, hide = true)]
    Anisette { backend: String },
}

impl WorkerCommand {
    pub async fn run(self, data_dir: &Path) -> Result<(), ApiError> {
        match self {
            Self::Anisette { backend } => local::worker(data_dir, &backend).await,
        }
    }
}
