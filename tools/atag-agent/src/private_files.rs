//! Private Anisette machine files.
use crate::error::ApiError;
use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, ApiError> {
    reject_symlink(path)?;
    let mut data = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(ApiError::invalid("文件超过大小限制。"));
    }
    Ok(data)
}

pub fn prepare_private_directory(path: &Path) -> Result<(), ApiError> {
    reject_symlink(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    protect(path, true)?;
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), ApiError> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(ApiError::invalid("私密文件或目录不能是符号链接。"));
        }
    }
    Ok(())
}

pub fn protect(path: &Path, directory: bool) -> Result<(), ApiError> {
    reject_symlink(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    windows_private_acl(path, directory)?;
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        return Err(ApiError::invalid("该平台尚未实现私密文件权限。"));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_private_acl(path: &Path, directory: bool) -> std::io::Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
        },
    };
    // Protected DACL: the owner and SYSTEM only. Directories pass these rights
    // to new children, so temporary files are private from their creation.
    let sddl = if directory {
        "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
    } else {
        "D:P(A;;FA;;;OW)(A;;FA;;;SY)"
    };
    let sddl: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: both strings are terminated and live across the calls; the API
    // allocates descriptor, which is released once with LocalFree on all paths.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let result = SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        );
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        if result == 0 {
            return Err(error);
        }
    }
    Ok(())
}
