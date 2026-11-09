use std::{
    path::Path,
    process::{Command, Output},
};

fn command(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_atag-agent"))
        .arg("--data-dir")
        .arg(directory)
        .args(args)
        .env_remove("ATAG_ANISETTE_URL")
        .env_remove("ATAG_AGENT_DATA_DIR")
        .output()
        .unwrap()
}
#[test]
fn worker_failures_do_not_expose_machine_material() {
    let directory = tempfile::tempdir().unwrap();
    let cache = directory.path().join("anisette/libraries");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        cache.join("libCoreADI.so"),
        b"synthetic-private-machine-material",
    )
    .unwrap();
    let output = command(directory.path(), &["anisette", "init", "--portable"]);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("缓存校验失败"));
    assert!(!error.contains("synthetic-private-machine-material"));
    assert!(!directory.path().join("store.json").exists());
}

#[tokio::test]
async fn serve_creates_no_transport_or_user_state() {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let mut process = Running(
        Command::new(env!("CARGO_BIN_EXE_atag-agent"))
            .arg("--data-dir")
            .arg(directory.path())
            .args(["serve", "--listen", "127.0.0.1:0"])
            .env_remove("ATAG_ANISETTE_URL")
            .env_remove("ATAG_AGENT_DATA_DIR")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = process.0.stdout.take().unwrap();
    let (line, _stdout) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut line = String::new();
            let mut reader = BufReader::new(stdout);
            reader.read_line(&mut line).unwrap();
            (line, reader)
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let url = line
        .trim()
        .strip_prefix("ATAG v1 bridge listening on ")
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let health: serde_json::Value = client
        .get(format!("{url}/v1/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["protocolVersion"], 1);
    assert_eq!(health["storage"], "none");
    assert_eq!(health["capabilities"]["appleRelay"], true);
    let old = client
        .get(format!("{url}/v1/devices"))
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), 404);
    let files: Vec<_> = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(files.is_empty());
}

#[test]
fn command_surface_is_user_agnostic_and_has_no_token_command() {
    let directory = tempfile::tempdir().unwrap();
    let help = command(directory.path(), &["--help"]);
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.contains("serve"));
    for removed in [
        "token",
        "login",
        "import-account",
        "import-devices",
        "import-bundle",
        "configure-device",
        "restore-device",
    ] {
        assert!(!help.contains(removed));
        assert!(!command(directory.path(), &[removed]).status.success());
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
