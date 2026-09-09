//! Local history: every version of a document the app has seen (design
//! 4.4, plan WP 1.7).
//!
//! A snapshot is taken when a file is opened, when someone else writes to
//! it, and when the app saves it. That is enough that nothing the reader
//! or an agent does can lose text, which is what the whole design leans on
//! when it merges an external write in place instead of asking.
//!
//! The index is SQLite and the content is zstd blobs addressed by hash, so
//! the ten snapshots of a document whose last paragraph keeps changing
//! cost ten rows and ten blobs, while ten snapshots that undid and redid
//! the same edit cost ten rows and two blobs.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use crate::document::{Error, hash_bytes};
use crate::types::{SnapshotAuthor, SnapshotInfo};

/// zstd's default level. Markdown is text, so this is already most of the
/// compression there is to have, and it costs microseconds.
const ZSTD_LEVEL: i32 = 3;

/// Everything younger than this is kept as it was taken; past it only the
/// last snapshot of each day survives (design 6.3).
const KEEP_ALL_DAYS: u64 = 30;

/// How long one autosaved version stands for.
///
/// Autosave writes the file a second after every pause in typing (design
/// 6.6), and a snapshot per write would make this a log of keystrokes
/// rather than a history of versions: hundreds of rows an hour, each a
/// compressed copy of the document. So a run of autosaves updates the
/// version it started, and a new one begins once that version is this
/// old. What a reader can go back to is every couple of minutes of their
/// own typing, plus every version anybody asked for.
const COALESCE_MS: u64 = 2 * 60 * 1000;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// The schema, one statement per version. Only ever append: the store on
/// disk is a user's history, and it outlives every release.
const MIGRATIONS: &[&str] = &[concat!(
    "CREATE TABLE snapshots (",
    "  id           TEXT PRIMARY KEY,",
    "  path         TEXT NOT NULL,",
    "  author       TEXT NOT NULL,",
    "  timestamp_ms INTEGER NOT NULL,",
    "  hash         TEXT NOT NULL,",
    "  byte_len     INTEGER NOT NULL",
    ");",
    "CREATE INDEX snapshots_by_path ON snapshots (path, timestamp_ms DESC);",
    "CREATE INDEX snapshots_by_hash ON snapshots (hash);",
)];

fn failed(what: &str, error: &dyn std::fmt::Display) -> Error {
    Error::Unavailable {
        what: "the history".to_owned(),
        message: format!("cannot {what}: {error}"),
    }
}

/// SQLite counts in signed 64-bit integers; the app counts milliseconds
/// since the epoch, which fits with three hundred million years to spare.
fn sql(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn author_name(author: SnapshotAuthor) -> &'static str {
    match author {
        SnapshotAuthor::User => "user",
        SnapshotAuthor::Autosave => "autosave",
        SnapshotAuthor::External => "external",
        SnapshotAuthor::Agent => "agent",
    }
}

/// An unknown name reads as `User`, so a store written by another build
/// still lists, and the worst a name we do not know can do is decline to
/// be coalesced.
fn author_from(name: &str) -> SnapshotAuthor {
    match name {
        "autosave" => SnapshotAuthor::Autosave,
        "external" => SnapshotAuthor::External,
        "agent" => SnapshotAuthor::Agent,
        _ => SnapshotAuthor::User,
    }
}

/// Whether a snapshot updates the newest one rather than following it.
///
/// Only an autosave onto an autosave, and only while the run it would
/// join is younger than [`COALESCE_MS`]. Nothing ever coalesces onto a
/// version somebody asked for: opening a file and saving it by hand are
/// both moments a reader may want back exactly as they were.
fn coalesces(previous: &SnapshotInfo, author: SnapshotAuthor, at_ms: u64) -> bool {
    author == SnapshotAuthor::Autosave
        && previous.author == SnapshotAuthor::Autosave
        && at_ms.saturating_sub(previous.timestamp_ms) < COALESCE_MS
}

/// The document history for one app data directory.
pub struct History {
    db: Connection,
    blobs: PathBuf,
    /// Distinguishes snapshots taken in the same millisecond.
    seq: u64,
}

impl History {
    /// Open, or create, the store under `dir`.
    ///
    /// # Errors
    /// Fails when the directory cannot be created or the index cannot be
    /// opened and brought up to the current schema.
    pub fn open(dir: &Path) -> Result<Self, Error> {
        std::fs::create_dir_all(dir).map_err(|e| failed("create the history directory", &e))?;
        let db = Connection::open(dir.join("history.db"))
            .map_err(|e| failed("open the history index", &e))?;
        // A crash must cost the last snapshot at worst, never the index.
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| failed("set the journal mode", &e))?;
        migrate(&db)?;
        let seq = db
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| failed("count the snapshots", &e))?;
        Ok(Self {
            db,
            blobs: dir.join("blobs"),
            seq: u64::try_from(seq).unwrap_or(0),
        })
    }

    /// Store `content` as a version of `path`.
    ///
    /// Taking the same content twice in a row returns the snapshot that is
    /// already there: opening a file the app just saved should not add a
    /// second row saying nothing changed.
    ///
    /// A run of autosaves updates one row rather than filling the history
    /// with one version per pause in typing; see [`COALESCE_MS`].
    ///
    /// # Errors
    /// Fails when the blob cannot be written or the index cannot be read
    /// or written.
    pub fn snapshot(
        &mut self,
        path: &Path,
        content: &str,
        author: SnapshotAuthor,
    ) -> Result<SnapshotInfo, Error> {
        self.snapshot_at(path, content, author, now_ms())
    }

    /// The clock is an argument so that retention has something to test.
    ///
    /// # Errors
    /// As `snapshot`.
    pub fn snapshot_at(
        &mut self,
        path: &Path,
        content: &str,
        author: SnapshotAuthor,
        at_ms: u64,
    ) -> Result<SnapshotInfo, Error> {
        let key = key_of(path);
        let hash = hash_bytes(content.as_bytes());
        let latest = self.latest(&key)?;
        if let Some(latest) = &latest
            && latest.hash == hash
        {
            return Ok(latest.clone());
        }
        self.write_blob(&hash, content)?;
        // A run of autosaves is one version (see `COALESCE_MS`).
        if let Some(previous) = latest.filter(|previous| coalesces(previous, author, at_ms)) {
            return self.repoint(previous, hash, content.len() as u64);
        }
        self.seq += 1;
        let info = SnapshotInfo {
            id: format!("{at_ms:013}-{:06}", self.seq),
            path: path.to_path_buf(),
            author,
            timestamp_ms: at_ms,
            hash,
            byte_len: content.len() as u64,
        };
        self.db
            .execute(
                "INSERT INTO snapshots (id, path, author, timestamp_ms, hash, byte_len)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    info.id,
                    key,
                    author_name(author),
                    sql(info.timestamp_ms),
                    info.hash,
                    sql(info.byte_len),
                ],
            )
            .map_err(|e| failed("record the snapshot", &e))?;
        Ok(info)
    }

    /// Point a row at new content, leaving its id and its time where they
    /// are: a coalesced run stands for the version the pause before it
    /// left behind, which is the moment a reader would go back to. The
    /// blob it used to point at is left for `collect_blobs`.
    fn repoint(
        &self,
        previous: SnapshotInfo,
        hash: String,
        byte_len: u64,
    ) -> Result<SnapshotInfo, Error> {
        self.db
            .execute(
                "UPDATE snapshots SET hash = ?2, byte_len = ?3 WHERE id = ?1",
                params![previous.id, hash, sql(byte_len)],
            )
            .map_err(|e| failed("update the snapshot", &e))?;
        Ok(SnapshotInfo {
            hash,
            byte_len,
            ..previous
        })
    }

    /// Every snapshot of `path`, newest first.
    ///
    /// # Errors
    /// Fails when the index cannot be read.
    pub fn list(&self, path: &Path) -> Result<Vec<SnapshotInfo>, Error> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, path, author, timestamp_ms, hash, byte_len FROM snapshots
                 WHERE path = ?1 ORDER BY timestamp_ms DESC, id DESC",
            )
            .map_err(|e| failed("prepare the snapshot list", &e))?;
        let rows = statement
            .query_map(params![key_of(path)], row_to_info)
            .map_err(|e| failed("list the snapshots", &e))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| failed("read the snapshot list", &e))
    }

    /// The content of one snapshot.
    ///
    /// # Errors
    /// Fails when the id is unknown or the blob cannot be read.
    pub fn read(&self, id: &str) -> Result<String, Error> {
        let hash: String = self
            .db
            .query_row(
                "SELECT hash FROM snapshots WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| failed("look up the snapshot", &e))?
            .ok_or_else(|| Error::Unavailable {
                what: "the history".to_owned(),
                message: format!("there is no snapshot {id}"),
            })?;
        self.read_blob(&hash)
    }

    /// The newest snapshot of a path, by the key the index stores.
    fn latest(&self, key: &str) -> Result<Option<SnapshotInfo>, Error> {
        self.db
            .query_row(
                "SELECT id, path, author, timestamp_ms, hash, byte_len FROM snapshots
                 WHERE path = ?1 ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
                params![key],
                row_to_info,
            )
            .optional()
            .map_err(|e| failed("read the newest snapshot", &e))
    }

    /// Apply the retention policy and drop the blobs nothing points at.
    ///
    /// Run at startup, where the cost lands on nobody: the reader has not
    /// opened anything yet, and a history that is a month behind is a
    /// history nobody is reading.
    ///
    /// # Errors
    /// Fails when the index cannot be written.
    pub fn sweep(&self) -> Result<usize, Error> {
        self.sweep_at(now_ms())
    }

    /// The clock is an argument so that retention has something to test.
    ///
    /// # Errors
    /// As `sweep`.
    pub fn sweep_at(&self, now: u64) -> Result<usize, Error> {
        let cutoff = now.saturating_sub(KEEP_ALL_DAYS * DAY_MS);
        // Past the cutoff one snapshot a day is kept for each document:
        // the last one of that day, which is the state it was left in.
        let removed = self
            .db
            .execute(
                "DELETE FROM snapshots WHERE timestamp_ms < ?1 AND id NOT IN (
                     SELECT id FROM (
                         SELECT id, ROW_NUMBER() OVER (
                             PARTITION BY path, timestamp_ms / ?2 ORDER BY timestamp_ms DESC, id DESC
                         ) AS rank FROM snapshots WHERE timestamp_ms < ?1
                     ) WHERE rank = 1
                 )",
                params![sql(cutoff), sql(DAY_MS)],
            )
            .map_err(|e| failed("apply the retention policy", &e))?;
        self.collect_blobs()?;
        Ok(removed)
    }

    /// Delete every blob no row points at any more.
    fn collect_blobs(&self) -> Result<(), Error> {
        let mut statement = self
            .db
            .prepare("SELECT 1 FROM snapshots WHERE hash = ?1 LIMIT 1")
            .map_err(|e| failed("prepare the blob check", &e))?;
        let Ok(shards) = std::fs::read_dir(&self.blobs) else {
            return Ok(());
        };
        for shard in shards.flatten() {
            let Ok(files) = std::fs::read_dir(shard.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                let Some(hash) = path.file_stem().and_then(|name| name.to_str()) else {
                    continue;
                };
                let used = statement
                    .exists(params![hash])
                    .map_err(|e| failed("check whether a blob is still used", &e))?;
                if !used {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.blobs.join(&hash[..2]).join(format!("{hash}.zst"))
    }

    fn write_blob(&self, hash: &str, content: &str) -> Result<(), Error> {
        let path = self.blob_path(hash);
        if path.exists() {
            return Ok(());
        }
        let packed = zstd::encode_all(content.as_bytes(), ZSTD_LEVEL)
            .map_err(|e| failed("compress the snapshot", &e))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| failed("create the blob directory", &e))?;
        }
        crate::atomic::replace(&path, &packed, crate::atomic::Create::Private)
            .map_err(|e| failed("write the snapshot", &e))
    }

    fn read_blob(&self, hash: &str) -> Result<String, Error> {
        let packed = std::fs::read(self.blob_path(hash))
            .map_err(|e| failed("read the stored snapshot", &e))?;
        let bytes =
            zstd::decode_all(&packed[..]).map_err(|e| failed("decompress the snapshot", &e))?;
        String::from_utf8(bytes).map_err(|e| failed("decode the snapshot", &e))
    }
}

fn row_to_info(row: &rusqlite::Row<'_>) -> rusqlite::Result<SnapshotInfo> {
    let author: String = row.get(2)?;
    Ok(SnapshotInfo {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        author: author_from(&author),
        timestamp_ms: u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0),
        hash: row.get(4)?,
        byte_len: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(0),
    })
}

/// How a path is keyed in the index. A path that is not UTF-8 is stored
/// as it displays, which is all SQLite can hold; the alternative is bytes
/// nobody can read in a query.
fn key_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn migrate(db: &Connection) -> Result<(), Error> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
        .map_err(|e| failed("create the schema version table", &e))?;
    let current: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .map_err(|e| failed("read the schema version", &e))?;
    let current = usize::try_from(current).unwrap_or(0);
    for (index, statements) in MIGRATIONS.iter().enumerate().skip(current) {
        db.execute_batch(statements)
            .map_err(|e| failed("migrate the history index", &e))?;
        db.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            params![i64::try_from(index + 1).unwrap_or(i64::MAX)],
        )
        .map_err(|e| failed("record the schema version", &e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, History) {
        let dir = tempfile::tempdir().expect("temp dir");
        let history = History::open(dir.path()).expect("open");
        (dir, history)
    }

    fn blob_count(dir: &Path) -> usize {
        let Ok(shards) = std::fs::read_dir(dir.join("blobs")) else {
            return 0;
        };
        shards
            .flatten()
            .filter_map(|shard| std::fs::read_dir(shard.path()).ok())
            .map(|files| files.flatten().count())
            .sum()
    }

    #[test]
    fn a_snapshot_comes_back_as_it_went_in() {
        let (_dir, mut history) = store();
        let content = "# Title\n\nSome text with a 😀 and a ✓.\n";
        let info = history
            .snapshot(Path::new("/notes/a.md"), content, SnapshotAuthor::User)
            .expect("snapshot");
        assert_eq!(info.byte_len, content.len() as u64);
        assert_eq!(history.read(&info.id).expect("read"), content);
    }

    #[test]
    fn the_same_content_twice_is_one_snapshot() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let first = history
            .snapshot(path, "same", SnapshotAuthor::User)
            .expect("first");
        let second = history
            .snapshot(path, "same", SnapshotAuthor::External)
            .expect("second");
        assert_eq!(first.id, second.id);
        assert_eq!(history.list(path).expect("list").len(), 1);
    }

    #[test]
    fn snapshots_are_listed_newest_first_and_per_document() {
        let (_dir, mut history) = store();
        let a = Path::new("/notes/a.md");
        let b = Path::new("/notes/b.md");
        history
            .snapshot_at(a, "one", SnapshotAuthor::User, 1_000)
            .expect("a1");
        history
            .snapshot_at(b, "other", SnapshotAuthor::User, 1_500)
            .expect("b1");
        history
            .snapshot_at(a, "two", SnapshotAuthor::External, 2_000)
            .expect("a2");
        let listed = history.list(a).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].timestamp_ms, 2_000);
        assert_eq!(listed[0].author, SnapshotAuthor::External);
        assert_eq!(listed[1].timestamp_ms, 1_000);
        assert_eq!(history.read(&listed[1].id).expect("read"), "one");
    }

    #[test]
    fn identical_content_is_stored_once() {
        let (dir, mut history) = store();
        history
            .snapshot(Path::new("/notes/a.md"), "shared", SnapshotAuthor::User)
            .expect("a");
        history
            .snapshot(Path::new("/notes/b.md"), "shared", SnapshotAuthor::User)
            .expect("b");
        assert_eq!(blob_count(dir.path()), 1);
    }

    #[test]
    fn a_run_of_autosaves_is_one_version() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let opened = history
            .snapshot_at(path, "# Brief\n", SnapshotAuthor::User, 0)
            .expect("open");
        // Ten minutes of typing, saved every pause.
        for minute in 0..10u64 {
            history
                .snapshot_at(
                    path,
                    &format!("# Brief\n\nparagraph {minute}\n"),
                    SnapshotAuthor::Autosave,
                    minute * 60_000,
                )
                .expect("autosave");
        }
        let listed = history.list(path).expect("list");
        // The file as it was opened, and one version per two minutes of
        // typing, rather than one per pause.
        assert_eq!(listed.len(), 6, "{listed:#?}");
        assert_eq!(listed.last().map(|first| first.id.clone()), Some(opened.id));
        assert!(
            listed[..5]
                .iter()
                .all(|info| info.author == SnapshotAuthor::Autosave)
        );
    }

    #[test]
    fn a_coalesced_version_holds_the_newest_content_at_the_time_it_started() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let first = history
            .snapshot_at(path, "one", SnapshotAuthor::Autosave, 60_000)
            .expect("first");
        let second = history
            .snapshot_at(path, "two", SnapshotAuthor::Autosave, 90_000)
            .expect("second");
        assert_eq!(first.id, second.id);
        assert_eq!(second.timestamp_ms, 60_000);
        assert_eq!(history.read(&second.id).expect("read"), "two");
        assert_eq!(second.byte_len, 3);
    }

    #[test]
    fn autosave_never_coalesces_onto_a_version_somebody_asked_for() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let saved = history
            .snapshot_at(path, "by hand", SnapshotAuthor::User, 1_000)
            .expect("save");
        history
            .snapshot_at(path, "and then some", SnapshotAuthor::Autosave, 2_000)
            .expect("autosave");
        assert_eq!(history.list(path).expect("list").len(), 2);
        assert_eq!(history.read(&saved.id).expect("read"), "by hand");
    }

    #[test]
    fn a_save_by_hand_during_a_run_of_autosaves_is_its_own_version() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        history
            .snapshot_at(path, "one", SnapshotAuthor::Autosave, 1_000)
            .expect("autosave");
        history
            .snapshot_at(path, "two", SnapshotAuthor::User, 2_000)
            .expect("by hand");
        history
            .snapshot_at(path, "three", SnapshotAuthor::Autosave, 3_000)
            .expect("autosave again");
        let listed = history.list(path).expect("list");
        assert_eq!(
            listed.iter().map(|info| info.author).collect::<Vec<_>>(),
            vec![
                SnapshotAuthor::Autosave,
                SnapshotAuthor::User,
                SnapshotAuthor::Autosave
            ]
        );
    }

    #[test]
    fn the_blob_a_coalesced_version_left_behind_is_collected() {
        let (dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        history
            .snapshot_at(path, "one", SnapshotAuthor::Autosave, 1_000)
            .expect("first");
        history
            .snapshot_at(path, "two", SnapshotAuthor::Autosave, 2_000)
            .expect("second");
        assert_eq!(blob_count(dir.path()), 2);
        history.sweep_at(3_000).expect("sweep");
        assert_eq!(blob_count(dir.path()), 1);
    }

    #[test]
    fn an_unknown_id_says_so() {
        let (_dir, history) = store();
        let error = history.read("nothing").expect_err("no such snapshot");
        assert!(matches!(error, Error::Unavailable { .. }), "{error:?}");
    }

    #[test]
    fn the_index_opens_again_without_migrating_twice() {
        let dir = tempfile::tempdir().expect("temp dir");
        {
            let mut history = History::open(dir.path()).expect("first open");
            history
                .snapshot(Path::new("/notes/a.md"), "kept", SnapshotAuthor::User)
                .expect("snapshot");
        }
        let history = History::open(dir.path()).expect("second open");
        let versions: i64 = history
            .db
            .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
            .expect("count");
        assert_eq!(versions, i64::try_from(MIGRATIONS.len()).expect("fits"));
        assert_eq!(
            history.list(Path::new("/notes/a.md")).expect("list").len(),
            1
        );
    }

    #[test]
    fn a_second_id_in_the_same_millisecond_is_still_its_own() {
        let (_dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let first = history
            .snapshot_at(path, "one", SnapshotAuthor::User, 5)
            .expect("one");
        let second = history
            .snapshot_at(path, "two", SnapshotAuthor::User, 5)
            .expect("two");
        assert_ne!(first.id, second.id);
        assert_eq!(history.read(&first.id).expect("read"), "one");
        assert_eq!(history.read(&second.id).expect("read"), "two");
    }

    #[test]
    fn retention_keeps_the_last_of_each_old_day_and_all_of_the_recent_ones() {
        let (dir, mut history) = store();
        let path = Path::new("/notes/a.md");
        let now = 400 * DAY_MS;
        // Three snapshots on one day, two months back.
        for hour in 0..3u64 {
            history
                .snapshot_at(
                    path,
                    &format!("old {hour}"),
                    SnapshotAuthor::User,
                    340 * DAY_MS + hour * 60 * 60 * 1000,
                )
                .expect("old");
        }
        // One on the next day, still outside the window.
        history
            .snapshot_at(path, "next day", SnapshotAuthor::User, 341 * DAY_MS)
            .expect("next day");
        // Two from this week.
        history
            .snapshot_at(path, "recent one", SnapshotAuthor::User, 398 * DAY_MS)
            .expect("recent one");
        history
            .snapshot_at(path, "recent two", SnapshotAuthor::User, 399 * DAY_MS)
            .expect("recent two");
        assert_eq!(history.list(path).expect("list").len(), 6);

        let removed = history.sweep_at(now).expect("sweep");
        assert_eq!(removed, 2);
        let kept: Vec<String> = history
            .list(path)
            .expect("list")
            .iter()
            .map(|info| history.read(&info.id).expect("read"))
            .collect();
        assert_eq!(kept, ["recent two", "recent one", "next day", "old 2"]);
        assert_eq!(blob_count(dir.path()), 4, "the dropped blobs are gone too");
    }

    #[test]
    fn a_blob_two_snapshots_share_survives_one_of_them_being_swept() {
        let (dir, mut history) = store();
        let old = Path::new("/notes/old.md");
        let kept = Path::new("/notes/kept.md");
        history
            .snapshot_at(old, "shared", SnapshotAuthor::User, 100 * DAY_MS)
            .expect("old");
        history
            .snapshot_at(old, "later", SnapshotAuthor::User, 100 * DAY_MS + 1000)
            .expect("old later");
        history
            .snapshot_at(kept, "shared", SnapshotAuthor::User, 399 * DAY_MS)
            .expect("kept");
        history.sweep_at(400 * DAY_MS).expect("sweep");
        assert_eq!(blob_count(dir.path()), 2);
        let still = history.list(kept).expect("list");
        assert_eq!(history.read(&still[0].id).expect("read"), "shared");
    }
}
