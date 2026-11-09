use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rerun-if-env-changed=ATAG_FIRMWARE_VERSION");
    let version = env::var("ATAG_FIRMWARE_VERSION")
        .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
    assert!(
        version.len() == 5 && version.is_ascii(),
        "firmware version must be 5 ASCII bytes"
    );
    println!("cargo:rustc-env=ATAG_FIRMWARE_VERSION={version}");

    let target = env::var("TARGET").expect("TARGET is set by Cargo");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));

    if target.starts_with("thumbv7em-none-eabi") {
        fs::copy("memory.x", out_dir.join("memory.x")).expect("copy memory.x");
        println!("cargo:rustc-link-search={}", out_dir.display());
    }
}
