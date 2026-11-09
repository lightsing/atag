use atag_agent::{
    anisette::{AnisetteProvider, install_mac_coreadi, local},
    bridge::{ApiConfig, Bridge},
    error::ApiError,
};
use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(version, about = "ATAG cross-platform local agent")]
struct Cli {
    /// Anisette machine-material directory; no account or Tag database.
    #[arg(long, global = true, env = "ATAG_AGENT_DATA_DIR")]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize local Anisette without logging in or printing device headers.
    Anisette {
        #[command(subcommand)]
        command: AnisetteCommand,
    },
    #[command(name = "__anisette", hide = true)]
    AnisetteWorker { backend: String },
    /// Serve the user-agnostic Anisette and Apple request bridge. No device/account database is opened.
    Serve {
        #[arg(long, default_value = "127.0.0.1:18432")]
        listen: SocketAddr,
        /// Exact web origin; repeat for multiple sites. Defaults to local ports 5173 and 3000.
        #[arg(long)]
        allow_origin: Vec<String>,
    },
}

#[derive(Subcommand)]
enum AnisetteCommand {
    /// Install the verified CoreADI library and optionally import an existing machine registration.
    InstallMacCoreadi {
        /// Verified x86_64 slice extracted from Apple's iTunes package.
        #[arg(long)]
        library: PathBuf,
        /// Existing emulator machine directory (identity and ADI store only).
        #[arg(long)]
        machine: Option<PathBuf>,
    },
    Init {
        /// Use the Android ADI runtime.
        #[arg(long, conflicts_with = "system")]
        portable: bool,
        /// Use the historical system backend on macOS.
        #[arg(long)]
        system: bool,
        /// Re-download libraries, preserving the machine's provisioning identity.
        #[arg(long, requires = "portable")]
        repair: bool,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atag-agent: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), ApiError> {
    let directory = cli
        .data_dir
        .or_else(|| dirs::data_local_dir().map(|d| d.join("atag-agent")))
        .ok_or_else(|| ApiError::invalid("无法确定数据目录，请指定 --data-dir。"))?;
    match cli.command {
        Command::AnisetteWorker { backend } => local::worker(&directory, &backend).await,
        Command::Anisette {
            command: AnisetteCommand::InstallMacCoreadi { library, machine },
        } => {
            install_mac_coreadi(&directory, &library, machine.as_deref())?;
            println!(
                "macOS CoreADI runtime installed. Run anisette init to verify machine provisioning."
            );
            Ok(())
        }
        Command::Anisette {
            command:
                AnisetteCommand::Init {
                    portable,
                    system,
                    repair,
                },
        } => {
            if repair {
                local::repair(&directory)?;
            }
            eprintln!("正在初始化本地 Anisette…");
            let (source, name) = if portable {
                ("portable", "portable ADI")
            } else if system {
                (
                    "local",
                    if cfg!(target_os = "macos") {
                        "macOS system"
                    } else {
                        "portable ADI"
                    },
                )
            } else {
                ("mac-coreadi", "emulated macOS CoreADI")
            };
            AnisetteProvider::for_directory(source, &directory)?
                .initialize()
                .await?;
            println!("Local Anisette ready ({name}). No Apple account was used.");
            Ok(())
        }
        Command::Serve {
            listen,
            mut allow_origin,
        } => {
            if !listen.ip().is_loopback() {
                return Err(ApiError::invalid("agent 只允许监听 loopback 地址。"));
            }
            if allow_origin.is_empty() {
                allow_origin = vec![
                    "http://localhost:5173".into(),
                    "http://127.0.0.1:5173".into(),
                    "http://localhost:3000".into(),
                    "http://127.0.0.1:3000".into(),
                ];
            }
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let address = listener.local_addr()?;
            let bridge = Bridge::with_directory(
                ApiConfig {
                    address,
                    allowed_origins: allow_origin,
                },
                directory,
            )?;
            println!("ATAG v1 bridge listening on http://{address}; device/account storage: none");
            axum::serve(listener, bridge.router())
                .with_graceful_shutdown(shutdown_signal())
                .await?;
            Ok(())
        }
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => (), _ = term.recv() => () }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
