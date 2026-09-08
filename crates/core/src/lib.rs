//! Library crate for the markdown app: file IO, and later the watcher,
//! history, diff, and search. No Tauri types.

pub mod assets;
pub mod atomic;
pub mod diff;
pub mod document;
pub mod eol;
pub mod history;
pub mod state;
pub mod types;
pub mod watch;

pub use assets::{AssetWrite, copy_asset, store_asset};
pub use diff::{apply, edits, merge3};
pub use document::{
    Document, DocumentMeta, Error, FileFormat, SaveResult, convert_to_utf8, encode, hash_bytes,
    read_document, save_document,
};
pub use eol::Eol;
pub use history::History;
pub use state::{
    Appearance, Bounds, Cursor, DocumentState, Family, Paper, Restore, Session, Settings, Store,
    TabKind, TabMode, TabState, Untitled, WindowContent, WindowState,
};
pub use types::{
    Block, BlockOp, Conflict, DirEntry, ExternalChange, FileRemoved, FileRenamed, MergeResult,
    PositionEdit, SearchHit, SearchOptions, SnapshotAuthor, SnapshotInfo,
};
pub use watch::{WatchEvent, Watcher};
