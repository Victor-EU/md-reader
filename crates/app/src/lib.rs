//! Tauri command handlers and the IPC contract (design 6.4). Each command
//! is a thin adapter over `mdreader_core`; commands later work packages
//! implement are declared here as stubs so the generated bindings carry
//! the whole contract and cannot drift from it.

// Command arguments arrive owned from the IPC deserializer; borrowing them
// would only add a clone on the caller side.
#![allow(clippy::needless_pass_by_value)]

pub mod mcp;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use mdreader_core::{
    AgentAnswer, AgentAsk, AgentDocument, AgentRequest, AgentStatus, AssetWrite, Block, BlockOp,
    Bounds, DirEntry, Document, Error, ExportWrite, ExternalChange, FileFormat, FileMatches,
    FileRemoved, FileRenamed, Folder, FolderChange, History, MergeResult, Override, Overrides,
    ReadOnly, Restore, SaveResult, SearchDone, SearchHit, SearchOptions, SearchProgress, Session,
    Settings, SnapshotAuthor, SnapshotInfo, Store, TabMove, TabMoved, WatchEvent, Watcher,
    WindowContent, WindowState,
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
    /// The folder each window has open, if it has one (plan WP 2.4),
    /// by window label.
    ///
    /// A workspace belongs to the window it was opened in: two windows
    /// are two folders, two trees and two searches, and neither is any
    /// of the other's business (plan WP 2.5). Behind an `Arc` because
    /// the walk and the search read it from threads of their own, and
    /// neither should hold the lock while it works.
    folders: Mutex<HashMap<String, Arc<Folder>>>,
    /// The content search each window has running, if it has one.
    searches: Mutex<HashMap<String, Searches>>,
    settings: Store<Settings>,
    /// What single documents are read in, keyed by path (design 11).
    overrides: Store<Overrides>,
    session: Store<Session>,
    launch: Mutex<HashMap<String, Waiting<PathBuf>>>,
    /// Tabs on their way from one window to another (plan WP 2.5).
    handoff: Mutex<HashMap<String, Waiting<TabMove>>>,
    /// Windows that have finished their before-close work and may go.
    closing: Mutex<HashSet<String>>,
    /// Set once the windows have been asked to finish before a quit.
    quitting: Mutex<bool>,
    /// Questions the MCP server has out with the windows (design 9).
    agents: Arc<mcp::Agents>,
    /// The sessions the server is holding, for the client count.
    agent_running: Arc<mcp::serve::Running>,
    /// The bearer token this launch answers to. Behind its own lock
    /// because rotating one replaces it while the server is running.
    agent_token: Mutex<String>,
    agent_status: Mutex<AgentStatus>,
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

/// What one window is owed, and whether it is listening yet.
///
/// A file argument arrives before the webview exists; so does a tab torn
/// into a window that is still being built. Both wait here until the
/// window asks for them, and asking is also how a window says that from
/// now on the same thing reaches it as an event instead.
struct Waiting<T> {
    queued: Vec<T>,
    ready: bool,
}

// Written out rather than derived: a queue starts empty whether or not
// the thing it holds has a default of its own.
impl<T> Default for Waiting<T> {
    fn default() -> Self {
        Self {
            queued: Vec::new(),
            ready: false,
        }
    }
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

    /// The folder one window has open.
    fn folder(&self, label: &str) -> Option<Arc<Folder>> {
        locked(&self.folders).get(label).map(Arc::clone)
    }

    /// Stop whatever that window was searching for, if anything.
    fn stop_search(&self, label: &str) {
        if let Some(searches) = locked(&self.searches).get_mut(label)
            && let Some((_, stop)) = searches.running.take()
        {
            stop.store(true, Ordering::Relaxed);
        }
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

/// Read a document for a window: its bytes, the version it was found in,
/// and a watch on it.
///
/// Three things that all need the file, done where the file is. Asking
/// for them afterwards meant the window sending every document back
/// across the bridge to say what this side had just read, and the
/// watcher reading each one a second time — which on a session of two
/// hundred tabs was two hundred files read twice and five megabytes sent
/// nowhere (plan WP 3.3). It also closed a gap: a writer landing between
/// the read and the watch used to leave the window holding one version
/// and the watcher calling the next one the baseline.
///
/// Neither the record nor the watch is a reason to refuse a file, so
/// both failures are dropped rather than returned. A file too large to
/// edit is not recorded at all: nothing in the app can change it, so
/// there would never be a second version for the first to be compared
/// with, and storing it would double what a very large file costs.
#[tauri::command]
#[specta::specta]
fn open_document(services: tauri::State<'_, Services>, path: PathBuf) -> Result<Document, Error> {
    let document = mdreader_core::read_document(&path)?;
    if document.meta.read_only != Some(ReadOnly::Size)
        && let Ok(mut history) = services.history()
    {
        let _ = history.snapshot(&path, &document.content, SnapshotAuthor::User);
    }
    if let Ok(mut watcher) = services.watcher() {
        let _ = watcher.watch_known(&path, &document.content, document.meta.hash.clone());
    }
    Ok(document)
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

/// Write a rendered document out as a page of its own (plan WP 3.2).
///
/// The page arrives already rendered -- the markdown renderer is the
/// frontend's, and what it produces is what Read mode shows -- with a
/// numbered sentinel where each local image goes. What this adds is the
/// images, which are dealt with here because the bytes are here.
///
/// An image outside the folders the asset protocol has been opened to is
/// not read. Read mode could not have shown it either, and an export is
/// not a way around the fence design 8 puts around a document's folder;
/// the page names it and does not carry it, which is what a missing
/// image already looks like.
#[tauri::command]
#[specta::specta]
fn export_html(
    app: tauri::AppHandle,
    path: PathBuf,
    html: String,
    images: Vec<PathBuf>,
) -> Result<ExportWrite, Error> {
    let scope = tauri::Manager::asset_protocol_scope(&app);
    let reachable: Vec<PathBuf> = images
        .into_iter()
        .map(|image| {
            if scope.is_allowed(&image) {
                image
            } else {
                // Its own name, which `write_export` counts as an image
                // the page names and has not got.
                PathBuf::from(image.file_name().unwrap_or_default())
            }
        })
        .collect();
    mdreader_core::write_export(&path, &html, &reachable)
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
        // Merged rather than assigned: every window reports the whole
        // list, so two of them writing in turn would each undo the
        // other's (plan WP 2.5).
        session.merge_recents(recents);
        session.put_window(state);
    });
}

/// Change the preferences.
///
/// The preferences are the app's, not a window's, so every window is
/// told: the reader who picks a theme in one of them has picked it for
/// all of them, and a second window still wearing the old one would be
/// the app disagreeing with itself (plan WP 2.6). The window that asked
/// hears it too, and applying what it already applied costs nothing.
#[tauri::command]
#[specta::specta]
fn save_settings(app: tauri::AppHandle, services: tauri::State<'_, Services>, settings: Settings) {
    let settings = settings.clamped();
    services.settings.set(settings);
    if let Err(error) = SettingsChangedEvent(settings).emit(&app) {
        eprintln!("could not pass the settings on: {error}");
    }
}

/// What this document is read in, if the reader gave it settings of its
/// own (design 11). An answer of nothing means it follows the app.
#[tauri::command]
#[specta::specta]
fn document_override(services: tauri::State<'_, Services>, path: PathBuf) -> Override {
    services.overrides.get().get(&path)
}

/// Give this document its own reading settings, or take them away.
///
/// Keyed by path in app data rather than written into the file: design
/// 11's point is that the reader can set one report in a serif without
/// the file, or whoever reads it next, knowing anything about it.
#[tauri::command]
#[specta::specta]
fn set_document_override(
    services: tauri::State<'_, Services>,
    path: PathBuf,
    reading: Override,
) -> Override {
    services
        .overrides
        .update(|overrides| overrides.set(path.clone(), reading));
    services.overrides.get().get(&path)
}

/// Write the settings and the session now, rather than at the next
/// interval. What a window does before it closes.
#[tauri::command]
#[specta::specta]
fn flush_state(services: tauri::State<'_, Services>) -> Result<(), Error> {
    services.settings.flush()?;
    services.overrides.flush()?;
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

// --- more than one window (plan WP 2.5) --------------------------------

/// Open a second window (design 4.1, Cmd+Shift+N).
///
/// It comes up over the one that asked for it and the same size, which
/// is where the reader is looking; it starts empty, because a new window
/// is somewhere to put something, not a copy of what is already open.
#[tauri::command]
#[specta::specta]
fn new_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<String, Error> {
    let label = next_label(&labels(&app));
    let made = spawn(&app, &label)?;
    cascade(&window, &made);
    let _unused = made.show();
    let _unused = made.set_focus();
    Ok(label)
}

/// Hand a tab to another window (design 6.5, plan WP 2.5).
///
/// `dropped` says the tab was let go of with the pointer, and then where
/// the pointer is decides: a window under it takes the tab in, and
/// nothing under it tears the tab into a new window there. Without it —
/// the command rather than the drag — it is always a new window, over
/// the one the tab came from.
///
/// The pointer is read here rather than sent from the webview. A drag
/// that has left the window is no longer something the webview can
/// measure: what `WebKit` reports as the end of one is a point near where
/// the reader let go and not the point itself, which was out by fifty
/// pixels in both directions when this was measured. The window manager
/// knows where the pointer is, in the same coordinates a window frame is
/// in, on whichever monitor it is over.
///
/// A document cannot be in two windows at once, because a document lives
/// in a webview and two webviews share nothing. So this is a move and
/// not a copy: what is answered here is what the window it left is
/// waiting for before it lets go.
#[tauri::command]
#[specta::specta]
fn move_tab(
    app: tauri::AppHandle,
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
    tab: TabMove,
    dropped: bool,
) -> Result<TabMoved, Error> {
    let at = if dropped {
        app.cursor_position().ok()
    } else {
        None
    };
    if let Some(label) = at.and_then(|point| window_at(&app, point, window.label())) {
        hand_over(&app, &services, &label, tab)?;
        if let Some(other) = app.get_webview_window(&label) {
            // The tab was dropped where the reader is looking, so that is
            // where the window with it in should be.
            let _unused = other.set_focus();
        }
        return Ok(TabMoved {
            label,
            created: false,
        });
    }
    let label = next_label(&labels(&app));
    let made = spawn(&app, &label)?;
    match at {
        // Torn off: the new window's corner goes where the tab was let
        // go of, so its own strip is under the pointer that dropped it.
        Some(point) => put(&made, point),
        None => cascade(&window, &made),
    }
    if let Err(error) = hand_over(&app, &services, &label, tab) {
        // Nothing to show: a window made for a tab that never arrived.
        let _unused = made.close();
        return Err(error);
    }
    let _unused = made.show();
    let _unused = made.set_focus();
    Ok(TabMoved {
        label,
        created: true,
    })
}

/// Tabs another window handed this one before it was listening.
///
/// Draining is also how a window says it is ready, exactly as
/// `take_launch_paths` is: from here on a tab reaches it as an event.
#[tauri::command]
#[specta::specta]
fn take_moved_tabs(
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
) -> Vec<TabMove> {
    let mut handoff = locked(&services.handoff);
    let entry = handoff.entry(window.label().to_owned()).or_default();
    entry.ready = true;
    std::mem::take(&mut entry.queued)
}

/// Whether another window already has this file open, and if so, bring
/// it forward with the file in front (design 6.5).
///
/// One document belongs to one window, so a file the reader opens from
/// anywhere — the palette, the open panel, the tree — goes to the window
/// that already has it rather than being opened a second time. The
/// session is the registry that answers this, as it is for a file the OS
/// hands us (WP 1.8), so the answer is only as fresh as the last thing a
/// window said about itself; opening one file in two windows in the same
/// instant opens it twice.
#[tauri::command]
#[specta::specta]
fn reveal_path(
    app: tauri::AppHandle,
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
    path: PathBuf,
) -> bool {
    let session = services.session.get();
    let Some(label) = session.window_with(&path).map(str::to_owned) else {
        return false;
    };
    if label == window.label() {
        return false;
    }
    let Some(other) = app.get_webview_window(&label) else {
        return false;
    };
    let _unused = other.set_focus();
    OpenPathsEvent(vec![path]).emit_to(&app, &label).is_ok()
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
    window: tauri::WebviewWindow,
    path: PathBuf,
) -> Result<PathBuf, Error> {
    let handle = app.clone();
    let label = window.label().to_owned();
    let folder = Arc::new(Folder::open(&path, move |change| {
        // To the one window whose tree it is. Another window's tree is
        // another folder, and a change here says nothing about it.
        if let Err(error) = FolderChangedEvent(change).emit_to(&handle, &label) {
            eprintln!("could not report a folder change: {error}");
        }
    })?);
    let root = folder.root().to_path_buf();
    locked(&services.folders).insert(window.label().to_owned(), Arc::clone(&folder));
    // The walk behind Cmd+P, started now and on a thread of its own, so
    // that the first Cmd+P after opening a folder does not wait for it.
    thread::spawn(move || folder.warm());
    Ok(root)
}

/// Let the folder go: the watch stops with it, and so does whatever it
/// was being searched for.
#[tauri::command]
#[specta::specta]
fn close_folder(services: tauri::State<'_, Services>, window: tauri::WebviewWindow) {
    locked(&services.folders).remove(window.label());
    services.stop_search(window.label());
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
fn find_files(
    services: tauri::State<'_, Services>,
    window: tauri::WebviewWindow,
    query: String,
    limit: u32,
) -> FileMatches {
    let Some(folder) = services.folder(window.label()) else {
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
    window: tauri::WebviewWindow,
    id: u32,
    query: String,
    options: SearchOptions,
) -> Result<(), Error> {
    let label = window.label().to_owned();
    let Some(folder) = services.folder(&label) else {
        return Err(Error::Unavailable {
            what: "the folder".to_owned(),
            message: "no folder is open to search".to_owned(),
        });
    };
    mdreader_core::check_search(&query, &options)?;
    services.stop_search(&label);
    let stop = Arc::new(AtomicBool::new(false));
    locked(&services.searches)
        .entry(label.clone())
        .or_default()
        .running = Some((id, Arc::clone(&stop)));
    thread::spawn(move || run_search(&app, &label, &folder, id, &query, &options, &stop));
    Ok(())
}

/// Stop the search with this id, if it is still the one running.
///
/// The id is checked so that a cancel arriving after the reader has
/// already started another search cannot stop the new one.
#[tauri::command]
#[specta::specta]
fn cancel_search(services: tauri::State<'_, Services>, window: tauri::WebviewWindow, id: u32) {
    let mut searches = locked(&services.searches);
    let Some(window) = searches.get_mut(window.label()) else {
        return;
    };
    if window.running.as_ref().is_some_and(|(at, _)| *at == id)
        && let Some((_, stop)) = window.running.take()
    {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Walk and search, reporting as it goes. Runs on its own thread.
fn run_search(
    app: &tauri::AppHandle,
    label: &str,
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
            report_hits(app, label, id, std::mem::take(&mut batch));
            sent = Instant::now();
        }
    });
    if !batch.is_empty() {
        report_hits(app, label, id, batch);
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
    if let Err(error) = SearchDoneEvent(done).emit_to(app, label) {
        eprintln!("could not report the end of a search: {error}");
    }
}

fn report_hits(app: &tauri::AppHandle, label: &str, id: u32, hits: Vec<SearchHit>) {
    if let Err(error) = SearchProgressEvent(SearchProgress { id, hits }).emit_to(app, label) {
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

/// A tab another window has handed this one (plan WP 2.5).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct TabArrivedEvent(pub TabMove);

/// The preferences have changed, in this window or in another one
/// (plan WP 2.6). They belong to the app, so they reach every window.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct SettingsChangedEvent(pub Settings);

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

/// How far a new window comes up from the one that asked for it, in
/// points: far enough to see that there are two of them, near enough
/// that the new one is where the reader is looking.
const CASCADE: f64 = 28.0;

/// The labels of the windows there are.
fn labels(app: &tauri::AppHandle) -> Vec<String> {
    app.webview_windows().into_keys().collect()
}

/// A label no window answers to.
///
/// `main` is the configuration's; the rest are numbered, and the lowest
/// free number is taken rather than the next one ever used, so a session
/// of opening and closing windows does not count upwards forever.
fn next_label(taken: &[String]) -> String {
    (2..u32::MAX)
        .map(|n| format!("window-{n}"))
        .find(|label| !taken.iter().any(|used| used == label))
        // Which cannot happen with a finite number of windows open.
        .unwrap_or_else(|| "window".to_owned())
}

/// Build a window like the one the configuration describes, under a
/// label of its own. It comes up hidden, as the configured one does.
///
/// The configuration is the single source of a window's title, its
/// minimum size and the rest; only the label is ours. Writing those out
/// again here would be a second place to change the shape of a window,
/// and one of the two would be wrong.
fn spawn(app: &tauri::AppHandle, label: &str) -> Result<tauri::WebviewWindow, Error> {
    let mut config =
        app.config()
            .app
            .windows
            .first()
            .cloned()
            .ok_or_else(|| Error::Unavailable {
                what: "a window".to_owned(),
                message: "the configuration describes none to copy".to_owned(),
            })?;
    label.clone_into(&mut config.label);
    config.visible = false;
    let opened = |error: tauri::Error| Error::Unavailable {
        what: "a window".to_owned(),
        message: error.to_string(),
    };
    tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(opened)?
        .build()
        .map_err(opened)
}

/// Where on the desktop a point is, in the pixels a window frame is
/// measured in. The pointer and the frames are read in the same units,
/// so nothing here converts between them.
type Spot = tauri::PhysicalPosition<f64>;

/// Put a new window over the one it came from, offset and the same size.
fn cascade(from: &tauri::WebviewWindow, to: &tauri::WebviewWindow) {
    let scale = from.scale_factor().unwrap_or(1.0);
    if let Ok(at) = from.outer_position() {
        put(
            to,
            Spot::new(
                f64::from(at.x) + CASCADE * scale,
                f64::from(at.y) + CASCADE * scale,
            ),
        );
    }
    if let Ok(size) = from.inner_size() {
        let _unused = to.set_size(size);
    }
}

/// Put a window's top left corner at a point on the desktop.
fn put(window: &tauri::WebviewWindow, at: Spot) {
    let _unused = window.set_position(tauri::PhysicalPosition::new(at.x, at.y));
}

/// The window under a point on the desktop, if one of ours is.
///
/// Two windows overlapping the point is a tie this does not break: the
/// drag has to land somewhere, and either answer is a window under the
/// pointer.
fn window_at(app: &tauri::AppHandle, at: Spot, except: &str) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(label, window)| {
            label != except
                && window.is_visible().unwrap_or(false)
                && !window.is_minimized().unwrap_or(false)
                && covers(window, at)
        })
        .map(|(label, _)| label)
}

fn covers(window: &tauri::WebviewWindow, at: Spot) -> bool {
    let (Ok(origin), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    let (width, height) = (f64::from(size.width), f64::from(size.height));
    let (x, y) = (f64::from(origin.x), f64::from(origin.y));
    at.x >= x && at.x < x + width && at.y >= y && at.y < y + height
}

/// Give a window a tab, or hold it until the window is listening.
///
/// A window made a moment ago for a torn-off tab has no listener yet,
/// which is the same problem a launch file has and gets the same answer.
/// A failure to deliver is reported to the window that is giving the tab
/// up, so that it can keep it rather than lose it to a window that never
/// heard.
fn hand_over(
    app: &tauri::AppHandle,
    services: &Services,
    label: &str,
    tab: TabMove,
) -> Result<(), Error> {
    {
        let mut handoff = locked(&services.handoff);
        let entry = handoff.entry(label.to_owned()).or_default();
        if !entry.ready {
            entry.queued.push(tab);
            return Ok(());
        }
    }
    TabArrivedEvent(tab)
        .emit_to(app, label)
        .map_err(|error| Error::Unavailable {
            what: "the other window".to_owned(),
            message: error.to_string(),
        })
}

/// A window has gone: let go of what was being kept for it.
///
/// Its folder's watch stops with it, and so does whatever it was
/// searching for. Its place in the session goes too, so the next launch
/// does not put back a window the reader closed — unless it was the last
/// one, because then there would be nothing at all to come back to, and
/// the session file is the only place an untitled document has ever
/// been. A window closing because the app is quitting keeps its place:
/// that is the session the next launch is for.
fn forget(app: &tauri::AppHandle, label: &str) {
    let Some(services) = app.try_state::<Services>() else {
        return;
    };
    locked(&services.folders).remove(label);
    services.agents.forget(label);
    services.stop_search(label);
    locked(&services.searches).remove(label);
    locked(&services.handoff).remove(label);
    locked(&services.launch).remove(label);
    locked(&services.closing).remove(label);
    let others = labels(app)
        .into_iter()
        .filter(|other| other != label)
        .count();
    if *locked(&services.quitting) || others == 0 {
        return;
    }
    services
        .session
        .update(|session| session.remove_window(label));
}

/// Write the settings and the session. Called when a window goes and
/// when the process does.
fn persist(app: &tauri::AppHandle) {
    let Some(services) = app.try_state::<Services>() else {
        return;
    };
    for written in [
        services.settings.flush(),
        services.overrides.flush(),
        services.session.flush(),
    ] {
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

// --- the agent side (design 9, plan WP 3.1) ----------------------------

/// One question on its way to a window, from the MCP server.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct AgentAskEvent(pub AgentAsk);

/// The server came up, went away, or something happened on it. What the
/// status bar draws (plan WP 3.1); the app's rather than a window's, so
/// every window hears it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub struct AgentStatusEvent(pub AgentStatus);

/// A window's answer to one question the server asked it.
///
/// An id nobody is waiting for is dropped rather than refused: that is
/// an answer that arrived after its question timed out, and there is
/// nothing left to give it to.
#[tauri::command]
#[specta::specta]
fn answer_agent(services: tauri::State<'_, Services>, id: u32, answer: AgentAnswer) {
    services.agents.answer(id, answer);
}

/// What the status bar says about the agent server.
#[tauri::command]
#[specta::specta]
fn agent_status(services: tauri::State<'_, Services>) -> AgentStatus {
    locked(&services.agent_status).clone()
}

/// A fresh token, for the reader who wants the old one to stop working.
///
/// The server keeps running on the same port: only the token changes,
/// which is what every client configured with `--mcp-stdio` picks up on
/// its next connection, because that mode reads the file every time.
#[tauri::command]
#[specta::specta]
fn rotate_agent_token(
    app: tauri::AppHandle,
    services: tauri::State<'_, Services>,
) -> Result<(), Error> {
    let dir = app_data(&app)?;
    let port = locked(&services.agent_status).port;
    let endpoint = mcp::rotate(&dir, port)?;
    *locked(&services.agent_token) = endpoint.token;
    Ok(())
}

/// The client configuration to paste, for the palette command that
/// copies one.
#[tauri::command]
#[specta::specta]
fn agent_client_config(app: tauri::AppHandle) -> Result<String, Error> {
    let binary = std::env::current_exe().map_err(|error| Error::Unavailable {
        what: "the client configuration".to_owned(),
        message: format!("this program does not know where it is: {error}"),
    })?;
    let _unused = &app;
    Ok(mcp::client_config(&binary))
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    app.path()
        .app_data_dir()
        .map_err(|error| Error::Unavailable {
            what: "the app data directory".to_owned(),
            message: error.to_string(),
        })
}

/// The app, as the MCP server sees it (`mcp::Desk`).
///
/// Every question the server can ask and everything it can do to this
/// machine passes through here.
struct Desktop {
    app: tauri::AppHandle,
}

/// Put one question to one window and wait for its answer.
async fn ask_window(
    app: &tauri::AppHandle,
    label: &str,
    request: AgentRequest,
) -> Result<AgentAnswer, Error> {
    let what = request.path().map_or_else(
        || "the open documents".to_owned(),
        |path| path.display().to_string(),
    );
    let Some((id, receive)) = app
        .try_state::<Services>()
        .map(|services| services.agents.open(label))
    else {
        return unavailable("the agent server");
    };
    if AgentAskEvent(AgentAsk { id, request })
        .emit_to(app, label)
        .is_err()
    {
        if let Some(services) = app.try_state::<Services>() {
            services.agents.close(id);
        }
        return Err(Error::Unavailable {
            what,
            message: format!("{label} could not be reached"),
        });
    }
    let answer = mcp::wait(receive, &what).await;
    if answer.is_err()
        && let Some(services) = app.try_state::<Services>()
    {
        services.agents.close(id);
    }
    answer
}

/// Which window has `path` open.
///
/// The session first, which is the registry design 6.5 already keeps and
/// is current within a tick of a tab opening. A miss falls back to
/// asking the windows what they have, because the one case the session
/// is behind on — a document opened a moment ago — is exactly the case
/// an agent that was just told about the file will hit.
///
/// The fallback asks for the list and not for the document. Both would
/// answer the question; only one of them does it without sending ten
/// megabytes across the bridge to find out whose it is.
async fn window_for(app: &tauri::AppHandle, path: &Path) -> Option<String> {
    let known = app.try_state::<Services>().and_then(|services| {
        services
            .session
            .get()
            .window_with(path)
            .map(str::to_owned)
            .filter(|label| app.get_webview_window(label).is_some())
    });
    if known.is_some() {
        return known;
    }
    for label in labels(app) {
        if let Ok(AgentAnswer::Documents { documents }) =
            ask_window(app, &label, AgentRequest::Documents).await
            && documents
                .iter()
                .any(|document| document.path.as_deref() == Some(path))
        {
            return Some(label);
        }
    }
    None
}

/// What an agent is told about a path no window is showing.
fn nowhere(path: &Path) -> Error {
    Error::Unavailable {
        what: path.display().to_string(),
        message: "no window has it open; list_documents says what is".to_owned(),
    }
}

/// Any window but `asked` that has `path` open.
async fn second_window_for(app: &tauri::AppHandle, path: &Path, asked: &str) -> Option<String> {
    for label in labels(app).into_iter().filter(|label| label != asked) {
        if let Ok(AgentAnswer::Documents { documents }) =
            ask_window(app, &label, AgentRequest::Documents).await
            && documents
                .iter()
                .any(|document| document.path.as_deref() == Some(path))
        {
            return Some(label);
        }
    }
    None
}

/// Whether an agent may write here (see the module docs of `mcp`): a
/// document with a tab on it, or a new file inside a folder some window
/// has open.
async fn writable(app: &tauri::AppHandle, path: &Path) -> bool {
    let folder = app.try_state::<Services>().is_some_and(|services| {
        locked(&services.folders)
            .values()
            .any(|folder| path.starts_with(folder.root()))
    });
    // The folder first, because it is a string comparison and the other
    // one is a round trip to a webview.
    folder || window_for(app, path).await.is_some()
}

impl mcp::Desk for Desktop {
    fn documents(&self) -> mcp::Ask<Vec<AgentDocument>> {
        let app = self.app.clone();
        Box::pin(async move {
            let mut documents = Vec::new();
            let mut seen = HashSet::new();
            for label in labels(&app) {
                // A window that cannot answer is left out rather than
                // failing the list: one window busy with a ten megabyte
                // document should not hide the other window's tabs.
                if let Ok(AgentAnswer::Documents { documents: theirs }) =
                    ask_window(&app, &label, AgentRequest::Documents).await
                {
                    for document in theirs {
                        // A file open in two windows is one document.
                        if let Some(path) = document.path.clone()
                            && !seen.insert(path)
                        {
                            continue;
                        }
                        documents.push(document);
                    }
                }
            }
            Ok(documents)
        })
    }

    fn ask(&self, request: AgentRequest) -> mcp::Ask<AgentAnswer> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(path) = request.path().map(Path::to_path_buf) else {
                return unavailable("that question");
            };
            let Some(label) = window_for(&app, &path).await else {
                return Err(nowhere(&path));
            };
            match ask_window(&app, &label, request.clone()).await {
                Ok(answer) => Ok(answer),
                // The session named a window that has since closed the
                // tab. Its refusal is about that window; the question is
                // about the document, so it is put again to whoever has
                // it now.
                Err(refused) => match second_window_for(&app, &path, &label).await {
                    Some(other) => ask_window(&app, &other, request).await,
                    None if matches!(refused, Error::Unavailable { .. }) => Err(nowhere(&path)),
                    None => Err(refused),
                },
            }
        })
    }

    fn snapshots(&self, path: &Path) -> Result<Vec<SnapshotInfo>, Error> {
        let services = self.app.state::<Services>();
        services.history()?.list(path)
    }

    fn snapshot_text(&self, id: &str) -> Result<String, Error> {
        let services = self.app.state::<Services>();
        services.history()?.read(id)
    }

    fn write(&self, path: PathBuf, content: String, agent: String) -> mcp::Ask<SnapshotInfo> {
        let app = self.app.clone();
        Box::pin(async move {
            if !writable(&app, &path).await {
                return Err(Error::Unavailable {
                    what: path.display().to_string(),
                    message: "this server writes open documents, and new files inside a folder the app has open".to_owned(),
                });
            }
            let written = mdreader_core::agent::write_document(&path, &content)?;
            let services = app.state::<Services>();
            // The watcher is about to see this write. Telling it what
            // landed keeps it from reporting the same change a second
            // time, half a second later and with nobody's name on it.
            if let Ok(mut watcher) = services.watcher() {
                let _unused = watcher.note_write(&path, &written.saved.hash);
            }
            let info = services.history()?.snapshot_by(
                &path,
                &written.content,
                SnapshotAuthor::Agent,
                Some(&agent),
            )?;
            let change = ExternalChange {
                path,
                hash: written.saved.hash,
                agent: Some(agent),
                changes: mdreader_core::edits(&written.before, &written.content),
                content: written.content,
            };
            if let Err(error) = ExternalChangeEvent(change).emit(&app) {
                eprintln!("could not tell the windows about an agent write: {error}");
            }
            Ok(info)
        })
    }
}

/// Change what the status bar says and tell every window.
///
/// Untargeted, like the settings: the server is the app's and not a
/// window's, so all of them draw the same thing.
fn change_agent_status(app: &tauri::AppHandle, change: impl FnOnce(&mut AgentStatus)) {
    let Some(services) = app.try_state::<Services>() else {
        return;
    };
    let status = {
        let mut status = locked(&services.agent_status);
        change(&mut status);
        status.clone()
    };
    if let Err(error) = AgentStatusEvent(status).emit(app) {
        eprintln!("could not report the agent status: {error}");
    }
}

/// Start the MCP server: take a port, publish the endpoint, serve.
///
/// Nothing here is worth refusing to launch over. A machine where the
/// loopback address cannot be bound, or an app data directory that
/// cannot be written, is a machine where the reader still opens and
/// edits files; the status bar says the server is off and the palette
/// command that copies a client configuration says why.
fn start_agent_server(app: &tauri::AppHandle) {
    let dir = match app_data(app) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("no agent server: {error}");
            return;
        }
    };
    let (listener, port) = match mcp::bind() {
        Ok(bound) => bound,
        Err(error) => {
            eprintln!("no agent server: {error}");
            return;
        }
    };
    let endpoint = match mcp::publish(&dir, port) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("no agent server: {error}");
            return;
        }
    };
    let services = app.state::<Services>();
    locked(&services.agent_token).clone_from(&endpoint.token);
    {
        let mut status = locked(&services.agent_status);
        status.port = port;
        status.endpoint = Some(mdreader_core::agent::endpoint_path(&dir));
    }
    let desk: Arc<dyn mcp::Desk> = Arc::new(Desktop { app: app.clone() });
    let running = Arc::clone(&services.agent_running);
    {
        let app = app.clone();
        running.on_change(move |clients| {
            change_agent_status(&app, |status| status.clients = clients);
        });
    }
    let token = endpoint.token;
    tauri::async_runtime::spawn(async move {
        mcp::serve::serve(listener, token, desk, running).await;
    });
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
    let (settings, overrides, session) = if let Ok(dir) = app.path().app_config_dir() {
        (
            Store::open(dir.join("settings.json")),
            Store::open(dir.join("overrides.json")),
            Store::open(dir.join("session.json")),
        )
    } else {
        eprintln!("no config directory: this session will not be remembered");
        (Store::memory(), Store::memory(), Store::memory())
    };
    Services {
        watcher,
        history,
        folders: Mutex::new(HashMap::new()),
        searches: Mutex::new(HashMap::new()),
        settings,
        overrides,
        session,
        launch: Mutex::new(HashMap::new()),
        handoff: Mutex::new(HashMap::new()),
        closing: Mutex::new(HashSet::new()),
        quitting: Mutex::new(false),
        agents: Arc::new(mcp::Agents::default()),
        agent_running: Arc::new(mcp::serve::Running::default()),
        agent_token: Mutex::new(String::new()),
        agent_status: Mutex::new(AgentStatus::default()),
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
            export_html,
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
            new_window,
            move_tab,
            take_moved_tabs,
            reveal_path,
            open_folder,
            close_folder,
            list_dir,
            find_files,
            start_search,
            cancel_search,
            create_file,
            rename_path,
            document_override,
            set_document_override,
            answer_agent,
            agent_status,
            rotate_agent_token,
            agent_client_config,
        ])
        .events(collect_events![
            ExternalChangeEvent,
            FileRemovedEvent,
            FileRenamedEvent,
            FolderChangedEvent,
            SearchProgressEvent,
            SearchDoneEvent,
            OpenPathsEvent,
            TabArrivedEvent,
            SettingsChangedEvent,
            BeforeCloseEvent,
            AgentAskEvent,
            AgentStatusEvent
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
    let services = app.state::<Services>();
    // The configuration always opens `main`. A session whose windows
    // were all made later has no `main` in it, so the first of them
    // takes that window over rather than leaving a blank one beside the
    // ones that are restored.
    if services.session.get().window("main").is_none() {
        services.session.update(|session| {
            if let Some(first) = session.windows.first_mut() {
                "main".clone_into(&mut first.label);
            }
        });
    }
    let session = services.session.get();
    // Every window the session had, and not only the configured one: a
    // reader who left two windows open gets two back (design 4.1).
    for state in &session.windows {
        if app.get_webview_window(&state.label).is_none()
            && let Err(error) = spawn(&handle, &state.label)
        {
            eprintln!("could not open the window {}: {error}", state.label);
        }
    }
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
    // Last, because it is the one service nothing else waits for: the
    // windows are up and answering by the time an agent can ask.
    start_agent_server(&handle);
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
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => before_close(window, api),
            // A window that has gone takes its workspace with it, and its
            // place in the session unless it was the last one.
            tauri::WindowEvent::Destroyed => forget(window.app_handle(), window.label()),
            _ => {}
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

    #[test]
    fn a_new_window_takes_the_lowest_number_nothing_is_using() {
        assert_eq!(next_label(&[]), "window-2", "the first one after `main`");
        assert_eq!(
            next_label(&["main".to_owned(), "window-2".to_owned()]),
            "window-3"
        );
        // A window in the middle having closed, its number comes back
        // rather than the count going up for the life of the session.
        assert_eq!(
            next_label(&["main".to_owned(), "window-3".to_owned()]),
            "window-2"
        );
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
