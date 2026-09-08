//! Watching open files for writes by other processes (design 7.2, plan
//! WP 1.7).
//!
//! Two things make this less work than it sounds. The first is that the
//! watch is on the *folder*, not the file: an editor that saves by writing
//! a temporary file and renaming it over the target destroys the thing a
//! file watch was attached to, and a folder watch sees the rename. The
//! second is that the events are only ever used to decide *where* to
//! look. After the debounce the file is read again and compared with what
//! we last saw, so a write that arrived as truncate, then write, then
//! chmod is one change, and a write that undid itself is none.
//!
//! Our own saves come back through the same folder watch. They are
//! recognized by the hash of the bytes, which is the same token `open`
//! and `save` already speak in.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::file_id::{FileId, get_file_id};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};

use crate::diff::edits;
use crate::document::{Error, read_document};
use crate::eol;
use crate::types::ExternalChange;

/// Long enough that a tool writing in several steps is seen once, short
/// enough that a save in another window feels immediate.
const DEBOUNCE: Duration = Duration::from_millis(100);

/// What the watcher has to say about a file someone else touched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// The file was written by somebody else, with the edits from what we
    /// last saw to what is there now.
    Changed(ExternalChange),
    /// The file is gone. The buffer stays open and the next save
    /// recreates it (design 8).
    Removed { path: PathBuf },
    /// The file was renamed. It is still watched, under its new name:
    /// the destination is somewhere we could see it land, which means
    /// somewhere we are already watching.
    Renamed { from: PathBuf, to: PathBuf },
}

/// A watched file as we last saw it on disk.
struct Known {
    /// The path the caller asked for, which is the one it knows the
    /// document by and the one every event carries back.
    given: PathBuf,
    /// The file the way the editor holds it: decoded, and LF whatever the
    /// file uses, because that is what the offsets we send are counted in.
    text: String,
    /// Hash of the bytes. Equal means this write was ours.
    hash: String,
    /// True once we have reported it missing, so we say so only once.
    gone: bool,
    /// What the filesystem calls this file, which survives a rename and
    /// is how a file that left is recognized where it landed.
    id: Option<FileId>,
}

#[derive(Default)]
struct Watched {
    files: HashMap<PathBuf, Known>,
    /// How many watched files each folder holds, so the last one out
    /// turns the folder watch off.
    dirs: HashMap<PathBuf, usize>,
}

impl Watched {
    /// Read a file again and say what changed since we last looked.
    fn refresh(&mut self, key: &Path) -> Option<WatchEvent> {
        let known = self.files.get_mut(key)?;
        let path = known.given.clone();
        let Ok(document) = read_document(&path) else {
            // Unreadable for a moment during someone else's write is not
            // the same as gone; only the missing file is worth saying.
            if path.exists() || known.gone {
                return None;
            }
            known.gone = true;
            return Some(WatchEvent::Removed { path });
        };
        known.gone = false;
        known.id = get_file_id(&path).ok();
        if document.meta.hash == known.hash {
            return None;
        }
        let text = eol::normalize_lf(&document.content);
        let changes = edits(&known.text, &text);
        known.text.clone_from(&text);
        known.hash.clone_from(&document.meta.hash);
        Some(WatchEvent::Changed(ExternalChange {
            path,
            content: text,
            hash: document.meta.hash,
            changes,
        }))
    }

    /// What became of a watched file the events pointed at.
    ///
    /// A file that is no longer there may have been renamed: the
    /// filesystem's own id for it survives the move, so a file that just
    /// appeared in the folder with that id is the same document under a
    /// new name.
    fn settle(&mut self, key: &Path, appeared: &[PathBuf]) -> Option<WatchEvent> {
        let known = self.files.get(key)?;
        if !known.given.exists()
            && let Some(id) = known.id
            && let Some(to) = appeared
                .iter()
                .find(|path| get_file_id(path).is_ok_and(|other| other == id))
        {
            return Some(self.moved(key, to));
        }
        self.refresh(key)
    }

    /// Follow a watched file to its new name.
    ///
    /// A destination we can see is a destination inside a folder we are
    /// already watching — that is how we saw it — so the file keeps its
    /// place in the count and only its key changes.
    fn moved(&mut self, key: &Path, to: &Path) -> WatchEvent {
        let mut from = key.to_path_buf();
        if let Some(mut known) = self.files.remove(key) {
            from = std::mem::replace(&mut known.given, to.to_path_buf());
            self.files.insert(resolved(to), known);
        }
        WatchEvent::Renamed {
            from,
            to: to.to_path_buf(),
        }
    }

    /// Forget a file, and say whether its folder is now unwatched.
    fn forget(&mut self, key: &Path) -> Option<PathBuf> {
        self.files.remove(key)?;
        let dir = folder(key)?;
        let count = self.dirs.get_mut(&dir)?;
        *count -= 1;
        if *count == 0 {
            self.dirs.remove(&dir);
            return Some(dir);
        }
        None
    }
}

fn folder(path: &Path) -> Option<PathBuf> {
    path.parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

/// The path the platform will name in its events.
///
/// A folder reached through a symlink is watched at its real location —
/// on macOS every temporary folder is one of those — and the events come
/// back with the resolved path. The map is keyed by this so they match;
/// what the caller hears is always the path it asked for.
fn resolved(path: &Path) -> PathBuf {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return path.to_path_buf();
    };
    dir.canonicalize()
        .map_or_else(|_| path.to_path_buf(), |dir| dir.join(name))
}

/// Turn one batch of debounced events into what the app should hear.
fn react(watched: &Mutex<Watched>, events: &[DebouncedEvent]) -> Vec<WatchEvent> {
    let Ok(mut watched) = watched.lock() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut named: Vec<PathBuf> = Vec::new();
    let mut appeared: Vec<PathBuf> = Vec::new();
    let mut folders: Vec<PathBuf> = Vec::new();
    for event in events {
        // Where the platform pairs the two halves of a rename itself,
        // that is the whole answer and the cheapest one.
        if matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::Both))
        ) && let [from, to] = &event.paths[..]
            && watched.files.contains_key(from)
        {
            named.retain(|path| path != from);
            out.push(watched.moved(from, to));
            continue;
        }
        for path in &event.paths {
            let list = if watched.files.contains_key(path) {
                &mut named
            } else {
                &mut appeared
            };
            if !list.contains(path) {
                list.push(path.clone());
            }
            if let Some(dir) = folder(path)
                && watched.dirs.contains_key(&dir)
                && !folders.contains(&dir)
            {
                folders.push(dir);
            }
        }
    }
    // macOS reports a rename only where the file landed, so a watched
    // file can leave without being named at all. Anything in a folder
    // this batch touched is worth a look; looking is a `stat`.
    let vanished: Vec<PathBuf> = watched
        .files
        .iter()
        .filter(|(key, known)| {
            !named.contains(key)
                && folder(key).is_some_and(|dir| folders.contains(&dir))
                && !known.given.exists()
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in named.into_iter().chain(vanished) {
        out.extend(watched.settle(&key, &appeared));
    }
    out
}

/// The folder watches behind the open documents.
pub struct Watcher {
    watched: Arc<Mutex<Watched>>,
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl Watcher {
    /// Start watching nothing, reporting to `sink` from the debouncer's
    /// own thread.
    ///
    /// # Errors
    /// Fails when the platform watcher cannot be created.
    pub fn new(sink: impl Fn(WatchEvent) + Send + 'static) -> Result<Self, Error> {
        let watched = Arc::new(Mutex::new(Watched::default()));
        let shared = Arc::clone(&watched);
        let debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            // An error here means the platform dropped events, not that a
            // file changed. The next write re-reads from disk anyway, so
            // there is nothing to report and nothing to repair.
            if let Ok(events) = result {
                for event in react(&shared, &events) {
                    sink(event);
                }
            }
        })
        .map_err(|error| Error::Unavailable {
            what: "the file watcher".to_owned(),
            message: error.to_string(),
        })?;
        Ok(Self { watched, debouncer })
    }

    /// Watch a file, taking what is on disk now as the baseline.
    ///
    /// # Errors
    /// Fails when the file cannot be read or its folder cannot be watched.
    pub fn watch(&mut self, path: &Path) -> Result<(), Error> {
        let dir = folder(path).ok_or_else(|| Error::Read {
            path: path.to_path_buf(),
            message: "no folder to watch".to_owned(),
        })?;
        let document = read_document(path)?;
        let key = resolved(path);
        let dir = folder(&key).unwrap_or(dir);
        let mut watched = self.lock()?;
        let fresh = !watched.files.contains_key(&key);
        watched.files.insert(
            key,
            Known {
                given: path.to_path_buf(),
                text: eol::normalize_lf(&document.content),
                hash: document.meta.hash,
                gone: false,
                id: get_file_id(path).ok(),
            },
        );
        if fresh {
            let count = watched.dirs.entry(dir.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                drop(watched);
                self.debouncer
                    .watch(&dir, RecursiveMode::NonRecursive)
                    .map_err(|error| Error::Read {
                        path: dir,
                        message: error.to_string(),
                    })?;
            }
        }
        Ok(())
    }

    /// Stop watching a file.
    ///
    /// # Errors
    /// Fails only when the lock is poisoned; an unwatch the platform
    /// refuses is nothing the caller can act on.
    pub fn unwatch(&mut self, path: &Path) -> Result<(), Error> {
        let dropped = self.lock()?.forget(&resolved(path));
        if let Some(dir) = dropped {
            let _ = self.debouncer.unwatch(&dir);
        }
        Ok(())
    }

    /// Take the file as it is now as the baseline, so the event our own
    /// save is about to produce is recognized as ours.
    ///
    /// `hash` is what the save reported. If the file no longer has it
    /// somebody else wrote in the moment between, so the old baseline is
    /// left alone and their write is still reported.
    ///
    /// # Errors
    /// Fails only when the lock is poisoned.
    pub fn note_write(&mut self, path: &Path, hash: &str) -> Result<(), Error> {
        let Ok(document) = read_document(path) else {
            return Ok(());
        };
        if document.meta.hash != hash {
            return Ok(());
        }
        let key = resolved(path);
        let mut watched = self.lock()?;
        if let Some(known) = watched.files.get_mut(&key) {
            known.text = eol::normalize_lf(&document.content);
            known.hash = document.meta.hash;
            known.gone = false;
            known.id = get_file_id(path).ok();
        }
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Watched>, Error> {
        self.watched.lock().map_err(|_| Error::Unavailable {
            what: "the file watcher".to_owned(),
            message: "its state was left locked by a panic".to_owned(),
        })
    }
}
