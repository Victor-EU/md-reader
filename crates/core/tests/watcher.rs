//! The watcher against a real filesystem (plan WP 1.7).
//!
//! Each scenario writes the way some real tool writes: truncate in place,
//! rename over the target, delete, rename away. Most of them write from
//! this process, which the watcher cannot tell from any other: it
//! recognizes our own saves by the hash of the bytes, never by who wrote
//! them. One test shells out anyway, so that the claim is checked and not
//! only reasoned about.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::Duration;

use mdreader_core::{WatchEvent, Watcher, apply, read_document, save_document};

/// Generous: the debounce is 100 ms and a loaded machine can take a while
/// to deliver a filesystem event.
const WAIT: Duration = Duration::from_secs(10);
/// Long enough that an event which was going to arrive has arrived.
const QUIET: Duration = Duration::from_millis(1500);

struct Fixture {
    dir: tempfile::TempDir,
    watcher: Watcher,
    events: Receiver<WatchEvent>,
}

impl Fixture {
    fn new(content: &str) -> (Self, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("notes.md");
        std::fs::write(&file, content).expect("seed the file");
        let (sender, events) = channel();
        let mut watcher = Watcher::new(move |event| {
            let _ = sender.send(event);
        })
        .expect("start the watcher");
        watcher.watch(&file).expect("watch the file");
        (
            Self {
                dir,
                watcher,
                events,
            },
            file,
        )
    }

    fn next(&self) -> WatchEvent {
        self.events.recv_timeout(WAIT).expect("an event")
    }

    fn changed(&self) -> mdreader_core::ExternalChange {
        match self.next() {
            WatchEvent::Changed(change) => change,
            other => panic!("expected a change, got {other:?}"),
        }
    }

    fn quiet(&self) {
        match self.events.recv_timeout(QUIET) {
            Err(RecvTimeoutError::Timeout) => {}
            other => panic!("expected nothing to be reported, got {other:?}"),
        }
    }
}

/// Write by truncating the file and writing over it, which is what a
/// script that opens a file for writing does.
#[test]
fn a_write_in_place_arrives_as_edits() {
    let before = "# Title\n\nOne paragraph.\n";
    let after = "# Title\n\nOne better paragraph.\n";
    let (fixture, file) = Fixture::new(before);
    std::fs::write(&file, after).expect("write");
    let change = fixture.changed();
    assert_eq!(change.path, file);
    assert_eq!(change.content, after);
    assert_eq!(apply(before, &change.changes), after);
    assert_eq!(change.changes.len(), 1, "one paragraph, one edit");
    drop(fixture.dir);
}

/// Write by rename, which is what most editors and every atomic writer
/// does, and the reason the watch is on the folder.
#[test]
fn a_write_by_rename_arrives_as_edits() {
    let before = "alpha\nbeta\n";
    let after = "alpha\ngamma\n";
    let (fixture, file) = Fixture::new(before);
    let temporary = fixture.dir.path().join("notes.md.tmp");
    std::fs::write(&temporary, after).expect("write the temporary file");
    std::fs::rename(&temporary, &file).expect("rename into place");
    let change = fixture.changed();
    assert_eq!(change.content, after);
    assert_eq!(apply(before, &change.changes), after);
}

/// A tool that writes in several steps is one change, not four.
#[test]
fn a_burst_of_writes_is_one_change() {
    let (fixture, file) = Fixture::new("one\n");
    for step in ["two\n", "three\n", "four\n"] {
        std::fs::write(&file, step).expect("write");
    }
    let change = fixture.changed();
    assert_eq!(change.content, "four\n");
    fixture.quiet();
}

/// A write that puts back what was already there is not a change.
#[test]
fn writing_the_same_bytes_is_not_a_change() {
    let (fixture, file) = Fixture::new("unchanged\n");
    std::fs::write(&file, "unchanged\n").expect("write");
    fixture.quiet();
}

/// The file is deleted under an open tab. The buffer is the frontend's
/// to keep; all the watcher owes is the news, once, and then the news
/// when it comes back.
#[test]
fn a_deleted_file_is_reported_once_and_watched_for_its_return() {
    let (fixture, file) = Fixture::new("here\n");
    std::fs::remove_file(&file).expect("delete");
    assert_eq!(fixture.next(), WatchEvent::Removed { path: file.clone() });
    fixture.quiet();
    std::fs::write(&file, "back\n").expect("recreate");
    assert_eq!(fixture.changed().content, "back\n");
}

/// Renamed away: the document did not change, its name did.
#[test]
fn a_rename_away_moves_the_document() {
    let (fixture, file) = Fixture::new("moving\n");
    let target = fixture.dir.path().join("renamed.md");
    std::fs::rename(&file, &target).expect("rename away");
    match fixture.next() {
        WatchEvent::Renamed { from, to } => {
            assert_eq!(from, file);
            assert_eq!(to.file_name(), target.file_name());
        }
        other => panic!("expected a rename, got {other:?}"),
    }
}

/// The document did not stop being open because its name changed, so the
/// next write to it under the new name is still reported.
#[test]
fn a_renamed_file_is_still_watched_under_its_new_name() {
    let (fixture, file) = Fixture::new("moving\n");
    let target = fixture.dir.path().join("renamed.md");
    std::fs::rename(&file, &target).expect("rename away");
    match fixture.next() {
        WatchEvent::Renamed { .. } => {}
        other => panic!("expected a rename, got {other:?}"),
    }
    std::fs::write(&target, "moved and changed\n").expect("write");
    let change = fixture.changed();
    assert_eq!(change.content, "moved and changed\n");
    assert_eq!(apply("moving\n", &change.changes), change.content);
}

/// Our own save comes back through the same folder watch, and is dropped
/// because the bytes on disk are the bytes we just wrote.
#[test]
fn our_own_save_is_not_reported_back_to_us() {
    let (mut fixture, file) = Fixture::new("first\n");
    let format = read_document(&file).expect("read").meta.format;
    let saved = save_document(&file, "second\n", None, &format).expect("save");
    fixture
        .watcher
        .note_write(&file, &saved.hash)
        .expect("note the write");
    fixture.quiet();
    // And the next write by somebody else still gets through, measured
    // from what we saved rather than from what was there before.
    std::fs::write(&file, "third\n").expect("write");
    let change = fixture.changed();
    assert_eq!(apply("second\n", &change.changes), "third\n");
}

/// After unwatching, nothing about that file is reported.
#[test]
fn an_unwatched_file_is_left_alone() {
    let (mut fixture, file) = Fixture::new("watched\n");
    fixture.watcher.unwatch(&file).expect("unwatch");
    std::fs::write(&file, "changed\n").expect("write");
    fixture.quiet();
}

/// The same thing, written by a process that has never heard of us.
///
/// The watcher cannot see the difference, which is the point: nothing in
/// it depends on the write coming from inside this program. Unix only,
/// because the shell it uses is.
#[cfg(unix)]
#[test]
fn a_write_from_another_process_arrives() {
    let (fixture, file) = Fixture::new("mine\n");
    run(
        &["sh", "-c"],
        &format!("printf 'theirs\\n' > {}", quoted(&file)),
    );
    let change = fixture.changed();
    assert_eq!(change.content, "theirs\n");
    assert_eq!(apply("mine\n", &change.changes), "theirs\n");
}

/// And renamed away by one, which is how `mv` moves a file out of a
/// folder somebody is reading.
#[cfg(unix)]
#[test]
fn a_rename_from_another_process_arrives() {
    let (fixture, file) = Fixture::new("mine\n");
    let target = fixture.dir.path().join("gone.md");
    run(
        &["sh", "-c"],
        &format!("mv {} {}", quoted(&file), quoted(&target)),
    );
    match fixture.next() {
        WatchEvent::Renamed { from, .. } => assert_eq!(from, file),
        // A move the platform reports only as a disappearance is still
        // the right answer for the tab: the file is not there any more.
        WatchEvent::Removed { path } => assert_eq!(path, file),
        other @ WatchEvent::Changed(_) => panic!("expected the file to move, got {other:?}"),
    }
}

#[cfg(unix)]
fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg(unix)]
fn run(program: &[&str], script: &str) {
    let status = std::process::Command::new(program[0])
        .args(&program[1..])
        .arg(script)
        .status()
        .expect("run the command");
    assert!(status.success(), "{script} failed");
}
