//! The loopback bridge shared by the CLI and desktop hosts.
use crate::{
    bridge::{ApiConfig, Bridge},
    default_data_dir,
    error::ApiError,
};
use axum::Router;
use std::{
    future::Future,
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};
use tokio::net::TcpListener;

pub const DEFAULT_LISTEN: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 18432);

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub listen: SocketAddr,
    pub allowed_origins: Vec<String>,
    pub data_dir: Option<PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: DEFAULT_LISTEN,
            allowed_origins: [
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "http://localhost:3000",
                "http://127.0.0.1:3000",
            ]
            .map(String::from)
            .to_vec(),
            data_dir: None,
        }
    }
}

pub fn resolve_data_dir(data_dir: Option<PathBuf>) -> Result<PathBuf, ApiError> {
    data_dir
        .or_else(default_data_dir)
        .ok_or_else(|| ApiError::invalid("无法确定数据目录，请指定 --data-dir。"))
}

pub struct AgentServer {
    address: SocketAddr,
    listener: TcpListener,
    router: Router,
}

impl AgentServer {
    /// Bind the loopback listener and validate the configuration before serving any requests.
    pub async fn bind(config: ServerConfig) -> Result<Self, ApiError> {
        if !config.listen.ip().is_loopback() {
            return Err(ApiError::invalid("agent 只允许监听 loopback 地址。"));
        }
        let directory = resolve_data_dir(config.data_dir)?;
        let listener = TcpListener::bind(config.listen).await.map_err(|error| {
            if error.kind() == ErrorKind::AddrInUse {
                ApiError::invalid(&format!("监听地址 {} 已被占用。", config.listen))
            } else {
                error.into()
            }
        })?;
        let address = listener.local_addr()?;
        let bridge = Bridge::with_directory(
            ApiConfig {
                address,
                allowed_origins: config.allowed_origins,
            },
            directory,
        )?;
        Ok(Self {
            address,
            listener,
            router: bridge.router(),
        })
    }

    /// The actual bound address, including the OS-selected port if the requested port was zero.
    pub fn local_addr(&self) -> SocketAddr {
        self.address
    }

    /// Stop accepting connections when `shutdown` completes and drain active requests.
    pub async fn serve(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), ApiError> {
        axum::serve(self.listener, self.router)
            .with_graceful_shutdown(shutdown)
            .await?;
        Ok(())
    }
}
