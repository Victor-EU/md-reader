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
use std::path::{Path, PathBuf};

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
    // The link is not the file. Everything below writes beside the target
    // and renames over it, and a rename over a symlink replaces the link
    // itself -- so a reader whose `~/notes/todo.md` points into a synced
    // folder would find the link gone, a plain file in its place, and
    // yesterday's text still in the folder they thought they were writing
    // to. Nothing would tell them: the watcher is on the directory holding
    // the link, and the hash it reads back is the one it expects.
    let followed = target_of(path)?;
    let path = followed.as_deref().unwrap_or(path);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    // Read before anything is written: the target's own bits decide both how
    // private the temporary file has to be and what the result ends up as.
    let existing = fs::metadata(path).ok();
    let mut builder = tempfile::Builder::new();
    builder.prefix(".markdown-").suffix(".tmp");
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

/// How far a link is followed before the chain is called a loop. The
/// kernel gives up somewhere between eight and forty; a note behind more
/// than a handful of links is not a thing that happens.
const LINK_HOPS: u32 = 16;

/// The file a path really names, when the path is a symlink.
///
/// `None` for everything else, which is the ordinary case and the one
/// that must cost nothing: a path that is not a link is the file.
///
/// `canonicalize` answers this whenever it can, and it does the whole
/// path rather than the last component, which is what a link to a
/// directory needs. It cannot answer for a link whose target does not
/// exist yet -- a link into a folder that has not been made, or one
/// pointing at a file the reader is about to create -- and that is a
/// path this function must still resolve rather than replace, so the
/// chain is walked by hand instead.
fn target_of(path: &Path) -> io::Result<Option<PathBuf>> {
    if !is_link(path) {
        return Ok(None);
    }
    if let Ok(real) = fs::canonicalize(path) {
        return Ok(Some(real));
    }
    let mut current = path.to_path_buf();
    for _ in 0..LINK_HOPS {
        let link = fs::read_link(&current)?;
        current = if link.is_absolute() {
            link
        } else {
            current.parent().unwrap_or(Path::new(".")).join(link)
        };
        if !is_link(&current) {
            return Ok(Some(current));
        }
    }
    // A cycle, or a chain longer than any real one. There is no file at
    // the end of it, and the one thing this must not do is give up and
    // write over the link -- that is the defect, not the fallback. So it
    // fails where every other unwritable path fails, and the reader is
    // told their document did not save.
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "too many levels of symbolic links",
    ))
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
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
        ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
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
                // Nothing to replace, which is a file being created.
                // And the two ways `ReplaceFile` half-finishes: with no
                // backup name asked for -- and none is, above -- 1176
                // and 1177 both mean the target is already gone and what
                // we wrote is still there under its temporary name. That
                // makes the temporary file the only copy of the document
                // on disk, and the catch-all below used to delete it,
                // leaving the reader's file missing until the next save.
                // Renaming it into place is the recovery the contract
                // describes, and the same one a missing target takes.
                Some(
                    ERROR_FILE_NOT_FOUND
                    | ERROR_UNABLE_TO_MOVE_REPLACEMENT
                    | ERROR_UNABLE_TO_MOVE_REPLACEMENT_2,
                ) => {
                    return std::fs::rename(&tmp_path, path).inspect_err(|_| {
                        let _ = std::fs::remove_file(&tmp_path);
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
        let dir = std::env::temp_dir().join(format!("markdown-atomic-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    /// A directory this test has to itself.
    ///
    /// Tests run at once and `replace` writes a temporary file beside its
    /// target, so a test that looks at what is in a directory has to be
    /// the only one writing there -- otherwise it reads another test's
    /// half-finished save and calls it a leak.
    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("markdown-atomic-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn replaces_content_and_leaves_no_temp_file() {
        let path = temp_dir("leftovers").join("a.md");
        fs::write(&path, b"old").expect("fixture");
        replace(&path, b"new", Create::AsUser).expect("replace");
        assert_eq!(fs::read(&path).expect("read"), b"new");
        let leftovers: Vec<_> = fs::read_dir(path.parent().expect("dir"))
            .expect("dir")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(".markdown-"))
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

    /// A note reached through a symlink -- the dotfile and vault setups
    /// this app is for are full of them -- is the file at the other end,
    /// not the link. Writing the link away is silent: the reader sees a
    /// saved document and the folder they sync still holds the old text.
    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_and_leaves_the_link_alone() {
        let target = temp_dir("symlink").join("linked-target.md");
        let link = temp_dir("symlink").join("linked.md");
        let _ = fs::remove_file(&link);
        fs::write(&target, b"old").expect("fixture");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        replace(&link, b"new", Create::AsUser).expect("replace");
        assert!(
            fs::symlink_metadata(&link)
                .expect("meta")
                .file_type()
                .is_symlink(),
            "the link itself was replaced by a plain file"
        );
        assert_eq!(fs::read(&target).expect("read"), b"new");
    }

    /// The same for a link pointing at a file that is not there yet, which
    /// `canonicalize` cannot answer for.
    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlink_whose_target_is_missing() {
        let target = temp_dir("dangling").join("dangling-target.md");
        let link = temp_dir("dangling").join("dangling.md");
        let _ = fs::remove_file(&link);
        let _ = fs::remove_file(&target);
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        replace(&link, b"new", Create::AsUser).expect("replace");
        assert!(
            fs::symlink_metadata(&link)
                .expect("meta")
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(&target).expect("read"), b"new");
    }

    /// A link to a link. One hop is the common case and the loop is what
    /// keeps a cycle from hanging the save.
    #[cfg(unix)]
    #[test]
    fn follows_a_chain_of_symlinks() {
        let target = temp_dir("chain").join("chain-target.md");
        let middle = temp_dir("chain").join("chain-middle.md");
        let link = temp_dir("chain").join("chain.md");
        for path in [&middle, &link] {
            let _ = fs::remove_file(path);
        }
        fs::write(&target, b"old").expect("fixture");
        std::os::unix::fs::symlink(&target, &middle).expect("symlink");
        std::os::unix::fs::symlink(&middle, &link).expect("symlink");
        replace(&link, b"new", Create::AsUser).expect("replace");
        assert_eq!(fs::read(&target).expect("read"), b"new");
        assert!(
            fs::symlink_metadata(&middle)
                .expect("meta")
                .file_type()
                .is_symlink()
        );
    }

    /// A cycle has no file at the end of it. The save fails rather than
    /// spinning, and it fails where every other unwritable path does.
    #[cfg(unix)]
    #[test]
    fn a_symlink_loop_is_not_followed_forever() {
        let a = temp_dir("loop").join("loop-a.md");
        let b = temp_dir("loop").join("loop-b.md");
        for path in [&a, &b] {
            let _ = fs::remove_file(path);
        }
        std::os::unix::fs::symlink(&b, &a).expect("symlink");
        std::os::unix::fs::symlink(&a, &b).expect("symlink");
        assert!(replace(&a, b"new", Create::AsUser).is_err());
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
