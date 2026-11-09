// SPDX-License-Identifier: MIT
// ABI reference: Apparition shim.rs, revision 5cb7813d29bbce863765651c651a17ff0889426a.
// See THIRD_PARTY_LICENSE.txt.
//! Minimal Android ABI used by the bundled local ADI runtime. All calls execute
//! in an isolated worker. Files are confined to that worker's private directory.
use super::elf::{Import, Library};
use rand_core::{OsRng, RngCore};
use std::{
    cell::Cell,
    collections::HashMap,
    ffi::{CStr, c_char, c_int, c_void},
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

thread_local! { static ERRNO: Cell<i32> = const { Cell::new(0) }; }
static ROOT: OnceLock<PathBuf> = OnceLock::new();
static FILES: OnceLock<Mutex<HashMap<i32, File>>> = OnceLock::new();
static LOADED: Mutex<Vec<(String, &'static Library)>> = Mutex::new(Vec::new());
pub(super) fn set_root(root: &Path) {
    let _ = ROOT.set(root.to_owned());
}
fn files() -> &'static Mutex<HashMap<i32, File>> {
    FILES.get_or_init(Default::default)
}
fn error(error: std::io::Error) -> i32 {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => 2,
        std::io::ErrorKind::PermissionDenied => 13,
        std::io::ErrorKind::AlreadyExists => 17,
        _ => 5,
    };
    ERRNO.with(|e| e.set(code));
    -1
}
unsafe fn path(pointer: *const c_char) -> std::io::Result<PathBuf> {
    if pointer.is_null() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    let value = unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let path = PathBuf::from(value);
    let root = ROOT.get().ok_or(std::io::ErrorKind::PermissionDenied)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, std::path::Component::ParentDir))
        || !path.starts_with(root)
    {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    // Resolve existing ancestors too; an in-directory link must not escape.
    if let Some(parent) = path.parent() {
        if path != *root && !parent.canonicalize()?.starts_with(root) {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(path)
}

#[cfg(target_arch = "x86_64")]
#[repr(C)]
struct LinuxStat {
    dev: u64,
    ino: u64,
    nlink: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    pad: u32,
    rdev: u64,
    size: i64,
    blksize: i64,
    blocks: i64,
    atime: i64,
    atime_nsec: u64,
    mtime: i64,
    mtime_nsec: u64,
    ctime: i64,
    ctime_nsec: u64,
    unused: [i64; 3],
}
#[cfg(target_arch = "aarch64")]
#[repr(C)]
struct LinuxStat {
    dev: u64,
    ino: u64,
    mode: u32,
    nlink: u32,
    uid: u32,
    gid: u32,
    rdev: u64,
    pad: u64,
    size: i64,
    blksize: i32,
    pad2: i32,
    blocks: i64,
    atime: i64,
    atime_nsec: u64,
    mtime: i64,
    mtime_nsec: u64,
    ctime: i64,
    ctime_nsec: u64,
    unused: [u32; 2],
}
#[repr(C)]
struct LinuxTimeval {
    sec: i64,
    usec: i64,
}
fn stat(meta: std::fs::Metadata, out: *mut LinuxStat) -> i32 {
    if out.is_null() {
        return -1;
    }
    let mut value: LinuxStat = unsafe { std::mem::zeroed() };
    value.mode = if meta.is_dir() { 0o40700 } else { 0o100600 };
    value.nlink = 1;
    value.size = meta.len() as i64;
    value.blksize = 4096;
    value.blocks = meta.len().div_ceil(512) as i64;
    if let Ok(time) = meta
        .modified()
        .and_then(|t| t.duration_since(UNIX_EPOCH).map_err(std::io::Error::other))
    {
        value.mtime = time.as_secs() as i64;
        value.mtime_nsec = u64::from(time.subsec_nanos());
    }
    unsafe { out.write(value) };
    0
}

adi_fn!(
    fn shim_open(pointer: *const c_char, flags: c_int, _mode: u32) -> c_int {
        let result = (|| {
            let path = unsafe { path(pointer) }?;
            let mut options = OpenOptions::new();
            options
                .read(flags & 3 != 1)
                .write(flags & 3 != 0)
                .create(flags & 0o100 != 0)
                .create_new(flags & 0o200 != 0)
                .truncate(flags & 0o1000 != 0)
                .append(flags & 0o2000 != 0);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(path)?;
            let mut files = files().lock().map_err(|_| std::io::ErrorKind::Other)?;
            let fd = (100..10000)
                .find(|fd| !files.contains_key(fd))
                .ok_or(std::io::ErrorKind::Other)?;
            files.insert(fd, file);
            Ok::<_, std::io::Error>(fd)
        })();
        result.unwrap_or_else(error)
    }
);
adi_fn!(
    fn shim_close(fd: c_int) -> c_int {
        if files().lock().unwrap().remove(&fd).is_some() {
            0
        } else {
            -1
        }
    }
);
adi_fn!(
    fn shim_read(fd: c_int, buffer: *mut c_void, length: usize) -> isize {
        if buffer.is_null() || length > 16 * 1024 * 1024 {
            return -1;
        }
        files()
            .lock()
            .unwrap()
            .get_mut(&fd)
            .ok_or(std::io::ErrorKind::NotFound)
            .and_then(|file| {
                file.read(unsafe { std::slice::from_raw_parts_mut(buffer.cast(), length) })
                    .map_err(|e| e.kind())
            })
            .map_or(-1, |n| n as isize)
    }
);
adi_fn!(
    fn shim_write(fd: c_int, buffer: *const c_void, length: usize) -> isize {
        if buffer.is_null() || length > 16 * 1024 * 1024 {
            return -1;
        }
        files()
            .lock()
            .unwrap()
            .get_mut(&fd)
            .ok_or(std::io::ErrorKind::NotFound)
            .and_then(|file| {
                file.write(unsafe { std::slice::from_raw_parts(buffer.cast(), length) })
                    .map_err(|e| e.kind())
            })
            .map_or(-1, |n| n as isize)
    }
);
adi_fn!(
    fn shim_ftruncate(fd: c_int, length: i64) -> c_int {
        if length < 0 {
            return -1;
        }
        files().lock().unwrap().get(&fd).map_or(-1, |file| {
            if file.set_len(length as u64).is_ok() {
                0
            } else {
                -1
            }
        })
    }
);
adi_fn!(
    fn shim_fstat(fd: c_int, out: *mut LinuxStat) -> c_int {
        files()
            .lock()
            .unwrap()
            .get(&fd)
            .and_then(|file| file.metadata().ok())
            .map_or(-1, |meta| stat(meta, out))
    }
);
adi_fn!(
    fn shim_lstat(pointer: *const c_char, out: *mut LinuxStat) -> c_int {
        match unsafe { path(pointer) }.and_then(std::fs::symlink_metadata) {
            Ok(meta) => stat(meta, out),
            Err(e) => error(e),
        }
    }
);
adi_fn!(
    fn shim_mkdir(pointer: *const c_char, _mode: u32) -> c_int {
        match unsafe { path(pointer) }.and_then(|path| {
            let builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            let mut builder = builder;
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path)
        }) {
            Ok(()) => 0,
            Err(e) => error(e),
        }
    }
);
adi_fn!(
    fn shim_chmod(pointer: *const c_char, _mode: u32) -> c_int {
        match unsafe { path(pointer) } {
            Ok(path) => {
                if crate::private_files::protect(&path, path.is_dir()).is_ok() {
                    0
                } else {
                    -1
                }
            }
            Err(e) => error(e),
        }
    }
);
// The host agent's process-wide umask is never changed by an ADI library.
adi_fn!(
    fn shim_umask(_mask: u32) -> u32 {
        0o077
    }
);
adi_fn!(
    fn shim_errno() -> *mut c_int {
        ERRNO.with(Cell::as_ptr)
    }
);
adi_fn!(
    fn shim_gettimeofday(out: *mut LinuxTimeval, _timezone: *mut c_void) -> c_int {
        if out.is_null() {
            return -1;
        }
        let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
            return -1;
        };
        unsafe {
            out.write(LinuxTimeval {
                sec: now.as_secs() as i64,
                usec: i64::from(now.subsec_micros()),
            })
        };
        0
    }
);
adi_fn!(
    fn shim_arc4random() -> u32 {
        let mut bytes = [0; 4];
        if OsRng.try_fill_bytes(&mut bytes).is_err() {
            std::process::abort();
        }
        u32::from_ne_bytes(bytes)
    }
);
adi_fn!(
    fn shim_property(_name: *const c_char, value: *mut c_char) -> c_int {
        if !value.is_null() {
            unsafe { *value = 0 };
        }
        0
    }
);
adi_fn!(
    fn shim_ok() -> c_int {
        0
    }
);
adi_fn!(
    fn shim_finalize(_dso: *mut c_void) -> () {}
);
type Routine = adi_type!(fn());
adi_fn!(
    fn shim_once(once: *mut c_int, routine: Routine) -> c_int {
        if !once.is_null() && unsafe { *once } == 0 {
            unsafe {
                *once = 1;
                routine();
            }
        }
        0
    }
);
adi_fn!(
    fn shim_abort() -> ! {
        std::process::abort()
    }
);
adi_fn!(
    fn shim_malloc(length: usize) -> *mut c_void {
        unsafe { libc::malloc(length) }
    }
);
adi_fn!(
    fn shim_calloc(count: usize, length: usize) -> *mut c_void {
        unsafe { libc::calloc(count, length) }
    }
);
adi_fn!(
    fn shim_realloc(pointer: *mut c_void, length: usize) -> *mut c_void {
        unsafe { libc::realloc(pointer, length) }
    }
);
adi_fn!(
    fn shim_free(pointer: *mut c_void) -> () {
        unsafe { libc::free(pointer) }
    }
);
adi_fn!(
    fn shim_memchr(pointer: *const c_void, value: c_int, length: usize) -> *mut c_void {
        unsafe { libc::memchr(pointer, value, length) }
    }
);
adi_fn!(
    fn shim_memcmp(a: *const c_void, b: *const c_void, length: usize) -> c_int {
        unsafe { libc::memcmp(a, b, length) }
    }
);
adi_fn!(
    fn shim_memcpy(to: *mut c_void, from: *const c_void, length: usize) -> *mut c_void {
        unsafe { libc::memcpy(to, from, length) }
    }
);
adi_fn!(
    fn shim_memmove(to: *mut c_void, from: *const c_void, length: usize) -> *mut c_void {
        unsafe { libc::memmove(to, from, length) }
    }
);
adi_fn!(
    fn shim_memset(to: *mut c_void, value: c_int, length: usize) -> *mut c_void {
        unsafe { libc::memset(to, value, length) }
    }
);
adi_fn!(
    fn shim_memcpy_chk(
        to: *mut c_void,
        from: *const c_void,
        length: usize,
        capacity: usize,
    ) -> *mut c_void {
        if length > capacity {
            std::process::abort();
        }
        unsafe { libc::memcpy(to, from, length) }
    }
);
adi_fn!(
    fn shim_memmove_chk(
        to: *mut c_void,
        from: *const c_void,
        length: usize,
        capacity: usize,
    ) -> *mut c_void {
        if length > capacity {
            std::process::abort();
        }
        unsafe { libc::memmove(to, from, length) }
    }
);
adi_fn!(
    fn shim_strlen(pointer: *const c_char) -> usize {
        unsafe { libc::strlen(pointer) }
    }
);
adi_fn!(
    fn shim_strcmp(a: *const c_char, b: *const c_char) -> c_int {
        unsafe { libc::strcmp(a, b) }
    }
);
adi_fn!(
    fn shim_strncmp(a: *const c_char, b: *const c_char, length: usize) -> c_int {
        unsafe { libc::strncmp(a, b, length) }
    }
);
adi_fn!(
    fn shim_strncpy(to: *mut c_char, from: *const c_char, length: usize) -> *mut c_char {
        unsafe { libc::strncpy(to, from, length) }
    }
);
adi_fn!(
    fn shim_strcasecmp(a: *const c_char, b: *const c_char) -> c_int {
        let mut n = 0;
        loop {
            let left = unsafe { *a.add(n) } as u8;
            let right = unsafe { *b.add(n) } as u8;
            let diff = i32::from(left.to_ascii_lowercase()) - i32::from(right.to_ascii_lowercase());
            if diff != 0 || left == 0 || right == 0 {
                return diff;
            }
            n += 1;
        }
    }
);
adi_fn!(
    fn shim_strtol(value: *const c_char, end: *mut *mut c_char, base: c_int) -> i64 {
        unsafe { libc::strtoll(value, end, base) }
    }
);
adi_fn!(
    fn shim_strtoull(value: *const c_char, end: *mut *mut c_char, base: c_int) -> u64 {
        unsafe { libc::strtoull(value, end, base) }
    }
);
adi_fn!(
    fn shim_strtod(value: *const c_char, end: *mut *mut c_char) -> f64 {
        unsafe { libc::strtod(value, end) }
    }
);
adi_fn!(
    fn shim_atof(value: *const c_char) -> f64 {
        unsafe { libc::atof(value) }
    }
);

pub(super) fn register(name: &str, library: &'static Library) {
    LOADED.lock().unwrap().push((name.into(), library));
}
adi_fn!(
    fn shim_dlopen(pointer: *const c_char, _flags: c_int) -> *mut c_void {
        if pointer.is_null() {
            return std::ptr::dangling_mut();
        }
        let path = unsafe { CStr::from_ptr(pointer) }.to_string_lossy();
        let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
        LOADED
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key == name)
            .map_or(std::ptr::null_mut(), |(_, lib)| {
                std::ptr::from_ref::<Library>(lib).cast_mut().cast()
            })
    }
);
adi_fn!(
    fn shim_dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void {
        if name.is_null() {
            return std::ptr::null_mut();
        }
        let name = unsafe { CStr::from_ptr(name) }.to_string_lossy();
        let loaded = LOADED.lock().unwrap();
        let found = match loaded.iter().find(|(_, lib)| {
            std::ptr::from_ref::<Library>(lib).cast::<c_void>() == handle.cast_const()
        }) {
            Some((_, lib)) => lib.symbol(&name),
            None => loaded
                .iter()
                .find_map(|(_, lib)| lib.symbol(&name))
                .or_else(|| function(&name)),
        };
        found.map_or(std::ptr::null_mut(), |p| p as *mut c_void)
    }
);
fn function(name: &str) -> Option<usize> {
    let pointer = match name {
        "open" => shim_open as *const (),
        "close" => shim_close as *const (),
        "read" => shim_read as *const (),
        "write" => shim_write as *const (),
        "ftruncate" => shim_ftruncate as *const (),
        "fstat" => shim_fstat as *const (),
        "lstat" => shim_lstat as *const (),
        "mkdir" => shim_mkdir as *const (),
        "chmod" => shim_chmod as *const (),
        "umask" => shim_umask as *const (),
        "__errno" => shim_errno as *const (),
        "gettimeofday" => shim_gettimeofday as *const (),
        "arc4random" => shim_arc4random as *const (),
        "__system_property_get" => shim_property as *const (),
        "__cxa_atexit"
        | "pthread_rwlock_init"
        | "pthread_rwlock_destroy"
        | "pthread_rwlock_rdlock"
        | "pthread_rwlock_wrlock"
        | "pthread_rwlock_unlock"
        | "dlclose" => shim_ok as *const (),
        "__cxa_finalize" => shim_finalize as *const (),
        "pthread_once" => shim_once as *const (),
        "abort" | "__stack_chk_fail" => shim_abort as *const (),
        "malloc" => shim_malloc as *const (),
        "calloc" => shim_calloc as *const (),
        "realloc" => shim_realloc as *const (),
        "free" => shim_free as *const (),
        "memchr" => shim_memchr as *const (),
        "memcmp" => shim_memcmp as *const (),
        "memcpy" => shim_memcpy as *const (),
        "memmove" => shim_memmove as *const (),
        "memset" => shim_memset as *const (),
        "__memcpy_chk" => shim_memcpy_chk as *const (),
        "__memmove_chk" => shim_memmove_chk as *const (),
        "strlen" => shim_strlen as *const (),
        "strcmp" => shim_strcmp as *const (),
        "strncmp" => shim_strncmp as *const (),
        "strncpy" => shim_strncpy as *const (),
        "strcasecmp" => shim_strcasecmp as *const (),
        "strtol" | "strtoll" => shim_strtol as *const (),
        "strtoull" => shim_strtoull as *const (),
        "strtod" => shim_strtod as *const (),
        "atof" => shim_atof as *const (),
        "dlopen" => shim_dlopen as *const (),
        "dlsym" => shim_dlsym as *const (),
        _ => return None,
    };
    Some(pointer as usize)
}
pub(super) fn resolve(import: &Import) -> Option<usize> {
    if import.object {
        static OBJECTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
        let mut map = OBJECTS.get_or_init(Default::default).lock().unwrap();
        return Some(*map.entry(import.name.into()).or_insert_with(|| {
            let mut storage = vec![0; 4096];
            if import.name == "__stack_chk_guard" {
                OsRng.fill_bytes(&mut storage);
            }
            Box::leak(storage.into_boxed_slice()).as_ptr() as usize
        }));
    }
    // Unexpected execution is isolated to the local worker, never the server.
    Some(function(import.name).unwrap_or(shim_abort as *const () as usize))
}
