use atag_agent::private_files::{prepare_private_directory, protect, read_bounded};

#[test]
fn machine_directory_and_files_are_private() {
    let dir = tempfile::tempdir().unwrap();
    prepare_private_directory(dir.path()).unwrap();
    let path = dir.path().join("machine-material");
    std::fs::write(&path, b"synthetic-machine-material").unwrap();
    protect(&path, false).unwrap();
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn rejects_oversized_files_without_modifying_them() {
    let dir = tempfile::tempdir().unwrap();
    prepare_private_directory(dir.path()).unwrap();
    let path = dir.path().join("machine-material");
    std::fs::write(&path, b"invalid").unwrap();
    assert!(read_bounded(&path, 3).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"invalid");
    assert_eq!(read_bounded(&path, 7).unwrap(), b"invalid");
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_private_paths() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::create_dir(&target).unwrap();
    let link = dir.path().join("link");
    symlink(&target, &link).unwrap();
    assert!(prepare_private_directory(&link).is_err());
    let source = target.join("source");
    std::fs::write(&source, "a".repeat(64)).unwrap();
    let file_link = target.join("machine-material");
    symlink(&source, &file_link).unwrap();
    assert!(read_bounded(&file_link, 256).is_err());
    assert!(protect(&file_link, false).is_err());
}
