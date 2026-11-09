#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

mod service;
mod tray;

use anyhow::{Result, bail};
use atag_agent::{
    cli_support::{ListenArgs, WorkerCommand},
    server::resolve_data_dir,
};
use clap::Parser;
use std::{path::PathBuf, process::ExitCode};
use url::Url;

#[derive(Parser)]
#[command(version, about = "ATAG desktop tray", disable_help_subcommand = true)]
struct Cli {
    /// Directory for Anisette machine material.
    #[arg(long, global = true, env = "ATAG_AGENT_DATA_DIR")]
    data_dir: Option<PathBuf>,
    #[command(flatten)]
    listen: ListenArgs,
    /// Add this site's origin to the allowlist and show an Open ATAG Web menu item.
    #[arg(long, value_parser = parse_web_url)]
    web_url: Option<Url>,
    #[command(subcommand)]
    worker: Option<WorkerCommand>,
}

fn parse_web_url(input: &str) -> Result<Url> {
    let url = Url::parse(input)?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("--web-url requires an HTTP or HTTPS URL without credentials");
    }
    Ok(url)
}

fn run(cli: Cli) -> Result<()> {
    if let Some(worker) = cli.worker {
        let directory = resolve_data_dir(cli.data_dir)?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(worker.run(&directory))?;
        return Ok(());
    }

    let web_url = match cli.web_url {
        Some(url) => Some(url),
        None => option_env!("ATAG_TRAY_WEB_URL")
            .map(parse_web_url)
            .transpose()?,
    };
    let mut config = cli.listen.config(cli.data_dir);
    if let Some(url) = &web_url {
        let origin = url.origin().ascii_serialization();
        if !config.allowed_origins.contains(&origin) {
            config.allowed_origins.push(origin);
        }
    }
    tray::run(config, web_url)
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("atag-agent-tray: {error:#}");
            ExitCode::FAILURE
        }
    }
}
