//! Settings and the session: the two JSON files the app keeps for itself
//! (design 4.1, plan WP 1.8).
//!
//! Both are written the same way and for the same reason. The session
//! changes whenever a tab does, and an untitled document lives in it, so
//! writing on every change would be a write per keystroke. A [`Store`]
//! holds the newest value in memory and lets at most one write an
//! interval reach the disk; whoever needs the value now — the routing of
//! a file the OS just handed us — reads it from memory and never waits.
//!
//! The write is the same atomic replace a document gets: the session file
//! is what a launch trusts, so a crash in the middle of one must leave
//! the previous session rather than half of the new one.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::atomic;
use crate::document::Error;

/// How often a store may touch the disk. Long enough that a burst of tab
/// changes is one write, short enough that a power cut costs a second of
/// what the reader was doing.
pub const INTERVAL: Duration = Duration::from_secs(1);

// --- what is stored ---------------------------------------------------------

/// Whether the window follows the system or was told which to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

/// The page's own background (design 11), which is a setting of its own
/// rather than a consequence of light or dark: paper colour changes
/// reading comfort more than most people expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    #[default]
    White,
    Cream,
    /// A yellow legal pad.
    Pad,
    /// The high-contrast one, dark in a light window as well as a dark.
    Black,
}

/// Which of the three bundled families the page is set in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    #[default]
    Sans,
    Serif,
    Mono,
}

/// What the reading size may be, in CSS pixels. The step is the zoom
/// (design 4.5): Cmd+= and Cmd+- move along it and nowhere else, so a
/// zoomed window is always a size the type scale was drawn for.
pub const SIZES: [u32; 11] = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28];
pub const DEFAULT_SIZE: u32 = 16;
/// Design 11 asks for a measure around 68 characters. The ends are where
/// a line stops being one: too short to hold a clause, too long to find
/// the next one.
pub const MEASURE_RANGE: (u32, u32) = (45, 110);
pub const DEFAULT_MEASURE: u32 = 68;

/// Preferences that outlive every window (design 11, design 6.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Settings {
    /// Design 6.6: on, because the file on disk is the channel to the AI
    /// and an unsaved buffer is a state the AI cannot see.
    pub autosave: bool,
    pub appearance: Appearance,
    pub paper: Paper,
    pub family: Family,
    /// Reading size in CSS pixels; one of [`SIZES`].
    pub size: u32,
    /// Line length in characters, within [`MEASURE_RANGE`].
    pub measure: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            autosave: true,
            appearance: Appearance::default(),
            paper: Paper::default(),
            family: Family::default(),
            size: DEFAULT_SIZE,
            measure: DEFAULT_MEASURE,
        }
    }
}

impl Settings {
    /// The same preferences with the two numbers made possible again.
    ///
    /// The settings file is a file: it can be edited by hand, written by
    /// an older build, or half-written by a crash. A size of zero would
    /// give a window nobody can read their way out of, so the numbers are
    /// put back on the scale on the way in and on the way out.
    #[must_use]
    pub fn clamped(self) -> Self {
        let size = SIZES
            .iter()
            .copied()
            .min_by_key(|step| step.abs_diff(self.size))
            .unwrap_or(DEFAULT_SIZE);
        Self {
            size,
            measure: self.measure.clamp(MEASURE_RANGE.0, MEASURE_RANGE.1),
            ..self
        }
    }
}

/// Which projection of a document a tab was showing (design 4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TabMode {
    #[default]
    Read,
    Edit,
    Source,
}

/// A selection, in UTF-16 offsets like every other position on the IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
pub struct Cursor {
    pub anchor: u32,
    pub head: u32,
}

/// A window's frame in physical pixels, so it comes back where it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// An untitled document: a buffer with nowhere else to be kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Untitled {
    pub name: String,
    pub text: String,
}

/// One open document. Exactly one of the two fields is set: a file is
/// read again from disk on restore, an untitled document is carried in
/// the session file because losing it would lose the only copy.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct DocumentState {
    pub path: Option<PathBuf>,
    pub untitled: Option<Untitled>,
}

/// What a tab is showing. Settings open as a tab rather than a modal
/// (plan WP 1.9), so not every tab has a document behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    #[default]
    Document,
    Settings,
}

/// One tab: a view onto a document, with the state that is per view
/// (design 6.5).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct TabState {
    pub kind: TabKind,
    /// Index into the window's `documents`. Two tabs naming the same one
    /// restore as two views of one buffer, sharing undo.
    pub document: u32,
    pub mode: TabMode,
    pub pinned: bool,
    /// The tab that was in front. The first one marked wins.
    pub active: bool,
    pub selection: Cursor,
    /// Where the view was scrolled, as a source offset. A character
    /// survives a change of window width; a pixel offset does not.
    pub anchor: u32,
    /// Heading ids folded in Read mode.
    pub folded: Vec<String>,
}

/// What a window's own webview knows about itself. The frontend owns
/// every field; the label and the frame are the window manager's.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct WindowContent {
    pub documents: Vec<DocumentState>,
    pub tabs: Vec<TabState>,
    pub sidebar: bool,
    /// Whether Read mode was showing the comments it folds away (4.3).
    pub comments: bool,
}

/// One window of the session.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct WindowState {
    /// The Tauri window label. Phase 1 has one window; keying by label is
    /// what lets Phase 2 add a second without changing this shape.
    pub label: String,
    pub bounds: Option<Bounds>,
    pub content: WindowContent,
}

/// Everything a launch restores (design 4.1).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Session {
    pub windows: Vec<WindowState>,
    /// Files the reader has opened, newest first: what Cmd+P offers.
    pub recents: Vec<PathBuf>,
}

/// What a window asks for when it starts.
///
/// One round trip: the tabs it had, the files it has been opening, and
/// the preferences, all of which it needs before it draws anything.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
pub struct Restore {
    /// `None` on a first launch, and after a session file that would not
    /// parse: both mean a window with nothing to put back.
    pub content: Option<WindowContent>,
    pub recents: Vec<PathBuf>,
    pub settings: Settings,
}

impl Session {
    /// Which window has `path` open, if any.
    ///
    /// This is the registry design 6.5 asks for: a file the OS hands us
    /// goes to the window that already shows it, so double-clicking a
    /// file twice focuses one tab instead of opening two.
    #[must_use]
    pub fn window_with(&self, path: &Path) -> Option<&str> {
        self.windows
            .iter()
            .find(|window| {
                window
                    .content
                    .documents
                    .iter()
                    .any(|doc| doc.path.as_deref() == Some(path))
            })
            .map(|window| window.label.as_str())
    }

    /// Replace one window's entry, keeping the others.
    pub fn put_window(&mut self, state: WindowState) {
        match self
            .windows
            .iter_mut()
            .find(|window| window.label == state.label)
        {
            Some(existing) => *existing = state,
            None => self.windows.push(state),
        }
    }

    /// One window's entry by label.
    #[must_use]
    pub fn window(&self, label: &str) -> Option<&WindowState> {
        self.windows.iter().find(|window| window.label == label)
    }
}

// --- the store --------------------------------------------------------------

struct Slot<T> {
    value: T,
    /// Set when `value` has changed since the last write.
    dirty: bool,
    stop: bool,
    /// Writes that have reached the disk, which is what the tests count.
    writes: u64,
}

struct Shared<T> {
    /// `None` for a store with nowhere to write, which is what the app
    /// falls back to when the OS gives it no config directory. The value
    /// still lives, so the running window behaves; only the next launch
    /// is poorer for it.
    path: Option<PathBuf>,
    interval: Duration,
    slot: Mutex<Slot<T>>,
    wake: Condvar,
}

/// A JSON file that holds the newest value, writes it whole, and writes
/// it at most once an interval.
pub struct Store<T: Send + 'static> {
    shared: Arc<Shared<T>>,
    writer: Option<JoinHandle<()>>,
}

impl<T> Store<T>
where
    T: Serialize + DeserializeOwned + Default + Clone + Send + 'static,
{
    /// Open the store at `path`, at the default interval.
    #[must_use]
    pub fn open(path: PathBuf) -> Self {
        Self::new(Some(path), INTERVAL)
    }

    /// A store that keeps its value and writes nothing.
    #[must_use]
    pub fn memory() -> Self {
        Self::new(None, INTERVAL)
    }

    /// Open the store at `path`, writing no more than once every
    /// `interval`. The tests use this to watch the throttle work.
    #[must_use]
    pub fn every(path: PathBuf, interval: Duration) -> Self {
        Self::new(Some(path), interval)
    }

    fn new(path: Option<PathBuf>, interval: Duration) -> Self {
        if let Some(dir) = path.as_deref().and_then(Path::parent)
            && let Err(error) = fs::create_dir_all(dir)
        {
            eprintln!("cannot create {}: {error}", dir.display());
        }
        let value = path.as_deref().map(read).unwrap_or_default();
        let shared = Arc::new(Shared {
            path,
            interval,
            slot: Mutex::new(Slot {
                value,
                dirty: false,
                stop: false,
                writes: 0,
            }),
            wake: Condvar::new(),
        });
        let writer = Arc::clone(&shared);
        Self {
            shared,
            writer: Some(thread::spawn(move || run(&writer))),
        }
    }

    /// The newest value, written or not.
    #[must_use]
    pub fn get(&self) -> T {
        self.locked().value.clone()
    }

    /// Record a new value. The write follows within the interval.
    pub fn set(&self, value: T) {
        let mut slot = self.locked();
        slot.value = value;
        slot.dirty = true;
        self.shared.wake.notify_all();
    }

    /// Change the value in place, for callers that only touch a field.
    pub fn update(&self, change: impl FnOnce(&mut T)) {
        let mut slot = self.locked();
        change(&mut slot.value);
        slot.dirty = true;
        self.shared.wake.notify_all();
    }

    /// Write now, on this thread. What a window close and an exit call.
    ///
    /// # Errors
    /// Any I/O error from replacing the file.
    pub fn flush(&self) -> Result<(), Error> {
        let mut slot = self.locked();
        if slot.dirty {
            self.shared.write(&mut slot)?;
        }
        Ok(())
    }

    /// How many writes have reached the disk.
    #[must_use]
    pub fn writes(&self) -> u64 {
        self.locked().writes
    }

    fn locked(&self) -> std::sync::MutexGuard<'_, Slot<T>> {
        // A panic in a closure passed to `update` is the only way to
        // poison this, and the value behind it is still the last one the
        // caller set. Losing the session over that would be worse.
        self.shared
            .slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl<T> Shared<T>
where
    T: Serialize + Send + 'static,
{
    /// Serialize and replace the file, holding the lock throughout.
    ///
    /// The lock is held over the write so two writers cannot swap an old
    /// value in behind a new one. It costs a `set` from a command handler
    /// the length of one small atomic write, which is what the throttle
    /// keeps rare.
    fn write(&self, slot: &mut Slot<T>) -> Result<(), Error> {
        slot.dirty = false;
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        let json = serde_json::to_vec_pretty(&slot.value).map_err(|error| Error::Write {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
        atomic::replace(path, &json, atomic::Create::Private).map_err(|error| Error::Write {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
        slot.writes += 1;
        Ok(())
    }
}

/// The writer thread: write what is pending, then stay quiet for the
/// interval. A burst of changes in between is one write of the last one.
fn run<T>(shared: &Arc<Shared<T>>)
where
    T: Serialize + Send + 'static,
{
    loop {
        let mut slot = shared
            .slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !slot.dirty && !slot.stop {
            slot = shared
                .wake
                .wait(slot)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if slot.dirty
            && let Err(error) = shared.write(&mut slot)
        {
            eprintln!("cannot write app state: {error}");
        }
        if slot.stop {
            return;
        }
        // The rate limit, interruptible so a shutdown does not wait it out.
        let _unused = shared
            .wake
            .wait_timeout_while(slot, shared.interval, |slot| !slot.stop)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

impl<T: Send + 'static> Drop for Store<T> {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.shared.slot.lock() {
            slot.stop = true;
        }
        self.shared.wake.notify_all();
        if let Some(writer) = self.writer.take() {
            let _unused = writer.join();
        }
    }
}

/// Read the file, or start fresh.
///
/// A file that will not parse is moved aside rather than deleted: it is
/// the reader's last session, and if we ever lose one it should be
/// possible to see why.
fn read<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(text) = fs::read_to_string(path) else {
        return T::default();
    };
    match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            let aside = path.with_extension("json.bad");
            eprintln!(
                "{} is not readable ({error}); keeping it as {}",
                path.display(),
                aside.display()
            );
            let _unused = fs::rename(path, &aside);
            T::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdreader-state-{}-{name}-{:?}",
            std::process::id(),
            thread::current().id()
        ));
        let _unused = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn session(paths: &[&str]) -> Session {
        Session {
            windows: vec![WindowState {
                label: "main".to_owned(),
                bounds: None,
                content: WindowContent {
                    documents: paths
                        .iter()
                        .map(|path| DocumentState {
                            path: Some(PathBuf::from(path)),
                            untitled: None,
                        })
                        .collect(),
                    ..WindowContent::default()
                },
            }],
            recents: paths.iter().map(PathBuf::from).collect(),
        }
    }

    #[test]
    fn a_flush_writes_what_was_set() {
        let path = dir("flush").join("session.json");
        let store = Store::open(path.clone());
        store.set(session(&["/a/one.md"]));
        store.flush().expect("flush");
        let back: Session =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("parse");
        assert_eq!(back, session(&["/a/one.md"]));
    }

    #[test]
    fn reopening_reads_what_was_written() {
        let path = dir("round-trip").join("session.json");
        {
            let store = Store::open(path.clone());
            store.set(session(&["/a/one.md", "/a/two.md"]));
            store.flush().expect("flush");
        }
        let store: Store<Session> = Store::open(path);
        assert_eq!(store.get(), session(&["/a/one.md", "/a/two.md"]));
    }

    #[test]
    fn a_burst_of_changes_is_one_write_of_the_last_one() {
        let path = dir("throttle").join("session.json");
        // Long enough that nothing lands on its own during the burst.
        let store = Store::every(path.clone(), Duration::from_secs(30));
        for n in 0..50 {
            store.set(session(&[&format!("/a/{n}.md")]));
        }
        store.flush().expect("flush");
        assert!(
            store.writes() <= 2,
            "fifty changes cost {} writes",
            store.writes()
        );
        let back: Session =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("parse");
        assert_eq!(back, session(&["/a/49.md"]));
    }

    #[test]
    fn the_last_value_lands_without_a_flush() {
        let path = dir("trailing").join("session.json");
        let store = Store::every(path.clone(), Duration::from_millis(20));
        store.set(session(&["/a/one.md"]));
        for _ in 0..100 {
            if store.writes() > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(store.writes(), 1, "nothing was written on its own");
        // Dropped after the assertion, so what is on disk is the writer
        // thread's work and not the flush that a drop also does.
        drop(store);
        let back: Session =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("parse");
        assert_eq!(back, session(&["/a/one.md"]));
    }

    #[test]
    fn dropping_the_store_writes_what_is_pending() {
        let path = dir("drop").join("session.json");
        {
            let store = Store::every(path.clone(), Duration::from_secs(30));
            store.set(session(&["/a/one.md"]));
        }
        let back: Session =
            serde_json::from_str(&fs::read_to_string(&path).expect("read")).expect("parse");
        assert_eq!(back, session(&["/a/one.md"]));
    }

    #[test]
    fn a_file_that_will_not_parse_is_kept_and_the_app_starts_fresh() {
        let path = dir("corrupt").join("session.json");
        fs::write(&path, b"{\"windows\": [ truncated").expect("fixture");
        let store: Store<Session> = Store::open(path.clone());
        assert_eq!(store.get(), Session::default());
        assert!(path.with_extension("json.bad").exists());
    }

    #[test]
    fn settings_default_to_autosave_on() {
        let path = dir("settings").join("settings.json");
        let store: Store<Settings> = Store::open(path);
        assert_eq!(store.get(), Settings::default());
        assert!(store.get().autosave);
    }

    #[test]
    fn settings_start_on_white_paper_at_a_readable_size() {
        let settings = Settings::default();
        assert_eq!(settings.appearance, Appearance::System);
        assert_eq!(settings.paper, Paper::White);
        assert_eq!(settings.family, Family::Sans);
        assert_eq!(settings.size, DEFAULT_SIZE);
        assert_eq!(settings.measure, DEFAULT_MEASURE);
    }

    /// A file that has been edited by hand, or written by a build that
    /// used a different scale, still has to open a window.
    #[test]
    fn a_size_that_is_not_on_the_scale_moves_to_the_nearest_one() {
        let odd = Settings {
            size: 19,
            measure: 4000,
            ..Settings::default()
        };
        let sane = odd.clamped();
        assert_eq!(sane.size, 18);
        assert_eq!(sane.measure, MEASURE_RANGE.1);
        assert_eq!(
            Settings {
                size: 0,
                ..Settings::default()
            }
            .clamped()
            .size,
            SIZES[0]
        );
    }

    #[test]
    fn a_settings_file_written_before_the_theme_still_reads() {
        let path = dir("old-settings").join("settings.json");
        fs::write(&path, br#"{"autosave":false}"#).expect("fixture");
        let store: Store<Settings> = Store::open(path);
        let settings = store.get();
        assert!(!settings.autosave);
        assert_eq!(settings.paper, Paper::White);
        assert_eq!(settings.size, DEFAULT_SIZE);
    }

    #[test]
    fn a_missing_field_takes_its_default() {
        let path = dir("partial").join("settings.json");
        fs::write(&path, b"{}").expect("fixture");
        let store: Store<Settings> = Store::open(path);
        assert!(store.get().autosave);
    }

    #[test]
    fn a_store_with_nowhere_to_write_still_holds_its_value() {
        let store: Store<Settings> = Store::memory();
        store.set(Settings {
            autosave: false,
            ..Settings::default()
        });
        store.flush().expect("flush");
        assert!(!store.get().autosave);
        assert_eq!(store.writes(), 0);
    }

    #[test]
    fn a_file_goes_to_the_window_that_has_it_open() {
        let mut all = session(&["/a/one.md"]);
        all.windows.push(WindowState {
            label: "second".to_owned(),
            bounds: None,
            content: WindowContent {
                documents: vec![DocumentState {
                    path: Some(PathBuf::from("/a/two.md")),
                    untitled: None,
                }],
                ..WindowContent::default()
            },
        });
        assert_eq!(all.window_with(Path::new("/a/two.md")), Some("second"));
        assert_eq!(all.window_with(Path::new("/a/one.md")), Some("main"));
        assert_eq!(all.window_with(Path::new("/a/three.md")), None);
    }

    #[test]
    fn putting_a_window_replaces_only_that_one() {
        let mut all = session(&["/a/one.md"]);
        all.put_window(WindowState {
            label: "second".to_owned(),
            ..WindowState::default()
        });
        all.put_window(WindowState {
            label: "main".to_owned(),
            bounds: Some(Bounds {
                x: 10,
                y: 20,
                width: 800,
                height: 600,
            }),
            ..WindowState::default()
        });
        assert_eq!(all.windows.len(), 2);
        assert_eq!(
            all.window("main").and_then(|window| window.bounds),
            Some(Bounds {
                x: 10,
                y: 20,
                width: 800,
                height: 600
            })
        );
    }
}
