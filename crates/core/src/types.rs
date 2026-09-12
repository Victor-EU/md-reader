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
    /// The name the agent gave itself, for a version an agent wrote
    /// (design 9). `None` for every other author, and for an agent write
    /// from a build older than plan WP 3.1.
    pub agent: Option<String>,
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
    /// The agent that wrote it, by the name it gave, when the write came
    /// in over MCP rather than from the watcher (design 9). Plain file
    /// watching cannot tell us who wrote a file; this can, which is what
    /// makes the change attributable in the gutter and in the history.
    pub agent: Option<String>,
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

// --- what an agent asks the window (design 9, plan WP 3.1) --------------
//
// The MCP server runs in Rust and most of its tools are questions about
// a buffer: what it holds now, what the reader marked in it, what
// changed in it since a version. None of those are on disk and none of
// them are Rust's — the buffer is the editor's, and the marks and the
// blocks come out of a parse tree only the frontend has. So the server
// asks the window that has the document open, and these are the words.
// One of them is not a question but a request: open this file, which
// only a window can do, and which it answers once the tab is there.
//
// The alternative was a mirror: the window pushing its buffer, its
// annotations and its blocks into Rust whenever they settle, so the
// server could answer from memory. That pays on every keystroke for a
// question that gets asked once a minute, and at ten megabytes it is a
// quarter of a second of flattening per pause in typing. Asking costs
// nothing until somebody asks.

/// What the reader did to a span (design 4.3).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationMark {
    Highlight,
    Strikethrough,
    Color,
    /// A comment with no mark of its own, which is still something the
    /// reader said.
    Comment,
}

/// The closed comment vocabulary of design 4.3. Closed is what makes the
/// comments machine-readable, which is the whole point of them.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Note,
    Attention,
    Question,
    Remove,
    Keep,
    Rewrite,
}

/// One `<!-- kind: text -->` as an agent reads it.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
pub struct AgentComment {
    pub kind: AnnotationKind,
    pub text: String,
}

/// One annotation, as `list_annotations` returns it.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
pub struct AgentAnnotation {
    pub mark: AnnotationMark,
    /// The palette word a colour stands for, absent for a colour the
    /// reader chose themselves and for every other mark.
    pub meaning: Option<AnnotationKind>,
    /// The source under the mark, collapsed to one line. The source and
    /// not a rendering of it: an agent reading `the **first** step` is
    /// looking at what the file says, which is the point of the round
    /// trip.
    pub anchor: String,
    /// UTF-16 offsets of the marked span in the current buffer.
    pub from: u32,
    pub to: u32,
    pub comment: Option<AgentComment>,
}

/// What became of one block between two versions.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum AgentOp {
    Changed,
    Moved,
    Inserted,
    Deleted,
}

/// One block of the semantic diff, as `changes_since` returns it.
///
/// Blocks that did not change are left out. The alignment keeps them
/// because a consumer walking both sides needs them (see [`BlockOp`]);
/// an agent asking what changed does not.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
pub struct AgentChange {
    pub op: AgentOp,
    /// What kind of block it is, as the flattener names it.
    pub kind: String,
    /// What it said then. Empty for a block that has just arrived.
    pub old: String,
    /// What it says now. Empty for a block that is gone.
    pub new: String,
    /// Where it is in the document now, in UTF-16 offsets. Absent for a
    /// block that is gone, which is nowhere.
    pub from: Option<u32>,
    pub to: Option<u32>,
}

/// One open document, as `list_documents` returns it.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type, schemars::JsonSchema,
)]
pub struct AgentDocument {
    /// Absent for a document that has never been saved, which an agent
    /// can read but has no path to write to.
    pub path: Option<PathBuf>,
    /// What the tab calls it.
    pub name: String,
    /// The buffer is ahead of the file. Under autosave this is true for
    /// about a second after a keystroke and false the rest of the time.
    pub dirty: bool,
    /// Length of the buffer in bytes of UTF-8 — the buffer's, not the
    /// file's, because the buffer is what the other tools return.
    #[specta(type = specta_typescript::Number)]
    pub byte_len: u64,
    /// Last modification time of the file, when there is a file.
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_ms: Option<u64>,
}

/// What the server is asking one window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "ask", rename_all = "snake_case")]
pub enum AgentRequest {
    /// Every document this window has open.
    Documents,
    /// The buffer, which may be ahead of disk.
    Read {
        path: PathBuf,
    },
    Annotations {
        path: PathBuf,
    },
    /// The semantic diff from `against` to the buffer. Rust reads the
    /// old version out of the history and sends the text, because the
    /// window has no way to open a snapshot of its own.
    Changes {
        path: PathBuf,
        against: String,
    },
    /// Open a tab on the file and bring it in front. The one request
    /// that is about a document the window does not have yet.
    Open {
        path: PathBuf,
    },
}

impl AgentRequest {
    /// The document this is about. Every question but `Documents` is
    /// about one, and which one is how the server finds the window to
    /// put it to.
    #[must_use]
    pub fn path(&self) -> Option<&std::path::Path> {
        match self {
            Self::Documents => None,
            Self::Read { path }
            | Self::Annotations { path }
            | Self::Changes { path, .. }
            | Self::Open { path } => Some(path),
        }
    }
}

/// What one window answered.
///
/// `Failed` is a real answer and not an error: a window that has since
/// closed the tab knows something the server needs to hear, and the
/// alternative is the server waiting out its timeout for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum AgentAnswer {
    Documents {
        documents: Vec<AgentDocument>,
    },
    Text {
        text: String,
        dirty: bool,
    },
    Annotations {
        annotations: Vec<AgentAnnotation>,
    },
    /// Both sides flattened into blocks. The window is the side that
    /// holds the parse trees; the alignment is Rust's, the same one the
    /// gutter and Review are drawn from (design 7.3).
    Changes {
        old: Vec<Block>,
        new: Vec<Block>,
    },
    /// The tab is open. `name` is what it is called there.
    Opened {
        name: String,
    },
    Failed {
        message: String,
    },
}

/// One question on its way to a window, with the number its answer comes
/// back under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AgentAsk {
    pub id: u32,
    pub request: AgentRequest,
}

/// What the status bar says about the server (plan WP 3.1).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
pub struct AgentStatus {
    /// The port it is listening on. Zero when it did not start, which is
    /// what the status bar reads as "off" rather than as a port.
    pub port: u16,
    /// Where a client is configured from.
    pub endpoint: Option<PathBuf>,
    /// How many MCP sessions are open right now.
    ///
    /// Exact the moment a request has been served, because a session
    /// begins and ends on one. Late by up to the transport's own idle
    /// timeout for a client that goes away without saying so.
    pub clients: u32,
}
