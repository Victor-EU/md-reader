//! Tauri command handlers and the IPC contract (design 6.4). Each command
//! is a thin adapter over `mdreader_core`; commands later work packages
//! implement are declared here as stubs so the generated bindings carry
//! the whole contract and cannot drift from it.

// Command arguments arrive owned from the IPC deserializer; borrowing them
// would only add a clone on the caller side.
#![allow(clippy::needless_pass_by_value)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use mdreader_core::{
    AssetWrite, Block, BlockOp, Bounds, DirEntry, Document, Error, ExternalChange, FileFormat,
    FileMatches, FileRemoved, FileRenamed, Folder, FolderChange, History, MergeResult, Restore,
    SaveResult, SearchDone, SearchHit, SearchOptions, SearchProgress, Session, Settings,
    SnapshotAuthor, SnapshotInfo, Store, WatchEvent, Watcher, WindowContent, WindowState,
};
use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// What outlives a command: the folder watches behind the open documents,
/// the history store, the two files the app keeps for itself, and the
/// files the OS has asked a window to open.
///
/// The watcher and the history can fail to start — a platform without a
/// working watcher, a history directory that cannot be created — and the
/// app still opens files and saves them. What failed says so when it is
/// asked for. The stores cannot fail: with nowhere to write they keep
/// their value in memory, so only the next launch is the poorer for it.
struct Services {
    watcher: Option<Mutex<Watcher>>,
    history: Option<Mutex<History>>,
    /// The folder this window has open, if any (plan WP 2.4). Behind an
    /// `Arc` because the walk and the search read it from threads of
    /// their own, and neither should hold the lock while it works.
    folder: Mutex<Option<Arc<Folder>>>,
    /// The content search that is running, if one is.
    search: Mutex<Searches>,
    settings: Store<Settings>,
    session: Store<Session>,
    launch: Mutex<HashMap<String, Launch>>,
    /// Windows that have finished their before-close work and may go.
    closing: Mutex<HashSet<String>>,
    /// Set once the windows have been asked to finish before a quit.
    quitting: Mutex<bool>,
}

/// The content search that is running, and the number the window knows
/// it by.
///
/// A reader types and the results follow; each keystroke replaces the
/// search before it, and the id is what lets the window tell the answers
/// of the new one from the last of the old. The window chooses it rather
/// than being told: results are events, and an event can reach the
/// webview before the call that started the search has returned.
#[derive(Default)]
struct Searches {
    running: Option<(u32, Arc<AtomicBool>)>,
}

/// Files the OS wants one window to open, and whether that window is
/// listening yet. A file argument arrives before the webview exists, so
/// it waits here until the window asks for it.
#[derive(Default)]
struct Launch {
    queued: Vec<PathBuf>,
    ready: bool,
}

/// A lock whose value is worth more than the panic that poisoned it.
fn locked<T>(what: &Mutex<T>) -> MutexGuard<'_, T> {
    what.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unavailable<T>(what: &str) -> Result<T, Error> {
    Err(Error::Unavailable {
        what: what.to_owned(),
        message: "it did not start; see the log from launch".to_owned(),
    })
}

impl Services {
    fn watcher(&self) -> Result<MutexGuard<'_, Watcher>, Error> {
        let Some(watcher) = self.watcher.as_ref() else {
            return unavailable("the file watcher");
        };
        watcher.lock().map_err(|_| Error::Unavailable {
            what: "the file watcher".to_owned(),
            message: "its state was left locked by a panic".to_owned(),
        })
    }

    fn history(&self) -> Result<MutexGuard<'_, History>, Error> {
        let Some(history) = self.history.as_ref() else {
            return unavailable("the history");
        };
        history.lock().map_err(|_| Error::Unavailable {
            what: "the history".to_owned(),
            message: "its state was left locked by a panic".to_owned(),
        })
    }
}

/// Read a document from disk and return its content and metadata.
#[tauri::command]
#[specta::specta]
fn open_document(path: PathBuf) -> Result<Document, Error> {
    mdreader_core::read_document(&path)
}

/// Save the buffer in the file's stored form, refusing when the file on
/// disk no longer matches `expected_hash`.
#[tauri::command]
#[specta::specta]
fn save_document(
    services: tauri::State<'_, Services>,
    path: PathBuf,
    content: String,
    expected_hash: Option<String>,
    format: FileFormat,
) -> Result<SaveResult, Error> {
    let saved = mdreader_core::save_document(&path, &content, expected_hash.as_deref(), &format)?;
    // The watcher is about to see this write through the folder watch.
    // Telling it what we wrote is what keeps it from reporting our own
    // save back to us as somebody else's change.
    if let Ok(mut watcher) = services.watcher() {
        let _ = watcher.note_write(&path, &saved.hash);
    }
    Ok(saved)
}

/// Let the webview load images from a document's folder and below.
///
/// The asset protocol starts with an empty scope (design 8), and it grows
/// only here, only to the folder of a file the reader has opened. Nothing
/// else in the app can widen it, and nothing outside those folders is
/// reachable from the page.
#[tauri::command]
#[specta::specta]
fn allow_document_images(app: tauri::AppHandle, path: PathBuf) -> Result<(), Error> {
    allow_images(&app, &path)
}

/// Widen the asset protocol scope to a document's folder and below.
fn allow_images(app: &tauri::AppHandle, path: &Path) -> Result<(), Error> {
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| Error::Read {
            path: path.to_path_buf(),
            message: "no folder to allow images from".to_owned(),
        })?;
    tauri::Manager::asset_protocol_scope(app)
        .allow_directory(dir, true)
        .map_err(|error| Error::Read {
            path: dir.to_path_buf(),
            message: error.to_string(),
        })
}

/// Store an image pasted into a document, beside it in `assets`.
///
/// The bytes arrive base64-encoded because that is one string across the
/// bridge; the alternative the generated bindings would give us is a JSON
/// array of a million numbers for every screenshot.
#[tauri::command]
#[specta::specta]
fn write_asset(
    app: tauri::AppHandle,
    document: PathBuf,
    name: String,
    data: String,
) -> Result<AssetWrite, Error> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| Error::Write {
            path: PathBuf::from(&name),
            message: error.to_string(),
        })?;
    let write = mdreader_core::store_asset(&document, &name, &bytes)?;
    allow_images(&app, &document)?;
    Ok(write)
}

/// Store an image dropped onto a document. The same gesture, arriving as
/// a path rather than as bytes, so the file is copied and never crosses
/// the bridge at all.
#[tauri::command]
#[specta::specta]
fn import_asset(
    app: tauri::AppHandle,
    document: PathBuf,
    source: PathBuf,
) -> Result<AssetWrite, Error> {
    let write = mdreader_core::copy_asset(&document, &source)?;
    allow_images(&app, &document)?;
    Ok(write)
}

/// Rewrite a non-UTF-8 file as UTF-8 and return it freshly read.
#[tauri::command]
#[specta::specta]
fn convert_document_to_utf8(path: PathBuf) -> Result<Document, Error> {
    mdreader_core::convert_to_utf8(&path)
}

/// Watch a file for writes by other processes.
#[tauri::command]
#[specta::specta]
fn watch(services: tauri::State<'_, Services>, path: PathBuf) -> Result<(), Error> {
    services.watcher()?.watch(&path)
}

/// Stop watching a file.
#[tauri::command]
#[specta::specta]
fn unwatch(services: tauri::State<'_, Services>, path: PathBuf) -> Result<(), Error> {
    services.watcher()?.unwatch(&path)
}

/// Three-way merge of an external write into a dirty buffer (design 7.2).
///
/// The one command with no failure to report: three strings always have
/// a merge, even when every hunk of it is a conflict.
#[tauri::command]
#[specta::specta]
fn merge3(base: String, ours: String, theirs: String) -> MergeResult {
    mdreader_core::merge3(&base, &ours, &theirs)
}

/// Store a snapshot of `content` for `path`.
#[tauri::command]
#[specta::specta]
fn snapshot(
    services: tauri::State<'_, Services>,
    path: PathBuf,
    content: String,
    author: SnapshotAuthor,
) -> Result<SnapshotInfo, Error> {
    services.history()?.snapshot(&path, &content, author)
}

/// List the snapshots stored for `path`, newest first.
#[tauri::command]
#[specta::specta]
fn list_snapshots(
    services: tauri::State<'_, Services>,
    path: PathBuf,
) -> Result<Vec<SnapshotInfo>, Error> {
    services.history()?.list(&path)
}

/// Read one snapshot's content.
#[tauri::command]
#[specta::specta]
fn read_snapshot(services: tauri::State<'_, Services>, id: String) -> Result<String, Error> {
    services.history()?.read(&id)
}

// --- settings, session, and the files the OS hands us (WP 1.8) ----------

/// What this window looked like when it was last open, plus the
/// preferences and the recent files (design 4.1).
///
/// One round trip, because a window needs all three before it draws.
#[tauri::command]
#[specta::specta]
fn load_window(services: tauri::State<'_, Services>, window: tauri::WebviewWindow) -> Restore {
    let session = services.session.get();
    let content = session
        .window(window.label())
        .map(|state| state.content.clone());
    Restore {
        content,
        recents: session.recents,
        // Clamped on the way out as well as in: the file can be edited
        // by hand, and a size of zero is a window nobody can read their
        // way out of.
        settings: services.settings.get().clamped(),
    }
}

/// Record what this window holds.
///
/// This is both halves of design 6.5: what the next launch puts back,
/// and the registry that decides which window a file the OS hands us
/// belongs to. The value is current the moment this returns; only the
/// write to disk waits for the store's interval.
#[tauri::command]
#[specta::specta]
fn save_window(
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
    content: WindowContent,
    recents: Vec<PathBuf>,
) {
    let state = WindowState {
        label: window.label().to_owned(),
        // Where the window is belongs to the window manager, not to the
        // webview, so it is read here rather than sent from there.
        bounds: bounds_of(&window),
        content,
    };
    services.session.update(move |session| {
        session.recents = recents;
        session.put_window(state);
    });
}

/// Change the preferences.
#[tauri::command]
#[specta::specta]
fn save_settings(services: tauri::State<'_, Services>, settings: Settings) {
    services.settings.set(settings.clamped());
}

/// Write the settings and the session now, rather than at the next
/// interval. What a window does before it closes.
#[tauri::command]
#[specta::specta]
fn flush_state(services: tauri::State<'_, Services>) -> Result<(), Error> {
    services.settings.flush()?;
    services.session.flush()
}

/// Files the OS asked this window to open before it was listening.
///
/// Draining the queue is also how a window says it is ready: from here
/// on the same files arrive as an event instead of waiting, which is
/// what keeps a launch argument from being lost to a listener that was
/// not attached yet, and from being opened twice by one that was.
#[tauri::command]
#[specta::specta]
fn take_launch_paths(
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
) -> Vec<PathBuf> {
    let mut launch = locked(&services.launch);
    let entry = launch.entry(window.label().to_owned()).or_default();
    entry.ready = true;
    std::mem::take(&mut entry.queued)
}

/// The window has finished what it wanted to do before closing.
#[tauri::command]
#[specta::specta]
fn confirm_close(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    persist(&app);
    close_now(&app, window.label());
}

/// Align two block lists for the semantic diff (design 7.3, plan WP 2.2).
///
/// The frontend sends the middle: the blocks the two sides already agree
/// on at each end are matched off there, where the saving is in what
/// never crosses the bridge.
///
/// It cannot fail. Both sides arrive as arguments, so there is nothing
/// to read, nothing to lock, and no answer but the alignment of what
/// was sent.
#[tauri::command]
#[specta::specta]
fn block_diff(old_blocks: Vec<Block>, new_blocks: Vec<Block>) -> Vec<BlockOp> {
    mdreader_core::block_diff(&old_blocks, &new_blocks)
}

// --- the folder --------------------------------------------------------

/// How many results are sent at once, and how long a batch waits for
/// company. A search of a large folder finds thousands of lines; an
/// event each would cost more in bridge crossings than in searching.
const SEARCH_BATCH: usize = 64;
const SEARCH_FLUSH: Duration = Duration::from_millis(100);

/// Open a folder as this window's workspace (design 4.1).
///
/// Answers with the root, which is the path every entry under it is
/// built from. The tree is not returned with it: the window asks for the
/// levels it shows, and the one it shows first is one `list_dir` away.
#[tauri::command]
#[specta::specta]
fn open_folder(
    app: tauri::AppHandle,
    services: tauri::State<'_, Services>,
    path: PathBuf,
) -> Result<PathBuf, Error> {
    let handle = app.clone();
    let folder = Arc::new(Folder::open(&path, move |change| {
        if let Err(error) = FolderChangedEvent(change).emit(&handle) {
            eprintln!("could not report a folder change: {error}");
        }
    })?);
    let root = folder.root().to_path_buf();
    *locked(&services.folder) = Some(Arc::clone(&folder));
    // The walk behind Cmd+P, started now and on a thread of its own, so
    // that the first Cmd+P after opening a folder does not wait for it.
    thread::spawn(move || folder.warm());
    Ok(root)
}

/// Let the folder go: the watch stops with it, and so does whatever it
/// was being searched for.
#[tauri::command]
#[specta::specta]
fn close_folder(services: tauri::State<'_, Services>) {
    *locked(&services.folder) = None;
    if let Some((_, stop)) = locked(&services.search).running.take() {
        stop.store(true, Ordering::Relaxed);
    }
}

/// One level of the folder tree, honouring `.gitignore`.
#[tauri::command]
#[specta::specta]
fn list_dir(path: PathBuf) -> Result<Vec<DirEntry>, Error> {
    mdreader_core::list_dir(&path)
}

/// The files in the open folder that match what has been typed into
/// Cmd+P, best first (plan WP 2.4).
///
/// With no folder open there is nothing to match against and the window
/// is offering its tabs and its recents, which it ranks itself. That is
/// an empty answer rather than an error: a folder can be closed while a
/// keystroke is still crossing the bridge.
#[tauri::command]
#[specta::specta]
fn find_files(services: tauri::State<'_, Services>, query: String, limit: u32) -> FileMatches {
    let folder = locked(&services.folder).as_ref().map(Arc::clone);
    let Some(folder) = folder else {
        return FileMatches {
            hits: Vec::new(),
            files: 0,
            truncated: false,
        };
    };
    folder.find(&query, usize::try_from(limit).unwrap_or(usize::MAX))
}

/// Start searching the open folder's contents under the window's own
/// number for it; results follow as events carrying that number.
///
/// The pattern is compiled here rather than on the search thread, so a
/// regular expression with a typo in it comes back to the field it was
/// typed into instead of arriving later as a result that is not one.
#[tauri::command]
#[specta::specta]
fn start_search(
    app: tauri::AppHandle,
    services: tauri::State<'_, Services>,
    id: u32,
    query: String,
    options: SearchOptions,
) -> Result<(), Error> {
    let folder = locked(&services.folder).as_ref().map(Arc::clone);
    let Some(folder) = folder else {
        return Err(Error::Unavailable {
            what: "the folder".to_owned(),
            message: "no folder is open to search".to_owned(),
        });
    };
    mdreader_core::check_search(&query, &options)?;
    let mut searches = locked(&services.search);
    if let Some((_, stop)) = searches.running.take() {
        stop.store(true, Ordering::Relaxed);
    }
    let stop = Arc::new(AtomicBool::new(false));
    searches.running = Some((id, Arc::clone(&stop)));
    drop(searches);
    thread::spawn(move || run_search(&app, &folder, id, &query, &options, &stop));
    Ok(())
}

/// Stop the search with this id, if it is still the one running.
///
/// The id is checked so that a cancel arriving after the reader has
/// already started another search cannot stop the new one.
#[tauri::command]
#[specta::specta]
fn cancel_search(services: tauri::State<'_, Services>, id: u32) {
    let mut searches = locked(&services.search);
    if searches.running.as_ref().is_some_and(|(at, _)| *at == id)
        && let Some((_, stop)) = searches.running.take()
    {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Walk and search, reporting as it goes. Runs on its own thread.
fn run_search(
    app: &tauri::AppHandle,
    folder: &Folder,
    id: u32,
    query: &str,
    options: &SearchOptions,
    stop: &AtomicBool,
) {
    let mut batch: Vec<SearchHit> = Vec::new();
    let mut sent = Instant::now();
    let found = mdreader_core::search(folder.root(), query, options, stop, |hit| {
        batch.push(hit);
        if batch.len() >= SEARCH_BATCH || sent.elapsed() >= SEARCH_FLUSH {
            report_hits(app, id, std::mem::take(&mut batch));
            sent = Instant::now();
        }
    });
    if !batch.is_empty() {
        report_hits(app, id, batch);
    }
    // The pattern was compiled before the thread started, so a failure
    // here is the walk itself and there is nothing found to report.
    let (hits, truncated) = found.map_or((0, false), |found| (found.hits, found.truncated));
    let done = SearchDone {
        id,
        hits,
        truncated,
        cancelled: stop.load(Ordering::Relaxed),
    };
    if let Err(error) = SearchDoneEvent(done).emit(app) {
        eprintln!("could not report the end of a search: {error}");
    }
}

fn report_hits(app: &tauri::AppHandle, id: u32, hits: Vec<SearchHit>) {
    if let Err(error) = SearchProgressEvent(SearchProgress { id, hits }).emit(app) {
        eprintln!("could not report search results: {error}");
    }
}

/// Make an empty file in `dir`, from the sidebar's "New file".
#[tauri::command]
#[specta::specta]
fn create_file(dir: PathBuf, name: String) -> Result<PathBuf, Error> {
    mdreader_core::create_file(&dir, &name)
}

/// Rename a file within its folder, from the sidebar's inline rename.
#[tauri::command]
#[specta::specta]
fn rename_path(path: PathBuf, name: String) -> Result<PathBuf, Error> {
    mdreader_core::rename(&path, &name)
}

/// The watcher's report of a write by another process (design 6.4).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct ExternalChangeEvent(pub ExternalChange);

/// A watched file is no longer on disk.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct FileRemovedEvent(pub FileRemoved);

/// A watched file was renamed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct FileRenamedEvent(pub FileRenamed);

/// Something under the open folder was written (plan WP 2.4).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct FolderChangedEvent(pub FolderChange);

/// Some of what a content search has found so far.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct SearchProgressEvent(pub SearchProgress);

/// A content search has finished, been filled up, or been replaced.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct SearchDoneEvent(pub SearchDone);

/// Files the OS wants this window to open: a second launch, a Finder
/// double-click, an `open` from a terminal.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct OpenPathsEvent(pub Vec<PathBuf>);

/// The window is about to close. Write down whatever is not on disk yet,
/// then call `confirm_close`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct BeforeCloseEvent {
    pub label: String,
}

/// Pass one watcher report to the window.
fn report(app: &tauri::AppHandle, event: WatchEvent) {
    let sent = match event {
        WatchEvent::Changed(change) => ExternalChangeEvent(change).emit(app),
        WatchEvent::Removed { path } => FileRemovedEvent(FileRemoved { path }).emit(app),
        WatchEvent::Renamed { from, to } => FileRenamedEvent(FileRenamed { from, to }).emit(app),
    };
    if let Err(error) = sent {
        eprintln!("could not report a file change: {error}");
    }
}

// --- windows -----------------------------------------------------------

/// How long a window gets to write down what it holds before it is
/// closed anyway. A wedged webview must not be able to stop the app
/// from quitting.
const CLOSE_GRACE: Duration = Duration::from_millis(1500);

/// Enough of a window has to be on a screen that the reader can grab it.
const REACHABLE: i32 = 40;

/// Where a window is and how big it is, in physical pixels.
fn bounds_of(window: &tauri::WebviewWindow) -> Option<Bounds> {
    let at = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(Bounds {
        x: at.x,
        y: at.y,
        width: size.width,
        height: size.height,
    })
}

/// Put a window back where it was, unless where it was is gone.
///
/// A window restored onto a monitor that has since been unplugged is a
/// window the reader can neither see nor move, so a frame with no screen
/// under its title bar keeps its size and takes a fresh position.
fn place(window: &tauri::WebviewWindow, bounds: Bounds) {
    let _unused = window.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height));
    let monitors = window.available_monitors().unwrap_or_default();
    if monitors.iter().any(|monitor| reachable(monitor, bounds)) {
        let _unused = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
    }
}

fn reachable(monitor: &tauri::Monitor, bounds: Bounds) -> bool {
    let at = monitor.position();
    let size = monitor.size();
    let wide = |n: u32| i32::try_from(n).unwrap_or(i32::MAX);
    bounds.x < at.x + wide(size.width)
        && bounds.x + wide(bounds.width) > at.x
        && bounds.y < at.y + wide(size.height)
        && bounds.y + REACHABLE > at.y
}

/// Write the settings and the session. Called when a window goes and
/// when the process does.
fn persist(app: &tauri::AppHandle) {
    let Some(services) = app.try_state::<Services>() else {
        return;
    };
    for written in [services.settings.flush(), services.session.flush()] {
        if let Err(error) = written {
            eprintln!("could not write the app state: {error}");
        }
    }
}

/// Close a window that has said everything it wants to say.
fn close_now(app: &tauri::AppHandle, label: &str) {
    if let Some(services) = app.try_state::<Services>() {
        locked(&services.closing).insert(label.to_owned());
    }
    if let Some(window) = app.get_webview_window(label) {
        let _unused = window.close();
    }
}

/// Ask a window to write down what it holds, and close it once it has.
///
/// Today that is the session; from WP 1.11 it is also any autosave still
/// waiting on its timer. A window that never answers is closed when the
/// grace period runs out, because a wedged webview must not be able to
/// keep the app open.
fn ask_to_close(app: &tauri::AppHandle, label: &str) {
    let told = BeforeCloseEvent {
        label: label.to_owned(),
    }
    .emit_to(app, label);
    if told.is_err() {
        close_now(app, label);
        return;
    }
    let app = app.clone();
    let label = label.to_owned();
    thread::spawn(move || {
        thread::sleep(CLOSE_GRACE);
        if app.get_webview_window(&label).is_some() {
            eprintln!("{label} did not answer before closing; closing it anyway");
            close_now(&app, &label);
        }
    });
}

/// A window is closing. Stop it once, until the window has answered.
fn before_close(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let confirmed = app
        .try_state::<Services>()
        .is_some_and(|services| locked(&services.closing).remove(&label));
    if confirmed {
        return;
    }
    api.prevent_close();
    ask_to_close(&app, &label);
}

/// The app is being asked to quit while windows are still open: a
/// session ending, a window manager shutting things down.
///
/// The windows are asked the same question a close asks them, and the
/// quit is held until they answer. Closing the last one brings this
/// round again with nothing left to ask, and the quit goes through.
///
/// This is not the whole story of quitting. macOS Cmd+Q goes through
/// `NSApplication.terminate:`, which reaches the app only as
/// `RunEvent::Exit` — no window close, no exit request, and far too late
/// to ask a webview for anything. What the window has already told us is
/// what survives that, which is why the shell records a tab change at
/// the end of the turn rather than after a pause. Giving Cmd+Q the same
/// round trip means owning the macOS menu, which is the platform work of
/// build plan section 8.
fn before_exit(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    let Some(services) = app.try_state::<Services>() else {
        return;
    };
    let asked = std::mem::replace(&mut *locked(&services.quitting), true);
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    if asked || labels.is_empty() {
        persist(app);
        return;
    }
    api.prevent_exit();
    for label in &labels {
        ask_to_close(app, label);
    }
}

// --- files the OS hands us ---------------------------------------------

/// Files the OS handed us before the app had anywhere to put them.
///
/// A launch that opens a document is the reason this exists: macOS sends
/// the open event before `setup` runs, so at that moment there is no
/// state to hold it and no window to give it to. It lives here until
/// `start` has both.
static EARLY: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// Keep files until there is somewhere to put them.
fn hold(paths: Vec<PathBuf>) {
    locked(&EARLY).extend(paths);
}

/// Take them, once. A second caller gets nothing, which is what keeps a
/// launch document from being opened twice.
fn held() -> Vec<PathBuf> {
    std::mem::take(&mut *locked(&EARLY))
}

/// File arguments from a command line, resolved against the directory it
/// was typed in. Anything that is not a file we can open is dropped,
/// which is also what removes the `-psn_...` argument macOS adds.
fn paths_from(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| path.is_file())
        .collect()
}

/// Give the windows the files the OS wants opened.
///
/// A file that is already open goes to the window that has it, and
/// anything else to the window in front. That is the registry design 6.5
/// asks for, and it is what makes double-clicking a file that is already
/// open focus its tab instead of opening a second one.
fn deliver(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let Some(services) = app.try_state::<Services>() else {
        hold(paths);
        return;
    };
    let session = services.session.get();
    let mut wanted: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for path in paths {
        let label = session
            .window_with(&path)
            .filter(|label| app.get_webview_window(label).is_some())
            .map_or_else(|| front(app), str::to_owned);
        wanted.entry(label).or_default().push(path);
    }
    for (label, paths) in wanted {
        let ready = {
            let mut launch = locked(&services.launch);
            let entry = launch.entry(label.clone()).or_default();
            if !entry.ready {
                entry.queued.extend(paths.iter().cloned());
            }
            entry.ready
        };
        if ready && OpenPathsEvent(paths).emit_to(app, &label).is_err() {
            eprintln!("could not hand {label} the files to open");
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _unused = window.set_focus();
        }
    }
}

/// The window in front, or the first one there is.
fn front(app: &tauri::AppHandle) -> String {
    let windows = app.webview_windows();
    windows
        .iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label.clone())
        // A stable fallback, so which window a file lands in never
        // depends on the order a hash map happens to have.
        .or_else(|| windows.keys().min().cloned())
        .unwrap_or_else(|| "main".to_owned())
}

/// Start the watcher, the history store, and the two state files.
///
/// Nothing here is worth refusing to launch over: a reader with no
/// history is a reader who can still read, and the commands that need
/// one say so.
fn services(app: &tauri::AppHandle) -> Services {
    let handle = app.clone();
    let watcher = match Watcher::new(move |event| report(&handle, event)) {
        Ok(watcher) => Some(Mutex::new(watcher)),
        Err(error) => {
            eprintln!("no file watcher: {error}");
            None
        }
    };
    let history = match app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())
        .and_then(|dir| History::open(&dir.join("history")).map_err(|error| error.to_string()))
    {
        Ok(history) => {
            // Retention runs at startup, where the cost lands on nobody.
            if let Err(error) = history.sweep() {
                eprintln!("could not apply the history retention policy: {error}");
            }
            Some(Mutex::new(history))
        }
        Err(error) => {
            eprintln!("no history: {error}");
            None
        }
    };
    let (settings, session) = if let Ok(dir) = app.path().app_config_dir() {
        (
            Store::open(dir.join("settings.json")),
            Store::open(dir.join("session.json")),
        )
    } else {
        eprintln!("no config directory: this session will not be remembered");
        (Store::memory(), Store::memory())
    };
    Services {
        watcher,
        history,
        folder: Mutex::new(None),
        search: Mutex::new(Searches::default()),
        settings,
        session,
        launch: Mutex::new(HashMap::new()),
        closing: Mutex::new(HashSet::new()),
        quitting: Mutex::new(false),
    }
}

/// Every command and event of the contract, in one place.
#[must_use]
pub fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            open_document,
            save_document,
            convert_document_to_utf8,
            allow_document_images,
            write_asset,
            import_asset,
            watch,
            unwatch,
            merge3,
            snapshot,
            list_snapshots,
            read_snapshot,
            load_window,
            save_window,
            save_settings,
            flush_state,
            take_launch_paths,
            confirm_close,
            block_diff,
            open_folder,
            close_folder,
            list_dir,
            find_files,
            start_search,
            cancel_search,
            create_file,
            rename_path,
        ])
        .events(collect_events![
            ExternalChangeEvent,
            FileRemovedEvent,
            FileRenamedEvent,
            FolderChangedEvent,
            SearchProgressEvent,
            SearchDoneEvent,
            OpenPathsEvent,
            BeforeCloseEvent
        ])
}

/// The TypeScript export settings.
#[must_use]
pub fn typescript() -> Typescript {
    Typescript::default().header(
        "// Generated by crates/app. Do not edit; run `cargo run -p mdreader-app --bin export-bindings`.",
    )
}

/// Where the generated bindings live, relative to this crate.
#[must_use]
pub fn bindings_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/ipc/src/bindings.ts")
}

/// Write the bindings file.
///
/// # Errors
/// Fails when the export or the write fails.
pub fn export_bindings(to: &Path) -> Result<(), specta_typescript::Error> {
    ipc_builder().export(typescript(), to)
}

/// Whether this process is `tauri dev` rather than a bundled application.
///
/// `bindings_path()` is baked in at compile time, so a debug bundle left
/// in `target/` keeps a path into the source tree and rewrites the
/// generated file when it is launched — with whatever command set it was
/// built from. One did, at the Phase 1 gate: an old bundle that
/// `LaunchServices` preferred for `.md` took two work packages of commands
/// back out of `packages/ipc/src/bindings.ts` and broke `pnpm check`.
/// A bundle has no business writing into a checkout, so only the loose
/// binary does.
#[cfg(debug_assertions)]
fn from_source_tree() -> bool {
    std::env::current_exe().is_ok_and(|exe| !exe.to_string_lossy().contains(".app/Contents/"))
}

/// Put every window back where it was and show it, then hand over
/// whatever the launch was asked to open.
///
/// The windows start hidden (see `tauri.conf.json`) so nobody watches
/// one appear at the default position and jump to its own.
fn start(app: &tauri::App) {
    let handle = app.handle().clone();
    app.manage(services(&handle));
    let session = app.state::<Services>().session.get();
    for (label, window) in app.webview_windows() {
        if let Some(bounds) = session.window(&label).and_then(|state| state.bounds) {
            place(&window, bounds);
        }
        let _unused = window.show();
    }
    // Whatever the launch was for: an open event that arrived before any
    // of this existed, or file arguments on the command line.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let args: Vec<String> = std::env::args().collect();
    let mut wanted = held();
    wanted.extend(paths_from(&args, &cwd));
    deliver(&handle, wanted);
}

/// Turn a second launch into a message to the one already running.
///
/// It goes on the builder before anything else, as the plugin requires:
/// the second process has to be turned away before it starts building a
/// window of its own.
#[cfg(not(target_os = "macos"))]
fn single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        deliver(app, paths_from(&argv, Path::new(&cwd)));
    }))
}

/// macOS keeps one instance of a bundled app itself and sends the files
/// as an Apple event, which arrives as `RunEvent::Opened`.
#[cfg(target_os = "macos")]
fn single_instance(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

/// Build and run the application with the given generated context.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run(context: tauri::Context) {
    let builder = ipc_builder();
    #[cfg(debug_assertions)]
    if from_source_tree()
        && let Err(e) = export_bindings(&bindings_path())
    {
        eprintln!("could not export IPC bindings: {e}");
    }
    let app = single_instance(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        // Links in Read mode open in the system browser; the webview never
        // navigates away from the app (design 6.2).
        .plugin(tauri_plugin_opener::init())
        // The updater and the restart it ends with (plan WP 1.12). The
        // check itself is made from the webview, which is where the
        // reader can be told about it; Rust only carries the plugin.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                before_close(window, api);
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            start(app);
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");
    app.run(|app, event| match event {
        // A Finder double-click, or `open -a` from a terminal. The files
        // arrive as `file://` URLs.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let paths = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect();
            deliver(app, paths);
        }
        tauri::RunEvent::ExitRequested { ref api, .. } => before_exit(app, api),
        tauri::RunEvent::Exit => persist(app),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(rest: &[&str]) -> Vec<String> {
        std::iter::once("mdreader-desktop")
            .chain(rest.iter().copied())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn file_arguments_are_taken_relative_to_where_they_were_typed() {
        let dir = std::env::temp_dir().join(format!("mdreader-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let here = dir.join("here.md");
        std::fs::write(&here, b"# here").expect("fixture");
        assert_eq!(
            paths_from(&args(&["here.md"]), &dir),
            vec![here.clone()],
            "a relative argument resolves against the directory it was typed in"
        );
        assert_eq!(
            paths_from(&args(&[&here.to_string_lossy()]), Path::new("/nowhere")),
            vec![here],
            "an absolute argument ignores it"
        );
    }

    #[test]
    fn what_is_not_a_file_to_open_is_dropped() {
        let dir = std::env::temp_dir().join(format!("mdreader-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert!(
            paths_from(&args(&[]), &dir).is_empty(),
            "the program's own name is not a file argument"
        );
        assert!(
            paths_from(&args(&["--flag", "-psn_0_12345"]), &dir).is_empty(),
            "flags are not files, including the one macOS adds"
        );
        assert!(
            paths_from(&args(&["gone.md"]), &dir).is_empty(),
            "a path with nothing behind it is not worth a tab"
        );
    }

    #[test]
    fn a_file_that_arrives_before_the_app_waits_and_is_taken_once() {
        // macOS sends the open event for a launch document before `setup`
        // runs, so the app has to be able to hold one before it exists.
        assert!(held().is_empty());
        hold(vec![PathBuf::from("/a/one.md")]);
        hold(vec![PathBuf::from("/a/two.md")]);
        assert_eq!(
            held(),
            vec![PathBuf::from("/a/one.md"), PathBuf::from("/a/two.md")]
        );
        assert!(held().is_empty(), "a second window would open them again");
    }

    /// CI guard: the committed bindings must match what the current
    /// contract generates. Regenerate with the `export-bindings` binary.
    #[test]
    fn committed_bindings_are_current() {
        let dir = std::env::temp_dir().join(format!("mdreader-bindings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let fresh = dir.join("bindings.ts");
        export_bindings(&fresh).expect("export");
        let generated = std::fs::read_to_string(&fresh).expect("read fresh");
        let committed = std::fs::read_to_string(bindings_path()).unwrap_or_default();
        assert!(
            generated == committed,
            "packages/ipc/src/bindings.ts is stale; run `cargo run -p mdreader-app --bin export-bindings`"
        );
    }
}
