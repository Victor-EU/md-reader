//! Request and response types for commands the design (6.4) declares but
//! later work packages implement: watcher, merge, snapshots, block diff,
//! directory listing, search. Declared now so the generated bindings carry
//! the whole contract from the first version and the frontend fake can
//! implement it.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// One position-based edit the frontend applies as a `CodeMirror` change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct PositionEdit {
    /// UTF-16 offsets into the document the edit applies to.
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

/// A hunk both sides changed, for the frontend to render as a conflict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Conflict {
    pub from: u32,
    pub to: u32,
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MergeResult {
    pub changes: Vec<PositionEdit>,
    pub conflicts: Vec<Conflict>,
}

/// Who wrote a snapshot.
///
/// `Autosave` is separate from `User` because it is the one author that
/// writes on a timer rather than because somebody decided to: the history
/// coalesces a run of those into one version, and never coalesces onto a
/// version anybody asked for (design 6.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotAuthor {
    User,
    Autosave,
    External,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SnapshotInfo {
    pub id: String,
    pub path: PathBuf,
    pub author: SnapshotAuthor,
    #[specta(type = specta_typescript::Number)]
    pub timestamp_ms: u64,
    pub hash: String,
    #[specta(type = specta_typescript::Number)]
    pub byte_len: u64,
}

/// A leaf block as the frontend flattens it (design 7.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Block {
    pub kind: String,
    pub text: String,
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BlockOp {
    Equal { old: u32, new: u32 },
    Changed { old: u32, new: u32 },
    Moved { old: u32, new: u32 },
    Inserted { new: u32 },
    Deleted { old: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DirEntry {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    #[specta(type = specta_typescript::Number)]
    pub byte_len: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub max_results: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchHit {
    pub path: PathBuf,
    pub line: u32,
    pub from: u32,
    pub to: u32,
    pub text: String,
}

/// Payload of the `file_removed` event: a file with a tab open on it is
/// no longer on disk. The buffer stays; the next save recreates the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FileRemoved {
    pub path: PathBuf,
}

/// Payload of the `file_renamed` event: the document is the same, its
/// name is not, so the tab follows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FileRenamed {
    pub from: PathBuf,
    pub to: PathBuf,
}

/// Payload of the `external_change` event (design 6.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct ExternalChange {
    pub path: PathBuf,
    pub content: String,
    pub hash: String,
    /// Edits from the file as the watcher last read it to `content`.
    ///
    /// The shell does not apply these: it merges against its own base,
    /// because a buffer and the file it was saved to are not always the
    /// same string — saving restores the stored form, and a document
    /// whose last newline the reader deleted sits on disk with one.
    /// They are here for a writer that holds both sides itself, which is
    /// the MCP path of Phase 3 (design 9).
    pub changes: Vec<PositionEdit>,
}
