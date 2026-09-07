//! Library crate for the markdown app: file IO, and later the watcher,
//! history, diff, and search. No Tauri types.

pub mod atomic;
pub mod document;
pub mod eol;
pub mod types;

pub use document::{
    Document, DocumentMeta, Error, FileFormat, SaveResult, convert_to_utf8, encode, hash_bytes,
    read_document, save_document,
};
pub use eol::Eol;
pub use types::{
    Block, BlockOp, Conflict, DirEntry, ExternalChange, MergeResult, PositionEdit, SearchHit,
    SearchOptions, SnapshotAuthor, SnapshotInfo,
};
