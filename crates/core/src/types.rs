//! Request and response types for the commands whose own modules do not
//! own them: the watcher, the merge, snapshots, the block diff, the
//! folder tree, Cmd+P and the content search.
//!
//! They were all declared here before they were implemented, so that the
//! generated bindings carried the whole contract from the first version
//! and the frontend fake could answer it. As of plan WP 2.4 every one of
//! them is implemented; the shape is what stayed.

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

/// A run of words that differ inside a pair of blocks the diff matched
/// (design 7.3 step 3), as offsets into each side's block text.
///
/// The offsets are into the block's text and not into the document,
/// because the text is the normalized form: the words of a rewrapped
/// paragraph are in different places in the file and the same places in
/// what it says. Reverting is a block at a time, which is what the
/// block's own range is for.
///
/// One side is empty where the run is only an insertion or only a
/// deletion, and sits where the missing words would go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct WordRun {
    pub old_from: u32,
    pub old_to: u32,
    pub new_from: u32,
    pub new_to: u32,
}

/// One step of the alignment of two block lists (design 7.3).
///
/// The whole alignment is returned, `Equal` included, because that is
/// what makes it an alignment: a consumer can walk both sides in step
/// and knows what became of every block. `old` and `new` are indices
/// into the lists that were sent, which carry the source ranges.
///
/// A block that moved is reported once, where it arrived. Reporting the
/// place it left as a deletion as well would mark the reader's document
/// in two places for one thing having happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BlockOp {
    Equal {
        old: u32,
        new: u32,
    },
    Changed {
        old: u32,
        new: u32,
        words: Vec<WordRun>,
    },
    Moved {
        old: u32,
        new: u32,
    },
    Inserted {
        new: u32,
    },
    Deleted {
        old: u32,
    },
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

/// One file Cmd+P is offering, with the part of its name the query
/// matched so the palette can underline it (plan WP 2.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FileHit {
    pub path: PathBuf,
    pub name: String,
    /// The folder it is in, relative to the root and empty at the root.
    pub dir: String,
    /// UTF-16 offsets into `name` that the query matched.
    pub positions: Vec<u32>,
}

/// What one Cmd+P query came back with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FileMatches {
    pub hits: Vec<FileHit>,
    /// How many files the folder walk holds, matched or not.
    pub files: u32,
    /// The walk stopped at its limit, so the folder holds files that
    /// nothing here was matched against. The palette says so rather than
    /// quietly leaving them out.
    pub truncated: bool,
}

/// Payload of the `folder_changed` event: something under the open
/// folder was written, and these are the folders whose listings may no
/// longer be right.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FolderChange {
    pub root: PathBuf,
    pub dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub max_results: u32,
}

/// One line of one file that a search matched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchHit {
    pub path: PathBuf,
    /// One-based, the way an editor counts lines.
    pub line: u32,
    /// UTF-16 offsets of the match within `text`, which is what the
    /// results panel highlights.
    pub from: u32,
    pub to: u32,
    /// Where the match is in the line itself, which is where the cursor
    /// goes. Not the same as `from` when a very long line has been cut
    /// down to what a row can show.
    pub column: u32,
    /// The line as a row shows it, cut around the match when it is long.
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

/// Payload of the `search_progress` event: some of what one search has
/// found so far. Results are sent in batches as they arrive, so a panel
/// fills while the walk is still going (plan WP 2.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchProgress {
    /// Which search these belong to. A reader who types again while the
    /// last one is still walking gets a new id, and the old one's
    /// leftovers are recognized and dropped.
    pub id: u32,
    pub hits: Vec<SearchHit>,
}

/// Payload of the `search_done` event: that search is over, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SearchDone {
    pub id: u32,
    pub hits: u32,
    /// The result limit was reached; the folder holds more.
    pub truncated: bool,
    /// Another search replaced this one before it finished.
    pub cancelled: bool,
}
