//! Headless #280 research: resolve a retained file handle after external renames.
//! This is not wired into production watching or saving. Identity validation
//! here is a point-in-time observation, not a race-free authorization to write.
#![cfg(any(target_os = "macos", target_os = "windows"))]

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::{c_char, c_int, CStr, OsStr};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    unsafe extern "C" {
        fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
    }

    pub fn path(file: &File) -> io::Result<PathBuf> {
        // Darwin sys/fcntl.h: F_GETPATH = 50; buffer size is MAXPATHLEN.
        let mut buffer = [0 as c_char; 1024];
        // SAFETY: fd remains live, and F_GETPATH receives its required buffer.
        if unsafe { fcntl(file.as_raw_fd(), 50, buffer.as_mut_ptr()) } == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful F_GETPATH supplies a NUL-terminated path.
        let bytes = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_bytes();
        Ok(PathBuf::from(OsStr::from_bytes(bytes)))
    }

    pub fn same(left: &File, right: &File) -> io::Result<bool> {
        let (left, right) = (left.metadata()?, right.metadata()?);
        Ok((left.dev(), left.ino()) == (right.dev(), right.ino()))
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    #[derive(Default, PartialEq)]
    struct FileIdInfo {
        volume_serial_number: u64,
        file_id: [u8; 16],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            file: *mut c_void,
            path: *mut u16,
            size: u32,
            flags: u32,
        ) -> u32;
        fn GetFileInformationByHandleEx(
            file: *mut c_void,
            class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
    }

    pub fn path(file: &File) -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 1024];
        loop {
            // SAFETY: handle remains live; buffer contains size writable WCHARs.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            };
            if length == 0 {
                return Err(io::Error::last_os_error());
            }
            if (length as usize) < buffer.len() {
                return Ok(PathBuf::from(OsString::from_wide(
                    &buffer[..length as usize],
                )));
            }
            buffer.resize(length as usize + 1, 0);
        }
    }

    fn identity(file: &File) -> io::Result<FileIdInfo> {
        let mut info = FileIdInfo::default();
        // SAFETY: FileIdInfo matches FILE_ID_INFO; class FileIdInfo = 18.
        let success = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                18,
                (&mut info as *mut FileIdInfo).cast(),
                std::mem::size_of::<FileIdInfo>() as u32,
            )
        };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    pub fn same(left: &File, right: &File) -> io::Result<bool> {
        Ok(identity(left)? == identity(right)?)
    }
}

fn verified_path(file: &File) -> Option<PathBuf> {
    let path = platform::path(file).ok()?;
    let candidate = File::open(&path).ok()?;
    platform::same(file, &candidate).ok()?.then_some(path)
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "mojidori-rename-handle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str) -> (PathBuf, File) {
        let path = self.0.join(name);
        fs::write(&path, b"original").unwrap();
        let file = File::open(&path).unwrap();
        (path, file)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn assert_resolves(file: &File, expected: &Path) {
    assert_eq!(
        verified_path(file).map(|path| fs::canonicalize(path).unwrap()),
        Some(fs::canonicalize(expected).unwrap())
    );
}

#[test]
fn follows_same_directory_rename_and_rejects_reused_old_path() {
    let fixture = Fixture::new();
    let (old, file) = fixture.file("before.txt");
    let new = fixture.0.join("renamed-文字-😀.txt");
    fs::rename(&old, &new).unwrap();
    fs::write(&old, b"unrelated").unwrap();
    assert!(!platform::same(&file, &File::open(&old).unwrap()).unwrap());
    assert_resolves(&file, &new);
    assert_eq!(
        fs::read(verified_path(&file).unwrap()).unwrap(),
        b"original"
    );
}

#[test]
fn follows_cross_directory_and_parent_directory_rename() {
    let fixture = Fixture::new();
    let (old, file) = fixture.file("before.txt");
    let parent = fixture.0.join("parent");
    fs::create_dir(&parent).unwrap();
    let moved = parent.join("after.txt");
    fs::rename(old, &moved).unwrap();
    assert_resolves(&file, &moved);
    let renamed_parent = fixture.0.join("renamed-parent");
    fs::rename(parent, &renamed_parent).unwrap();
    assert_resolves(&file, &renamed_parent.join("after.txt"));
}

#[test]
fn deleted_handle_never_resolves_to_replacement_at_old_path() {
    let fixture = Fixture::new();
    let (path, file) = fixture.file("deleted.txt");
    fs::remove_file(&path).unwrap();
    assert_eq!(verified_path(&file), None);
    fs::write(&path, b"replacement").unwrap();
    assert_eq!(verified_path(&file), None);
}

#[test]
fn atomic_replacement_requires_a_new_handle() {
    let fixture = Fixture::new();
    let (path, file) = fixture.file("saved.txt");
    let (replacement, _) = fixture.file("replacement.tmp");
    fs::rename(replacement, &path).unwrap();
    assert_eq!(verified_path(&file), None);
    assert_resolves(&File::open(&path).unwrap(), &path);
}

#[test]
fn hardlink_identity_does_not_identify_a_unique_document_path() {
    let fixture = Fixture::new();
    let (path, file) = fixture.file("original.txt");
    let alias = fixture.0.join("alias.txt");
    fs::hard_link(&path, &alias).unwrap();
    assert!(platform::same(&file, &File::open(&alias).unwrap()).unwrap());
    // A production design cannot infer which pathname the user meant from ID.
    let resolved = verified_path(&file).unwrap();
    assert!(platform::same(&file, &File::open(resolved).unwrap()).unwrap());
}

#[cfg(target_os = "macos")]
#[test]
fn symlink_handle_reports_target_instead_of_document_alias() {
    let fixture = Fixture::new();
    let (target, _) = fixture.file("target.txt");
    let alias = fixture.0.join("alias.txt");
    std::os::unix::fs::symlink(&target, &alias).unwrap();
    let file = File::open(&alias).unwrap();
    assert_resolves(&file, &target);
    assert_ne!(platform::path(&file).unwrap(), alias);
}
