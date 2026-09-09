//! Library crate for the markdown app: file IO, and later the watcher,
//! history, diff, and search. No Tauri types.

pub mod agent;
pub mod assets;
pub mod atomic;
pub mod blocks;
pub mod diff;
pub mod document;
pub mod eol;
pub mod export;
pub mod folder;
pub mod history;
pub mod search;
pub mod state;
pub mod types;
pub mod watch;

pub use agent::{Endpoint, authorized as agent_authorized, new_token};
pub use assets::{AssetWrite, copy_asset, image_type, store_asset};
pub use blocks::{agent_changes, block_diff};
pub use diff::{apply, edits, merge3};
pub use document::{
    Document, DocumentMeta, EDITABLE_BYTES, Error, FileFormat, OPEN_BYTES, ReadOnly, SaveResult,
    convert_to_utf8, encode, hash_bytes, read_document, save_document,
};
pub use eol::Eol;
pub use export::{ExportWrite, write_export};
pub use folder::{Folder, Index, create_file, list_dir, rename};
pub use history::History;
pub use search::{Found, check as check_search, search};
pub use state::{
    Appearance, Bounds, Cursor, DocumentOverride, DocumentState, Family, Override, Overrides,
    Paper, Restore, Session, Settings, SidebarPanel, Store, TabKind, TabMode, TabMove, TabMoved,
    TabState, ThemeId, Untitled, WindowContent, WindowState,
};
pub use types::{
    AgentAnnotation, AgentAnswer, AgentAsk, AgentChange, AgentComment, AgentDocument, AgentOp,
    AgentRequest, AgentStatus, AnnotationKind, AnnotationMark, Block, BlockOp, Conflict, DirEntry,
    ExternalChange, FileHit, FileMatches, FileRemoved, FileRenamed, FolderChange, MergeResult,
    PositionEdit, SearchDone, SearchHit, SearchOptions, SearchProgress, SnapshotAuthor,
    SnapshotInfo, WordRun,
};
pub use watch::{WatchEvent, Watcher};
