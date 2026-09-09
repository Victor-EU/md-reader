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
use crate::document::{DocumentMeta, Error};

/// How often a store may touch the disk. Long enough that a burst of tab
/// changes is one write, short enough that a power cut costs a second of
/// what the reader was doing.
pub const INTERVAL: Duration = Duration::from_secs(1);

/// How many recent files the session keeps. The window offers a list
/// nobody scrolls to the end of; this is the cap on what several windows
/// merged together may come to.
const RECENTS: usize = 50;

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

/// Which of the four curated themes of design 11 the window is dressed
/// in. The colours themselves are a JSON file per theme in the theme
/// package; this is only which of them the reader picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemeId {
    #[default]
    One,
    Slate,
    Ink,
    Grove,
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
    pub theme: ThemeId,
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
            theme: ThemeId::default(),
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

/// How many documents may have reading settings of their own. Each entry
/// is a path and four small fields; the cap is here so a store nobody
/// ever prunes cannot grow without an end.
const OVERRIDES: usize = 200;

/// What one document was given to be read in, instead of what the app
/// was told (design 11).
///
/// Every field is optional, and an override says only what it changes:
/// a reader who gave one report a serif has not also frozen its size at
/// today's. Theme and appearance are not here on purpose — they dress
/// the window, and a window whose toolbar changed colour as the reader
/// moved between tabs would be answering a question nobody asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Override {
    pub paper: Option<Paper>,
    pub family: Option<Family>,
    pub size: Option<u32>,
    pub measure: Option<u32>,
}

impl Override {
    /// Whether this says nothing, which is how the reader clears one.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self == Self::default()
    }

    /// The same override with the two numbers made possible again, on
    /// the same scale [`Settings::clamped`] uses.
    #[must_use]
    pub fn clamped(self) -> Self {
        let whole = Settings {
            size: self.size.unwrap_or(DEFAULT_SIZE),
            measure: self.measure.unwrap_or(DEFAULT_MEASURE),
            ..Settings::default()
        }
        .clamped();
        Self {
            size: self.size.map(|_| whole.size),
            measure: self.measure.map(|_| whole.measure),
            ..self
        }
    }
}

/// One document's own reading settings, and the path they belong to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DocumentOverride {
    pub path: PathBuf,
    pub reading: Override,
}

/// The overrides, newest first (design 11).
///
/// A list rather than a map, because the order is what the cap needs:
/// the document a reader last set something for is the one worth
/// keeping. Lookup is a scan of at most [`OVERRIDES`] entries, on a path
/// that is already being opened from disk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Overrides {
    pub documents: Vec<DocumentOverride>,
}

impl Overrides {
    /// What this document is read in, or nothing said at all.
    #[must_use]
    pub fn get(&self, path: &Path) -> Override {
        self.documents
            .iter()
            .find(|entry| entry.path == path)
            .map(|entry| entry.reading)
            .unwrap_or_default()
    }

    /// Give this document its own settings, or take them away.
    ///
    /// An override that says nothing is removed rather than stored: the
    /// reader who put everything back is not asking to be remembered.
    pub fn set(&mut self, path: PathBuf, reading: Override) {
        self.documents.retain(|entry| entry.path != path);
        if reading.is_empty() {
            return;
        }
        self.documents.insert(
            0,
            DocumentOverride {
                path,
                reading: reading.clamped(),
            },
        );
        self.documents.truncate(OVERRIDES);
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

/// Which of the sidebar's panels was showing (design 4.1, 4.4).
///
/// `Files` is the folder tree, and the recent files when no folder is
/// open; it is where a window with a folder starts. `Outline` is the
/// default without one, because a window with one document open has
/// nothing to put in a tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SidebarPanel {
    Files,
    #[default]
    Outline,
    History,
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
    /// The folder this window had open (plan WP 2.4), which it opens
    /// again on the next launch. A folder that has since been moved or
    /// deleted is simply not there any more; the window opens without
    /// one, and its tabs are unaffected.
    pub folder: Option<PathBuf>,
    pub sidebar: bool,
    /// Which panel the sidebar was showing (design 4.4).
    pub panel: SidebarPanel,
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

/// A tab on its way from one window to another (design 6.5, plan WP 2.5).
///
/// Each window is its own webview, so a document cannot be shared
/// between two of them: moving one moves it, with its view state and its
/// undo history. This is everything the window taking it in needs to put
/// back what left the other one.
///
/// Rust is the courier and not a reader of this. `state` is the editor's
/// own serialization — its buffer, its selection and its undo history —
/// and only the window that wrote it knows its shape.
///
/// Every field is required, unlike the session's: this never lives on
/// disk to be read by a later version of the app, it is one running
/// window handing something to another, and a field left out would be a
/// window losing part of what it was given.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
pub struct TabMove {
    pub path: Option<PathBuf>,
    /// The name a document with no file answers to, so `Untitled 2`
    /// stays `Untitled 2` on the other side.
    pub untitled_name: Option<String>,
    /// What the file was when the window that had it last read or wrote
    /// it: the hash a save must present, and the format it must keep.
    pub meta: Option<DocumentMeta>,
    /// The buffer, in the clear. It is also inside `state`; carrying it
    /// here as well is what makes a payload the editor cannot read a
    /// document that has lost its undo history rather than a lost
    /// document.
    pub text: String,
    /// What the file held when the window last saw it, which is what the
    /// dirty dot and a merge are both measured against.
    pub base: String,
    /// What the reader has already looked at, so the Changes badge does
    /// not clear itself because a tab changed windows (design 4.4).
    pub reviewed: String,
    pub state: String,
    pub mode: TabMode,
    pub pinned: bool,
    pub anchor: u32,
    pub folded: Vec<String>,
}

/// Where a moved tab went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct TabMoved {
    pub label: String,
    /// Whether the window was made for it, which is the difference
    /// between a tab torn off and a tab handed over.
    pub created: bool,
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

    /// Forget a window the reader has closed, so the next launch does
    /// not put back something they shut (plan WP 2.5).
    pub fn remove_window(&mut self, label: &str) {
        self.windows.retain(|window| window.label != label);
    }

    /// Take one window's recent files into the session's.
    ///
    /// Every window reports the whole list rather than what it has just
    /// opened, so two windows writing in turn would each undo the
    /// other's. Merging keeps what the reporting window knows in front
    /// and everything else behind it, in the order it was already in.
    pub fn merge_recents(&mut self, recents: Vec<PathBuf>) {
        let mut merged = recents;
        for path in std::mem::take(&mut self.recents) {
            if !merged.contains(&path) {
                merged.push(path);
            }
        }
        merged.truncate(RECENTS);
        self.recents = merged;
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
    fn a_closed_window_is_forgotten_and_the_others_stay() {
        let mut kept = session(&["/a/one.md"]);
        kept.windows.push(WindowState {
            label: "window-2".to_owned(),
            ..WindowState::default()
        });
        kept.remove_window("window-2");
        assert_eq!(kept.windows.len(), 1);
        assert_eq!(kept.windows[0].label, "main");
        // A label nothing answers to leaves the session as it was.
        kept.remove_window("window-9");
        assert_eq!(kept.windows.len(), 1);
    }

    #[test]
    fn recents_from_two_windows_are_merged_rather_than_replaced() {
        let mut both = session(&["/a/one.md", "/a/two.md"]);
        both.merge_recents(vec![
            PathBuf::from("/a/three.md"),
            PathBuf::from("/a/one.md"),
        ]);
        // What the reporting window knows, then what it did not.
        assert_eq!(
            both.recents,
            [
                PathBuf::from("/a/three.md"),
                PathBuf::from("/a/one.md"),
                PathBuf::from("/a/two.md"),
            ]
        );
    }

    #[test]
    fn merged_recents_stop_at_the_cap() {
        let mut long = Session {
            recents: (0..RECENTS)
                .map(|n| PathBuf::from(format!("/a/{n}.md")))
                .collect(),
            ..Session::default()
        };
        long.merge_recents(vec![PathBuf::from("/b/new.md")]);
        assert_eq!(long.recents.len(), RECENTS);
        assert_eq!(long.recents[0], PathBuf::from("/b/new.md"));
        assert_eq!(long.recents[1], PathBuf::from("/a/0.md"));
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
        assert_eq!(settings.theme, ThemeId::One);
        assert_eq!(settings.appearance, Appearance::System);
        assert_eq!(settings.paper, Paper::White);
        assert_eq!(settings.family, Family::Sans);
        assert_eq!(settings.size, DEFAULT_SIZE);
        assert_eq!(settings.measure, DEFAULT_MEASURE);
    }

    /// Design 11: one report in a serif and a wider measure, without the
    /// file knowing and without every other document following it.
    #[test]
    fn an_override_is_kept_for_the_path_it_was_given_to() {
        let mut overrides = Overrides::default();
        let report = PathBuf::from("/w/report.md");
        assert_eq!(overrides.get(&report), Override::default());
        overrides.set(
            report.clone(),
            Override {
                family: Some(Family::Serif),
                measure: Some(84),
                ..Override::default()
            },
        );
        let mine = overrides.get(&report);
        assert_eq!(mine.family, Some(Family::Serif));
        assert_eq!(mine.measure, Some(84));
        // What it does not say, it does not answer for: the app's own
        // size still reaches a document that was only given a family.
        assert_eq!(mine.size, None);
        assert_eq!(overrides.get(Path::new("/w/other.md")), Override::default());
    }

    /// The reader who put everything back is not asking to be remembered.
    #[test]
    fn an_override_that_says_nothing_is_forgotten() {
        let mut overrides = Overrides::default();
        let path = PathBuf::from("/w/one.md");
        overrides.set(
            path.clone(),
            Override {
                paper: Some(Paper::Cream),
                ..Override::default()
            },
        );
        assert_eq!(overrides.documents.len(), 1);
        overrides.set(path.clone(), Override::default());
        assert!(overrides.documents.is_empty());
        assert_eq!(overrides.get(&path), Override::default());
    }

    #[test]
    fn the_newest_override_is_first_and_the_oldest_falls_off_the_end() {
        let mut overrides = Overrides::default();
        for n in 0..OVERRIDES + 10 {
            overrides.set(
                PathBuf::from(format!("/w/{n}.md")),
                Override {
                    size: Some(18),
                    ..Override::default()
                },
            );
        }
        assert_eq!(overrides.documents.len(), OVERRIDES);
        assert_eq!(
            overrides.documents[0].path,
            PathBuf::from(format!("/w/{}.md", OVERRIDES + 9))
        );
        assert_eq!(overrides.get(Path::new("/w/0.md")), Override::default());
    }

    /// The same hand-edited file, and the same answer as the settings.
    #[test]
    fn an_override_puts_a_size_that_is_not_on_the_scale_back_on_it() {
        let mut overrides = Overrides::default();
        let path = PathBuf::from("/w/odd.md");
        overrides.set(
            path.clone(),
            Override {
                size: Some(19),
                measure: Some(4000),
                ..Override::default()
            },
        );
        let mine = overrides.get(&path);
        assert_eq!(mine.size, Some(18));
        assert_eq!(mine.measure, Some(MEASURE_RANGE.1));
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
