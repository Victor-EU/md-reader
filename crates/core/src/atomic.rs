//! Atomic file replacement: write a temporary file beside the target, sync
//! it, give it the target's permissions, then swap it into place. A crash at
//! any point leaves either the old file or the new one, never a torn mix.
//!
//! Where there is no target there are no bits to keep, so the caller says
//! what a new file should be -- see `Create`.

use std::fs;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

/// How open a file should be when this call is the one that creates it.
///
/// It decides nothing when the target already exists: a file that is there
/// keeps its own bits, whichever variant is passed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Create {
    /// A document in the reader's own folders. It gets what their umask
    /// gives every other file they make, so a note saved here is no more
    /// private, and no less, than one saved by any other editor.
    AsUser,
    /// The app's own store: snapshots and session state, which hold the
    /// reader's text and the paths they have open. Not for anyone else on
    /// the machine, whatever the umask is feeling generous about.
    Private,
}

/// Replace the file at `path` with `bytes`.
///
/// # Errors
/// Any I/O error from writing the temporary file or swapping it in. On
/// Windows, a sharing violation from an indexer or sync client holding the
/// file is retried with backoff before it is reported.
pub fn replace(path: &Path, bytes: &[u8], create: Create) -> io::Result<()> {
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    // Read before anything is written: the target's own bits decide both how
    // private the temporary file has to be and what the result ends up as.
    let existing = fs::metadata(path).ok();
    let mut builder = tempfile::Builder::new();
    builder.prefix(".mdreader-").suffix(".tmp");
    #[cfg(unix)]
    if existing.is_none() && create == Create::AsUser {
        // A document the reader creates here should look like one they made
        // any other way: 0666 less the umask, the same as `touch`, a shell
        // redirect, or another editor. tempfile defaults to 0600, which is
        // right for a scratch file and wrong for a document -- a new note
        // would be unreadable to the group owning the folder it went into.
        //
        // The mode goes to `open`, so the *kernel* applies the umask and
        // this process never has to read it. That matters: reading it means
        // `umask(umask(0))`, a set-and-restore another thread can create a
        // file inside, which would leave this thread widening everyone
        // else's files for the length of the window.
        //
        // Only when there is nothing there. Where a target exists the
        // temporary file keeps the private 0600 until it is given that
        // target's bits below, so a 0600 document is never briefly legible
        // to anybody else.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    #[cfg(not(unix))]
    let _ = create; // Windows has no mode to ask for; ACLs come from the directory.
    let mut tmp = builder.tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    if let Some(meta) = existing {
        // Best effort: a read-only target still gets replaced, with its bits kept.
        let _ = fs::set_permissions(tmp.path(), meta.permissions());
    }
    platform::swap(tmp, path)?;
    sync_dir(dir);
    Ok(())
}

/// Flush the directory entry so the rename itself is durable. Best effort.
fn sync_dir(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(windows))]
mod platform {
    use std::io;
    use std::path::Path;

    use tempfile::NamedTempFile;

    pub fn swap(tmp: NamedTempFile, path: &Path) -> io::Result<()> {
        tmp.persist(path).map(|_| ()).map_err(|e| e.error)
    }
}

#[cfg(windows)]
mod platform {
    // `ReplaceFileW` is the one Win32 call in the crate. `std::fs::rename` is
    // `MoveFileExW`, which gives the target the temporary file's ACL instead
    // of the original's; `ReplaceFileW` keeps attributes and ACLs.
    #![allow(unsafe_code)]

    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    use tempfile::NamedTempFile;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    };
    use windows_sys::Win32::Storage::FileSystem::{REPLACEFILE_IGNORE_MERGE_ERRORS, ReplaceFileW};

    const ATTEMPTS: u32 = 12;

    fn wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn swap(tmp: NamedTempFile, path: &Path) -> io::Result<()> {
        let (file, tmp_path) = tmp.keep().map_err(|e| e.error)?;
        drop(file);
        let target = wide(path.as_os_str());
        let source = wide(tmp_path.as_os_str());
        let mut delay = Duration::from_millis(20);
        for attempt in 0..ATTEMPTS {
            // SAFETY: both strings are NUL-terminated UTF-16 buffers that outlive the call;
            // the remaining pointer arguments are documented as optional and passed null.
            let ok = unsafe {
                ReplaceFileW(
                    target.as_ptr(),
                    source.as_ptr(),
                    ptr::null(),
                    REPLACEFILE_IGNORE_MERGE_ERRORS,
                    ptr::null(),
                    ptr::null(),
                )
            };
            if ok != 0 {
                return Ok(());
            }
            let err = io::Error::last_os_error();
            let code = err.raw_os_error().and_then(|c| u32::try_from(c).ok());
            match code {
                Some(ERROR_FILE_NOT_FOUND) => {
                    return std::fs::rename(&tmp_path, path).map_err(|e| {
                        let _ = std::fs::remove_file(&tmp_path);
                        e
                    });
                }
                Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION) if attempt + 1 < ATTEMPTS => {
                    thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(400));
                }
                _ => {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(err);
                }
            }
        }
        let _ = std::fs::remove_file(&tmp_path);
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "file stayed locked",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mdreader-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    #[test]
    fn replaces_content_and_leaves_no_temp_file() {
        let path = temp_path("a.md");
        fs::write(&path, b"old").expect("fixture");
        replace(&path, b"new", Create::AsUser).expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"new");
        let leftovers: Vec<_> = fs::read_dir(path.parent().expect("dir"))
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".mdreader-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn creates_a_missing_file() {
        let path = temp_path("missing.md");
        let _ = fs::remove_file(&path);
        replace(&path, b"created", Create::AsUser).expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"created");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permission_bits() {
        let path = temp_path("perm.md");
        fs::write(&path, b"x").expect("fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod");
        replace(&path, b"y", Create::AsUser).expect("replace");
        assert_eq!(
            fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
            0o600
        );
    }

    /// The bug the Phase 1 gate found: every new document arrived at 0600,
    /// because that is the mode tempfile gives a scratch file and there was
    /// no target to take bits from.
    #[cfg(unix)]
    #[test]
    fn creates_a_new_file_as_openly_as_any_other() {
        let ours = temp_path("fresh.md");
        let theirs = temp_path("fresh-reference.md");
        let _ = fs::remove_file(&ours);
        let _ = fs::remove_file(&theirs);
        replace(&ours, b"new", Create::AsUser).expect("replace");
        // The reference is whatever the kernel gives anything else created
        // here, so this holds under any umask rather than naming 0644.
        fs::write(&theirs, b"new").expect("reference");
        let mode = |p: &Path| fs::metadata(p).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode(&ours), mode(&theirs));
    }

    /// Snapshots and session state hold the reader's own text; the umask is
    /// not consulted about those.
    #[cfg(unix)]
    #[test]
    fn creates_the_app_store_private() {
        let path = temp_path("store.json");
        let _ = fs::remove_file(&path);
        replace(&path, b"{}", Create::Private).expect("replace");
        assert_eq!(
            fs::metadata(&path).expect("meta").permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(windows)]
    #[test]
    fn retries_through_a_sharing_violation() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;
        let path = temp_path("locked.md");
        fs::write(&path, b"old").expect("fixture");
        let holder = path.clone();
        let lock = std::thread::spawn(move || {
            // Exclusive share mode: no other handle may open the file while this one lives.
            let file = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&holder)
                .expect("lock");
            std::thread::sleep(std::time::Duration::from_millis(150));
            drop(file);
        });
        replace(&path, b"new", Create::AsUser).expect("replace after retry");
        lock.join().expect("holder");
        assert_eq!(fs::read(&path).expect("read"), b"new");
    }
}
