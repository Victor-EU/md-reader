//! Tauri command handlers and the IPC contract (design 6.4). Each command
//! is a thin adapter over `mdreader_core`; commands later work packages
//! implement are declared here as stubs so the generated bindings carry
//! the whole contract and cannot drift from it.

// Command arguments arrive owned from the IPC deserializer; borrowing them
// would only add a clone on the caller side.
#![allow(clippy::needless_pass_by_value)]

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use mdreader_core::{
    Block, BlockOp, DirEntry, Document, Error, ExternalChange, FileFormat, FileRemoved,
    FileRenamed, History, MergeResult, SaveResult, SearchHit, SearchOptions, SnapshotAuthor,
    SnapshotInfo, WatchEvent, Watcher,
};
use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// The two things that outlive a command: the folder watches behind the
/// open documents, and the history store.
///
/// Either can fail to start — a platform without a working watcher, a
/// history directory that cannot be created — and the app still opens
/// files and saves them. What failed says so when it is asked for.
struct Services {
    watcher: Option<Mutex<Watcher>>,
    history: Option<Mutex<History>>,
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
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| Error::Read {
            path: path.clone(),
            message: "no folder to allow images from".to_owned(),
        })?;
    tauri::Manager::asset_protocol_scope(&app)
        .allow_directory(dir, true)
        .map_err(|error| Error::Read {
            path: dir.to_path_buf(),
            message: error.to_string(),
        })
}

/// Rewrite a non-UTF-8 file as UTF-8 and return it freshly read.
#[tauri::command]
#[specta::specta]
fn convert_document_to_utf8(path: PathBuf) -> Result<Document, Error> {
    mdreader_core::convert_to_utf8(&path)
}

fn not_implemented<T>(command: &str) -> Result<T, Error> {
    Err(Error::NotImplemented {
        command: command.to_owned(),
    })
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

/// Align two block lists for the semantic diff (WP 2.x).
#[tauri::command]
#[specta::specta]
fn block_diff(old_blocks: Vec<Block>, new_blocks: Vec<Block>) -> Result<Vec<BlockOp>, Error> {
    let _ = (old_blocks, new_blocks);
    not_implemented("block_diff")
}

/// List a directory, honouring `.gitignore` (WP 2.x).
#[tauri::command]
#[specta::specta]
fn list_dir(path: PathBuf) -> Result<Vec<DirEntry>, Error> {
    let _ = path;
    not_implemented("list_dir")
}

/// Search file contents under `root` (WP 2.x).
#[tauri::command]
#[specta::specta]
fn search(root: PathBuf, query: String, options: SearchOptions) -> Result<Vec<SearchHit>, Error> {
    let _ = (root, query, options);
    not_implemented("search")
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

/// Start the watcher and the history store.
///
/// Neither is worth refusing to launch over: a reader with no history is
/// a reader who can still read, and the commands that need one say so.
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
    Services { watcher, history }
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
            watch,
            unwatch,
            merge3,
            snapshot,
            list_snapshots,
            read_snapshot,
            block_diff,
            list_dir,
            search,
        ])
        .events(collect_events![
            ExternalChangeEvent,
            FileRemovedEvent,
            FileRenamedEvent
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

/// Build and run the application with the given generated context.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run(context: tauri::Context) {
    let builder = ipc_builder();
    #[cfg(debug_assertions)]
    if let Err(e) = export_bindings(&bindings_path()) {
        eprintln!("could not export IPC bindings: {e}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Links in Read mode open in the system browser; the webview never
        // navigates away from the app (design 6.2).
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let handle = app.handle().clone();
            app.manage(services(&handle));
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
