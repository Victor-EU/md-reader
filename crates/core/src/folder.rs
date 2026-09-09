//! The open folder (design 4.1, plan WP 2.4): what the sidebar tree
//! lists, what Cmd+P matches against, and what a change under it means.
//!
//! Everything that decides whether a file is part of the folder goes
//! through the `ignore` crate's walker, which is ripgrep's. One place
//! answers that question, so the tree, the palette and the search cannot
//! disagree about whether `target/` is in the folder. `.gitignore` is
//! honoured because the folders this app is pointed at are the ones an
//! agent works in, and what git is told to ignore is noise to the reader
//! too.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use ignore::WalkBuilder;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, RecommendedCache, new_debouncer};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::document::Error;
use crate::types::{DirEntry, FileHit, FileMatches, FolderChange};

/// Long enough that a checkout or an install is a handful of reports
/// rather than thousands, short enough that a file an agent just wrote
/// appears while the reader is still looking at the tree.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Where the walk behind Cmd+P stops. A folder this size is not one
/// anybody reads their way around, and the alternative to a limit is an
/// app that stops answering while it counts a whole disk. The palette
/// says when it has been reached rather than quietly missing files.
const MAX_FILES: usize = 200_000;

/// The walker every part of this module uses, so "in the folder" means
/// one thing. `require_git` is off: a research folder with a
/// `.gitignore` in it is not usually a repository, and the reader who
/// wrote that file meant it either way.
pub(crate) fn walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false);
    builder
}

fn read_error(path: &Path, message: &str) -> Error {
    Error::Read {
        path: path.to_path_buf(),
        message: message.to_owned(),
    }
}

/// One level of the tree, with folders first and then names, the way a
/// file manager shows it. Anything the walker leaves out is left out
/// here too.
///
/// # Errors
/// Fails when `dir` is not a folder we can read.
pub fn list_dir(dir: &Path) -> Result<Vec<DirEntry>, Error> {
    let meta = fs::metadata(dir).map_err(|error| read_error(dir, &error.to_string()))?;
    if !meta.is_dir() {
        return Err(read_error(dir, "not a folder"));
    }
    let mut out = Vec::new();
    for found in walker(dir).max_depth(Some(1)).build() {
        // The walk starts with the folder itself, which is not one of
        // its own children. An entry we cannot stat is skipped: a
        // listing missing one line beats a tree that will not open.
        let Ok(entry) = found else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let path = entry.path().to_path_buf();
        let Some(name) = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        else {
            continue;
        };
        let meta = entry.metadata().ok();
        out.push(DirEntry {
            is_dir: entry.file_type().is_some_and(|kind| kind.is_dir()),
            byte_len: meta.as_ref().map_or(0, fs::Metadata::len),
            modified_ms: meta
                .and_then(|meta| meta.modified().ok())
                .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                .and_then(|since| u64::try_from(since.as_millis()).ok()),
            path,
            name,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Every file under a root, walked once and kept.
///
/// Cmd+P is typed into: a walk per keystroke is the difference between
/// instant and not. Paths are held relative to the root and separated by
/// `/`, which is what the matcher scores and what the palette shows;
/// the absolute path is put back together for whoever opens the file.
pub struct Index {
    root: PathBuf,
    files: Vec<String>,
    truncated: bool,
}

impl Index {
    /// Walk `root` now. Called off the command thread, because a large
    /// folder takes long enough to be noticed.
    #[must_use]
    pub fn build(root: &Path) -> Self {
        let mut files = Vec::new();
        let mut truncated = false;
        for found in walker(root).build() {
            let Ok(entry) = found else { continue };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            if files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            if let Ok(relative) = entry.path().strip_prefix(root) {
                files.push(slashed(relative));
            }
        }
        Self {
            root: root.to_path_buf(),
            files,
            truncated,
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.files.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// The best `limit` matches for `query`, best first.
    ///
    /// The whole relative path is scored, so `adr conflict` finds
    /// `docs/adr/0019-conflict.md`, but only what falls in the file name
    /// comes back as positions: the palette underlines the name, and an
    /// underline in a row's directory would be pointing at nothing.
    #[must_use]
    pub fn find(&self, query: &str, limit: usize) -> FileMatches {
        let files = u32::try_from(self.files.len()).unwrap_or(u32::MAX);
        let empty = FileMatches {
            hits: Vec::new(),
            files,
            truncated: self.truncated,
        };
        if query.trim().is_empty() || limit == 0 {
            return empty;
        }
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut buf = Vec::new();
        let mut scored: Vec<(u32, usize)> = Vec::new();
        for (at, relative) in self.files.iter().enumerate() {
            if let Some(score) = pattern.score(Utf32Str::new(relative, &mut buf), &mut matcher) {
                scored.push((score, at));
            }
        }
        // Ties are broken the same way every time — shorter path, then
        // alphabetical — so the list does not shuffle under the reader
        // as they type another character that changes nothing.
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| self.files[a.1].len().cmp(&self.files[b.1].len()))
                .then_with(|| self.files[a.1].cmp(&self.files[b.1]))
        });
        scored.truncate(limit);
        let hits = scored
            .into_iter()
            .map(|(_, at)| self.hit(&pattern, &mut matcher, at))
            .collect();
        FileMatches { hits, ..empty }
    }

    fn hit(&self, pattern: &Pattern, matcher: &mut Matcher, at: usize) -> FileHit {
        let relative = &self.files[at];
        let mut buf = Vec::new();
        let mut indices = Vec::new();
        pattern.indices(Utf32Str::new(relative, &mut buf), matcher, &mut indices);
        indices.sort_unstable();
        indices.dedup();
        let (dir, name) = match relative.rsplit_once('/') {
            Some((dir, name)) => (dir, name),
            None => ("", relative.as_str()),
        };
        FileHit {
            path: self.root.join(relative),
            positions: within(
                name,
                &indices,
                relative.chars().count() - name.chars().count(),
            ),
            name: name.to_owned(),
            dir: dir.to_owned(),
        }
    }
}

/// A relative path as one string with `/` separators, which is what the
/// matcher scores and what a palette row shows on either platform.
fn slashed(relative: &Path) -> String {
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The matched positions that fall inside the file name, as UTF-16
/// offsets into it — the offsets every position on the IPC is counted
/// in, because the other side of the bridge indexes strings that way.
fn within(name: &str, indices: &[u32], start: usize) -> Vec<u32> {
    let mut offsets = Vec::with_capacity(name.len());
    let mut at = 0_u32;
    for ch in name.chars() {
        offsets.push(at);
        at += u32::try_from(ch.len_utf16()).unwrap_or(1);
    }
    indices
        .iter()
        .filter_map(|index| {
            let index = usize::try_from(*index).ok()?;
            offsets.get(index.checked_sub(start)?).copied()
        })
        .collect()
}

/// The folder a window has open: the index behind Cmd+P, and the watch
/// that keeps the tree and the index true while other programs work in
/// it (design 4.1).
pub struct Folder {
    /// The root as the reader gave it, which is what every path handed
    /// out is built from.
    root: PathBuf,
    /// Built on demand and dropped whenever something under the root
    /// changes. A rebuild is a walk; the debounce keeps a checkout from
    /// asking for thousands of them.
    index: Arc<Mutex<Option<Index>>>,
    /// Dropping this stops the watch, which is the only reason it is
    /// kept.
    _watch: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
}

impl Folder {
    /// Adopt `root` and start watching it.
    ///
    /// `changed` is called from the watcher's own thread with the
    /// folders whose listings may no longer be right. A folder that
    /// cannot be watched is still opened: a tree that does not refresh
    /// itself is worth more than no tree.
    ///
    /// # Errors
    /// Fails when `root` is not a folder we can read.
    pub fn open(
        root: &Path,
        changed: impl Fn(FolderChange) + Send + 'static,
    ) -> Result<Self, Error> {
        let meta = fs::metadata(root).map_err(|error| read_error(root, &error.to_string()))?;
        if !meta.is_dir() {
            return Err(read_error(root, "not a folder"));
        }
        let root = root.to_path_buf();
        let index = Arc::new(Mutex::new(None));
        let stale = Arc::clone(&index);
        // A folder reached through a symlink — every temporary folder on
        // macOS is one — is watched at its real location and reports
        // events from there. The tree knows it by the name the reader
        // opened, so events come back translated into that.
        let real = root.canonicalize().unwrap_or_else(|_| root.clone());
        let shown = root.clone();
        let skip = ignores(&root);
        let watch = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut dirs: Vec<PathBuf> = Vec::new();
            for path in events.iter().flat_map(|event| event.paths.iter()) {
                let here = path
                    .strip_prefix(&real)
                    .map_or_else(|_| path.clone(), |rest| shown.join(rest));
                if noise(&skip, &shown, &here) {
                    continue;
                }
                if let Some(dir) = here.parent().map(Path::to_path_buf)
                    && !dirs.contains(&dir)
                {
                    dirs.push(dir);
                }
            }
            if dirs.is_empty() {
                return;
            }
            // The walk is thrown away rather than redone here: nothing
            // is waiting for it, and the next Cmd+P will pay for one.
            if let Ok(mut index) = stale.lock() {
                *index = None;
            }
            changed(FolderChange {
                root: shown.clone(),
                dirs,
            });
        })
        .ok();
        let watch = watch.and_then(|mut watch| {
            watch
                .watch(&root, RecursiveMode::Recursive)
                .map_err(|error| eprintln!("cannot watch {}: {error}", root.display()))
                .ok()?;
            Some(watch)
        });
        Ok(Self {
            root,
            index,
            _watch: watch,
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The best matches for `query`, walking the folder first if the
    /// walk has never been done or has been thrown away.
    #[must_use]
    pub fn find(&self, query: &str, limit: usize) -> FileMatches {
        let Ok(mut held) = self.index.lock() else {
            return FileMatches {
                hits: Vec::new(),
                files: 0,
                truncated: false,
            };
        };
        let index = held.get_or_insert_with(|| Index::build(&self.root));
        index.find(query, limit)
    }

    /// Walk now, so the first Cmd+P after opening a folder does not have
    /// to. Called on a thread of its own; a query that arrives meanwhile
    /// waits for this rather than starting a second walk.
    pub fn warm(&self) {
        if let Ok(mut held) = self.index.lock() {
            held.get_or_insert_with(|| Index::build(&self.root));
        }
    }
}

/// The ignore rules the watcher can apply on its own. The walker reads
/// nested `.gitignore` files as it goes; a watcher event is one path
/// with no walk behind it, so this is the root's rules and the dotted
/// names, which is what keeps `target/` and `.git/` from waking the tree.
fn ignores(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    let _unused = builder.add(root.join(".gitignore"));
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// Whether a changed path is one the folder does not contain anyway.
fn noise(skip: &Gitignore, root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    if relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return true;
    }
    skip.matched_path_or_any_parents(path, false).is_ignore()
}

/// A name for a file the reader is about to make, refused if it is a
/// path rather than a name: the sidebar's rename field types into one
/// folder, and `../elsewhere.md` would leave it.
fn plain(name: &str) -> Result<&str, Error> {
    let name = name.trim();
    let bad =
        name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\');
    if bad {
        return Err(Error::Write {
            path: PathBuf::from(name),
            message: "a file name, not a path".to_owned(),
        });
    }
    Ok(name)
}

/// Split a file name into what a number goes between: `notes.md` is
/// `notes` and `.md`, and `README` is `README` and nothing.
fn stem(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // A leading dot is the whole name of a dotfile, not an extension.
        Some(at) if at > 0 => name.split_at(at),
        _ => (name, ""),
    }
}

/// Create an empty file in `dir`, named `name` or the first free number
/// after it (design 4.5's "New file"): `Untitled.md`, `Untitled 2.md`.
///
/// Numbering here rather than in the window because this is where the
/// folder is: a name chosen from a listing the sidebar read a moment ago
/// could be taken by the time it is used.
///
/// # Errors
/// Fails when `name` is not a plain file name, or the file cannot be
/// created.
pub fn create_file(dir: &Path, name: &str) -> Result<PathBuf, Error> {
    let name = plain(name)?;
    let (stem, ext) = stem(name);
    for n in 1..1000 {
        let path = dir.join(if n == 1 {
            name.to_owned()
        } else {
            format!("{stem} {n}{ext}")
        });
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(Error::Write {
                    path,
                    message: error.to_string(),
                });
            }
        }
    }
    Err(Error::Write {
        path: dir.join(name),
        message: "a thousand files of this name already".to_owned(),
    })
}

/// Rename a file within its folder, which is what the sidebar's inline
/// rename does. A name already taken is refused rather than replaced:
/// nothing in this app overwrites a file the reader did not name.
///
/// # Errors
/// Fails when `name` is not a plain file name, when something of that
/// name is already there, or when the rename itself fails.
pub fn rename(from: &Path, name: &str) -> Result<PathBuf, Error> {
    let name = plain(name)?;
    let dir = from.parent().ok_or_else(|| Error::Write {
        path: from.to_path_buf(),
        message: "no folder to rename within".to_owned(),
    })?;
    let to = dir.join(name);
    if to == from {
        return Ok(to);
    }
    if to.exists() {
        return Err(Error::Write {
            path: to,
            message: "there is already a file with that name".to_owned(),
        });
    }
    fs::rename(from, &to).map_err(|error| Error::Write {
        path: to.clone(),
        message: error.to_string(),
    })?;
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder with a few files in it, and the paths written out.
    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        for (path, content) in files {
            let at = dir.path().join(path);
            if let Some(parent) = at.parent() {
                fs::create_dir_all(parent).expect("folders");
            }
            fs::write(at, content).expect("file");
        }
        dir
    }

    fn names(entries: &[DirEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_and_then_names() {
        let dir = folder(&[("b.md", "b"), ("A.md", "a"), ("sub/c.md", "c")]);
        let listed = list_dir(dir.path()).expect("list");
        assert_eq!(names(&listed), ["sub", "A.md", "b.md"]);
        assert!(listed[0].is_dir);
        assert_eq!(listed[2].byte_len, 1);
    }

    #[test]
    fn leaves_out_what_gitignore_says_to() {
        let dir = folder(&[
            (".gitignore", "drafts/\nnotes.tmp\n"),
            ("keep.md", "keep"),
            ("notes.tmp", "no"),
            ("drafts/old.md", "no"),
        ]);
        assert_eq!(names(&list_dir(dir.path()).expect("list")), ["keep.md"]);
        let index = Index::build(dir.path());
        assert_eq!(index.len(), 1);
    }

    /// A folder given to this app is usually not a repository. The rules
    /// in the file are the reader's either way.
    #[test]
    fn honours_gitignore_outside_a_repository() {
        let dir = folder(&[(".gitignore", "*.log\n"), ("a.md", "a"), ("run.log", "no")]);
        assert_eq!(names(&list_dir(dir.path()).expect("list")), ["a.md"]);
    }

    #[test]
    fn leaves_out_dotted_names() {
        let dir = folder(&[(".hidden.md", "no"), ("shown.md", "yes")]);
        assert_eq!(names(&list_dir(dir.path()).expect("list")), ["shown.md"]);
    }

    #[test]
    fn refuses_to_list_something_that_is_not_a_folder() {
        let dir = folder(&[("a.md", "a")]);
        assert!(list_dir(&dir.path().join("a.md")).is_err());
        assert!(list_dir(&dir.path().join("nowhere")).is_err());
    }

    #[test]
    fn walks_the_whole_tree_for_the_palette() {
        let dir = folder(&[("a.md", ""), ("one/b.md", ""), ("one/two/c.md", "")]);
        let index = Index::build(dir.path());
        assert_eq!(index.len(), 3);
        assert!(!index.is_empty());
        let found = index.find("c", 10);
        assert_eq!(found.files, 3);
        assert!(!found.truncated);
        assert_eq!(found.hits[0].name, "c.md");
        assert_eq!(found.hits[0].dir, "one/two");
        assert_eq!(found.hits[0].path, dir.path().join("one/two/c.md"));
    }

    /// The point of matching the whole relative path: a query that names
    /// the folder as well as the file finds it.
    #[test]
    fn matches_the_path_and_underlines_the_name() {
        let dir = folder(&[("adr/0019-conflict.md", ""), ("notes/conflict.md", "")]);
        let found = Index::build(dir.path()).find("adrconf", 10);
        assert_eq!(found.hits.len(), 1);
        let hit = &found.hits[0];
        assert_eq!(hit.name, "0019-conflict.md");
        // `adr` matched in the directory, which the name cannot underline;
        // `conf` matched in the name, which it can.
        let underlined: String = hit
            .positions
            .iter()
            .filter_map(|at| hit.name.chars().nth(usize::try_from(*at).ok()?))
            .collect();
        assert_eq!(underlined, "conf");
    }

    #[test]
    fn finds_nothing_for_a_query_that_matches_nothing() {
        let dir = folder(&[("a.md", "")]);
        assert!(Index::build(dir.path()).find("zzz", 10).hits.is_empty());
    }

    /// An empty query is the palette showing its recents, not a request
    /// for every file in the folder.
    #[test]
    fn answers_an_empty_query_with_nothing() {
        let dir = folder(&[("a.md", ""), ("b.md", "")]);
        let found = Index::build(dir.path()).find("  ", 10);
        assert!(found.hits.is_empty());
        assert_eq!(found.files, 2);
    }

    #[test]
    fn gives_back_no_more_than_it_was_asked_for() {
        let files: Vec<(String, &str)> = (0..30).map(|n| (format!("note{n}.md"), "")).collect();
        let pairs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), *b)).collect();
        let dir = folder(&pairs);
        assert_eq!(Index::build(dir.path()).find("note", 5).hits.len(), 5);
    }

    /// Positions are UTF-16 offsets because that is what the other side
    /// of the bridge indexes strings by.
    #[test]
    fn counts_positions_the_way_the_frontend_will() {
        let dir = folder(&[("🌍 world.md", "")]);
        let found = Index::build(dir.path()).find("world", 5);
        let hit = &found.hits[0];
        // The globe is one character and two UTF-16 units, so `world`
        // starts at 3 rather than at 2.
        assert_eq!(hit.positions.first().copied(), Some(3));
    }

    #[test]
    fn creates_a_file_and_then_numbers_the_next_one() {
        let dir = folder(&[]);
        let first = create_file(dir.path(), "Untitled.md").expect("create");
        assert_eq!(first, dir.path().join("Untitled.md"));
        assert_eq!(fs::read_to_string(&first).expect("read"), "");
        let second = create_file(dir.path(), "Untitled.md").expect("create");
        assert_eq!(second, dir.path().join("Untitled 2.md"));
    }

    #[test]
    fn refuses_a_name_that_is_a_path() {
        let dir = folder(&[]);
        assert!(create_file(dir.path(), "../escape.md").is_err());
        assert!(create_file(dir.path(), "sub/deep.md").is_err());
        assert!(create_file(dir.path(), "  ").is_err());
    }

    #[test]
    fn renames_within_the_folder() {
        let dir = folder(&[("draft.md", "text")]);
        let to = rename(&dir.path().join("draft.md"), "Notes.md").expect("rename");
        assert_eq!(to, dir.path().join("Notes.md"));
        assert_eq!(fs::read_to_string(&to).expect("read"), "text");
        assert!(!dir.path().join("draft.md").exists());
    }

    /// Nothing in this app overwrites a file the reader did not name.
    #[test]
    fn refuses_a_rename_onto_a_file_that_is_there() {
        let dir = folder(&[("one.md", "one"), ("two.md", "two")]);
        assert!(rename(&dir.path().join("one.md"), "two.md").is_err());
        assert_eq!(
            fs::read_to_string(dir.path().join("two.md")).expect("read"),
            "two"
        );
    }

    #[test]
    fn renaming_a_file_to_its_own_name_is_nothing() {
        let dir = folder(&[("one.md", "one")]);
        let path = dir.path().join("one.md");
        assert_eq!(rename(&path, "one.md").expect("rename"), path);
    }

    #[test]
    fn a_folder_watch_reports_a_file_written_under_it() {
        use std::sync::mpsc::channel;

        let dir = folder(&[("a.md", "a")]);
        let (send, recv) = channel();
        let folder = Folder::open(dir.path(), move |change| {
            let _unused = send.send(change);
        })
        .expect("open");
        assert_eq!(folder.root(), dir.path());
        fs::write(dir.path().join("b.md"), "b").expect("write");
        let change = recv
            .recv_timeout(Duration::from_secs(5))
            .expect("a report of the write");
        assert_eq!(change.root, dir.path());
        assert_eq!(change.dirs, vec![dir.path().to_path_buf()]);
        // And the walk behind Cmd+P has the new file in it.
        assert_eq!(folder.find("b", 5).hits.len(), 1);
    }

    /// The reason for the filter: a build writing into `target/` must not
    /// wake the tree, and there is no walk behind a watcher event to ask.
    #[test]
    fn a_folder_watch_says_nothing_about_what_is_ignored() {
        use std::sync::mpsc::RecvTimeoutError;
        use std::sync::mpsc::channel;

        let dir = folder(&[(".gitignore", "build/\n"), ("a.md", "a")]);
        fs::create_dir_all(dir.path().join("build")).expect("folder");
        let (send, recv) = channel();
        let _folder = Folder::open(dir.path(), move |change| {
            let _unused = send.send(change);
        })
        .expect("open");
        fs::write(dir.path().join("build/out.js"), "x").expect("write");
        fs::write(dir.path().join(".hidden"), "x").expect("write");
        assert_eq!(
            recv.recv_timeout(Duration::from_millis(800)),
            Err(RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn refuses_to_open_something_that_is_not_a_folder() {
        let dir = folder(&[("a.md", "a")]);
        assert!(Folder::open(&dir.path().join("a.md"), |_| {}).is_err());
    }
}
