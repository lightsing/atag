use atag_agent::{
    anisette::{AnisetteProvider, install_mac_coreadi, local},
    cli_support::{ListenArgs, WorkerCommand},
    error::ApiError,
    server::{AgentServer, resolve_data_dir},
};
use clap::{Parser, Subcommand};
use std::{path::PathBuf, process::ExitCode};

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
    #[command(flatten)]
    Worker(WorkerCommand),
    /// Serve the user-agnostic Anisette and Apple request bridge. No device/account database is opened.
    Serve(ListenArgs),
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
    let directory = resolve_data_dir(cli.data_dir)?;
    match cli.command {
        Command::Worker(command) => command.run(&directory).await,
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
        Command::Serve(listen) => {
            let server = AgentServer::bind(listen.config(Some(directory))).await?;
            let address = server.local_addr();
            println!("ATAG v1 bridge listening on http://{address}; device/account storage: none");
            server.serve(shutdown_signal()).await
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
