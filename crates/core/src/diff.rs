//! Line diffs and the three-way merge (design 7.2, plan WP 1.7).
//!
//! Every offset here counts UTF-16 code units, because the other end of
//! every result is a `CodeMirror` document and its positions are
//! JavaScript string indices.
//!
//! Diffs are line based. A line is the unit the diff3 algorithm reasons
//! about and the unit the gutter draws, and `similar` gives us the line
//! alignment. Inside one replaced hunk the ends both sides agree on are
//! trimmed to characters, so changing one word moves one word: a cursor
//! elsewhere on that line keeps its place.

use std::collections::HashMap;
use std::hash::Hash;
use std::ops::Range;

use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::types::{Conflict, MergeResult, PositionEdit};

/// How far apart two sides may be before the line diff is not worth its
/// time. Myers costs O((n+m)·d), so a full rewrite of a large file would
/// run for minutes to report what one hunk already says: all of it
/// changed. Past this the differing middle becomes a single hunk.
const MAX_DISTANCE: usize = 5_000;

/// A text as lines, with the offsets needed to talk about ranges of them.
struct Lines<'a> {
    text: &'a str,
    /// Each line, keeping its terminator, so a range of them concatenates
    /// back into the source exactly.
    slices: Vec<&'a str>,
    /// Byte offset of every line start, plus the length of the text.
    bytes: Vec<usize>,
    /// UTF-16 offset of every line start, plus the length of the text.
    units: Vec<u32>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let mut slices = Vec::new();
        let mut bytes = Vec::new();
        let mut units = Vec::new();
        let mut start = 0;
        let mut at: u32 = 0;
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                let line = &text[start..=i];
                bytes.push(start);
                units.push(at);
                at = at.saturating_add(utf16_len(line));
                slices.push(line);
                start = i + 1;
            }
        }
        if start < text.len() {
            let line = &text[start..];
            bytes.push(start);
            units.push(at);
            at = at.saturating_add(utf16_len(line));
            slices.push(line);
        }
        bytes.push(text.len());
        units.push(at);
        Self {
            text,
            slices,
            bytes,
            units,
        }
    }

    /// The source behind a range of lines.
    fn slice(&self, lines: &Range<usize>) -> &'a str {
        &self.text[self.bytes[lines.start]..self.bytes[lines.end]]
    }

    /// Where a line starts, in UTF-16 units.
    fn at(&self, line: usize) -> u32 {
        self.units[line]
    }
}

fn utf16_len(text: &str) -> u32 {
    u32::try_from(text.encode_utf16().count()).unwrap_or(u32::MAX)
}

/// A lower bound on the number of elements that must be inserted or
/// deleted: every one a side holds more copies of than the other is one
/// of them. O(n+m), which is what decides whether Myers can be afforded.
/// Shared with the block alignment, which asks the same question of
/// blocks that this asks of lines.
pub(crate) fn distance_floor<T: Eq + Hash>(old: &[T], new: &[T]) -> usize {
    let mut counts: HashMap<&T, i32> = HashMap::with_capacity(old.len() + new.len());
    for line in old {
        *counts.entry(line).or_default() += 1;
    }
    for line in new {
        *counts.entry(line).or_default() -= 1;
    }
    counts
        .values()
        .map(|n| usize::try_from(n.unsigned_abs()).unwrap_or(usize::MAX))
        .sum()
}

/// Where two texts differ, as ranges of lines on each side.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Change {
    old: Range<usize>,
    new: Range<usize>,
}

/// The line alignment of two texts, as the ranges that are not equal.
///
/// Lines shared at both ends are trimmed before the diff, which is the
/// difference between an edit costing what the edit is worth and costing
/// what the document is worth.
fn align(old: &[&str], new: &[&str]) -> Vec<Change> {
    let head = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let tail = old[head..]
        .iter()
        .rev()
        .zip(new[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_mid = &old[head..old.len() - tail];
    let new_mid = &new[head..new.len() - tail];
    if old_mid.is_empty() && new_mid.is_empty() {
        return Vec::new();
    }
    let ops = if distance_floor(old_mid, new_mid) > MAX_DISTANCE {
        vec![DiffOp::Replace {
            old_index: 0,
            old_len: old_mid.len(),
            new_index: 0,
            new_len: new_mid.len(),
        }]
    } else {
        capture_diff_slices(Algorithm::Myers, old_mid, new_mid)
    };
    let mut out = Vec::new();
    let mut at_old = head;
    let mut at_new = head;
    for op in &ops {
        let (old_len, new_len) = lengths(op);
        if !matches!(op, DiffOp::Equal { .. }) {
            out.push(Change {
                old: at_old..at_old + old_len,
                new: at_new..at_new + new_len,
            });
        }
        at_old += old_len;
        at_new += new_len;
    }
    out
}

/// How many lines an op covers on each side.
///
/// `similar` fills in only one of the two indices on `Insert` and
/// `Delete` — the other says where the change landed on the side it did
/// not touch, and is not a position in the alignment. Walking the ops
/// with our own cursors reads only what each op actually states.
fn lengths(op: &DiffOp) -> (usize, usize) {
    match *op {
        DiffOp::Equal { len, .. } => (len, len),
        DiffOp::Delete { old_len, .. } => (old_len, 0),
        DiffOp::Insert { new_len, .. } => (0, new_len),
        DiffOp::Replace {
            old_len, new_len, ..
        } => (old_len, new_len),
    }
}

/// The bytes of the prefix and the suffix that `a` and `b` share, on
/// character boundaries and never overlapping in the middle.
fn common_ends(a: &str, b: &str) -> (usize, usize) {
    let head = a
        .char_indices()
        .zip(b.char_indices())
        .take_while(|((_, x), (_, y))| x == y)
        .map(|((i, x), _)| i + x.len_utf8())
        .last()
        .unwrap_or(0);
    let mut tail = 0;
    for (x, y) in a[head..].chars().rev().zip(b[head..].chars().rev()) {
        if x != y {
            break;
        }
        tail += x.len_utf8();
    }
    (head, tail)
}

/// One replacement of `old` by `new`, with the parts both already agree
/// on trimmed off the ends. `from` and `to` are where `old` sits.
fn edit(from: u32, to: u32, old: &str, new: &str) -> PositionEdit {
    let (head, tail) = common_ends(old, new);
    PositionEdit {
        from: from + utf16_len(&old[..head]),
        to: to - utf16_len(&old[old.len() - tail..]),
        insert: new[head..new.len() - tail].to_owned(),
    }
}

/// The edits that turn `old` into `new`, in UTF-16 offsets into `old`.
///
/// This is what the watcher sends for a write that arrived while the
/// buffer was clean: the frontend applies them as one transaction, so the
/// cursor, the scroll position, the folds, and the undo history all map
/// through instead of being reset by a reload.
#[must_use]
pub fn edits(old: &str, new: &str) -> Vec<PositionEdit> {
    let old_lines = Lines::new(old);
    let new_lines = Lines::new(new);
    align(&old_lines.slices, &new_lines.slices)
        .iter()
        .map(|change| {
            edit(
                old_lines.at(change.old.start),
                old_lines.at(change.old.end),
                old_lines.slice(&change.old),
                new_lines.slice(&change.new),
            )
        })
        .collect()
}

/// The base ranges the merge reasons about: each side's change regions,
/// with everything that overlaps or touches joined into one.
///
/// Touching counts. Two changes with no untouched line between them
/// cannot be interleaved without inventing an order for them, which is
/// why the diff3 algorithm calls adjacent edits a conflict.
fn hunks(ours: &[Change], theirs: &[Change]) -> Vec<Range<usize>> {
    let mut all: Vec<Range<usize>> = ours
        .iter()
        .chain(theirs)
        .map(|change| change.old.clone())
        .collect();
    all.sort_by_key(|range| (range.start, range.end));
    let mut out: Vec<Range<usize>> = Vec::new();
    for range in all {
        match out.last_mut() {
            Some(last) if range.start <= last.end => last.end = last.end.max(range.end),
            _ => out.push(range),
        }
    }
    out
}

/// One side's regions, walked in step with the hunks.
///
/// Between two change regions the side's lines run parallel to the base's,
/// so the offset between them is all it takes to place a hunk. Hunks
/// arrive in order and every region belongs to one, so this is one pass.
struct Side {
    changes: Vec<Change>,
    next: usize,
    delta: isize,
}

impl Side {
    fn new(changes: Vec<Change>) -> Self {
        Self {
            changes,
            next: 0,
            delta: 0,
        }
    }

    /// This side's lines for a hunk covering `base`.
    fn range(&mut self, base: &Range<usize>) -> Range<usize> {
        let start = base.start.saturating_add_signed(self.delta);
        // A change starting where the hunk ends touches it, so the hunk
        // has already swallowed it; taking it here is also how a hunk
        // that is one insertion, and so has an empty base range, finds
        // the change it is made of.
        while self
            .changes
            .get(self.next)
            .is_some_and(|change| change.old.start <= base.end)
        {
            let change = &self.changes[self.next];
            self.delta += isize::try_from(change.new.len()).unwrap_or(0)
                - isize::try_from(change.old.len()).unwrap_or(0);
            self.next += 1;
        }
        start..base.end.saturating_add_signed(self.delta)
    }
}

/// Three-way merge: what `theirs` changed about `base`, brought into
/// `ours` (design 7.2).
///
/// The result is in offsets into `ours`: `changes` are the hunks only
/// `theirs` touched, ready to apply as one transaction, and `conflicts`
/// are the hunks both sides touched differently. The two never overlap,
/// so a conflict's range maps through the applied changes.
///
/// Phase 1 applies the changes and sets the conflicts aside with a
/// snapshot; the widget that offers both versions is WP 2.1.
#[must_use]
pub fn merge3(base: &str, ours: &str, theirs: &str) -> MergeResult {
    let base_lines = Lines::new(base);
    let our_lines = Lines::new(ours);
    let their_lines = Lines::new(theirs);
    let mut our_side = Side::new(align(&base_lines.slices, &our_lines.slices));
    let mut their_side = Side::new(align(&base_lines.slices, &their_lines.slices));
    let mut changes = Vec::new();
    let mut conflicts = Vec::new();
    for hunk in hunks(&our_side.changes, &their_side.changes) {
        let ours_at = our_side.range(&hunk);
        let theirs_at = their_side.range(&hunk);
        let was = base_lines.slice(&hunk);
        let mine = our_lines.slice(&ours_at);
        let yours = their_lines.slice(&theirs_at);
        // Nothing to bring over when they left it alone, and nothing to
        // decide when both of us made the same change.
        if yours == was || mine == yours {
            continue;
        }
        if mine == was {
            changes.push(edit(
                our_lines.at(ours_at.start),
                our_lines.at(ours_at.end),
                mine,
                yours,
            ));
        } else {
            conflicts.push(Conflict {
                from: our_lines.at(ours_at.start),
                to: our_lines.at(ours_at.end),
                ours: mine.to_owned(),
                theirs: yours.to_owned(),
            });
        }
    }
    MergeResult { changes, conflicts }
}

/// Apply position edits to a text, the way the frontend's transaction
/// does. The edits must be sorted and must not overlap, which is what
/// `edits` and `merge3` return; this is the executable statement of what
/// they mean.
#[must_use]
pub fn apply(text: &str, edits: &[PositionEdit]) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut at = 0usize;
    for edit in edits {
        let from = (edit.from as usize).clamp(at, units.len());
        let to = (edit.to as usize).clamp(from, units.len());
        out.extend_from_slice(&units[at..from]);
        out.extend(edit.insert.encode_utf16());
        at = to;
    }
    out.extend_from_slice(&units[at..]);
    String::from_utf16_lossy(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The buffer is always LF by the time it reaches here (design 6.3),
    /// but disk content is not, so both forms are exercised.
    fn crlf(text: &str) -> String {
        text.replace('\n', "\r\n")
    }

    #[test]
    fn no_change_is_no_edits() {
        assert!(edits("one\ntwo\n", "one\ntwo\n").is_empty());
        assert!(edits("", "").is_empty());
    }

    #[test]
    fn one_word_moves_one_word() {
        let old = "The quick brown fox\njumps over it\n";
        let new = "The quick red fox\njumps over it\n";
        assert_eq!(
            edits(old, new),
            vec![PositionEdit {
                from: 10,
                to: 15,
                insert: "red".to_owned(),
            }]
        );
        assert_eq!(apply(old, &edits(old, new)), new);
    }

    #[test]
    fn an_inserted_line_is_an_insertion() {
        let old = "one\ntwo\n";
        let new = "one\nmiddle\ntwo\n";
        assert_eq!(
            edits(old, new),
            vec![PositionEdit {
                from: 4,
                to: 4,
                insert: "middle\n".to_owned(),
            }]
        );
    }

    #[test]
    fn a_deleted_line_is_a_deletion() {
        let old = "one\ntwo\nthree\n";
        let new = "one\nthree\n";
        assert_eq!(
            edits(old, new),
            vec![PositionEdit {
                from: 4,
                to: 8,
                insert: String::new(),
            }]
        );
    }

    #[test]
    fn offsets_count_utf16_units() {
        // The emoji is one character and two UTF-16 units, which is what
        // the offsets on the other side of the IPC are counted in.
        let old = "a 😀 b\nsecond\n";
        let new = "a 😀 c\nsecond\n";
        let edit = &edits(old, new)[0];
        assert_eq!((edit.from, edit.to, edit.insert.as_str()), (5, 6, "c"));
        assert_eq!(apply(old, &edits(old, new)), new);
    }

    #[test]
    fn crlf_lines_diff_the_same_way() {
        let old = crlf("one\ntwo\nthree\n");
        let new = crlf("one\ntwo\nfour\n");
        let edit = &edits(&old, &new)[0];
        assert_eq!(edit.insert, "four");
        assert_eq!(apply(&old, &edits(&old, &new)), new);
    }

    #[test]
    fn a_full_rewrite_of_a_long_file_stays_one_hunk() {
        let lines = |word: &str| {
            (0..MAX_DISTANCE + 100).fold(String::new(), |mut text, i| {
                use std::fmt::Write;
                let _ = writeln!(text, "{word} line {i}");
                text
            })
        };
        let old = lines("old");
        let new = lines("new");
        let result = edits(&old, &new);
        assert_eq!(result.len(), 1);
        assert_eq!(apply(&old, &result), new);
    }

    /// The trap in `similar`'s op list, pinned so an upgrade that changes
    /// it is caught here rather than in a merge. On this input the ops
    /// arrive as delete, equal, insert, and the two indices nothing sets
    /// — the insert's `old_index` and the delete's `new_index` — hold
    /// values that are not positions in the alignment. Reading them as
    /// positions puts an insertion inside a deletion.
    #[test]
    fn line_positions_come_from_walking_the_ops() {
        let old = "b\na\n\n";
        let new = "\n\n\n\na\n";
        let raw = capture_diff_slices(
            Algorithm::Myers,
            &Lines::new(old).slices,
            &Lines::new(new).slices,
        );
        assert!(
            raw.iter().any(|op| matches!(
                op,
                DiffOp::Insert { old_index, .. } if *old_index == 1
            )),
            "expected the unset index similar is known to leave: {raw:?}"
        );
        assert_eq!(apply(old, &edits(old, new)), new);
    }

    /// The merge cases table from design section 10. `merged` is what the
    /// buffer holds when the write lands: the hunks only they touched,
    /// applied, with our version kept everywhere both sides wrote.
    /// `taken` is what it holds when the reader has answered every one
    /// of those with "take theirs" (plan WP 2.1). The two are the same
    /// row where there was nothing to answer.
    struct Case {
        name: &'static str,
        base: &'static str,
        ours: &'static str,
        theirs: &'static str,
        merged: &'static str,
        conflicts: usize,
        taken: &'static str,
    }

    /// Their side of everything: the hunks they alone changed, and the
    /// hunks both of us did, each as the edit the widget's second button
    /// makes. Sorted and non-overlapping, which is what `apply` wants and
    /// what `changes_and_conflicts_never_overlap` proves they are.
    fn take_everything(result: &MergeResult) -> Vec<PositionEdit> {
        let mut edits = result.changes.clone();
        edits.extend(result.conflicts.iter().map(|hunk| PositionEdit {
            from: hunk.from,
            to: hunk.to,
            insert: hunk.theirs.clone(),
        }));
        edits.sort_by_key(|edit| edit.from);
        edits
    }

    const CASES: &[Case] = &[
        Case {
            name: "only they changed anything",
            base: "one\ntwo\nthree\n",
            ours: "one\ntwo\nthree\n",
            theirs: "one\nTWO\nthree\n",
            merged: "one\nTWO\nthree\n",
            conflicts: 0,
            taken: "one\nTWO\nthree\n",
        },
        Case {
            name: "only we changed anything",
            base: "one\ntwo\nthree\n",
            ours: "one\nTWO\nthree\n",
            theirs: "one\ntwo\nthree\n",
            merged: "one\nTWO\nthree\n",
            conflicts: 0,
            taken: "one\nTWO\nthree\n",
        },
        Case {
            // S4: the agent rewrites sections 1 and 5 while the unsaved
            // edit sits in section 3.
            name: "different sections",
            base: "a\nb\nc\nd\ne\n",
            ours: "a\nb\nCCC\nd\ne\n",
            theirs: "AAA\nb\nc\nd\nEEE\n",
            merged: "AAA\nb\nCCC\nd\nEEE\n",
            conflicts: 0,
            taken: "AAA\nb\nCCC\nd\nEEE\n",
        },
        Case {
            name: "the same change on both sides",
            base: "a\nb\nc\n",
            ours: "a\nBBB\nc\n",
            theirs: "a\nBBB\nc\n",
            merged: "a\nBBB\nc\n",
            conflicts: 0,
            taken: "a\nBBB\nc\n",
        },
        Case {
            name: "insertions in different places",
            base: "a\nb\nc\nd\n",
            ours: "a\nb\nc\nnew from us\nd\n",
            theirs: "a\nnew from them\nb\nc\nd\n",
            merged: "a\nnew from them\nb\nc\nnew from us\nd\n",
            conflicts: 0,
            taken: "a\nnew from them\nb\nc\nnew from us\nd\n",
        },
        Case {
            name: "whitespace only, elsewhere",
            base: "a\nb\n\nc\nd\n",
            ours: "a\nb\n\nc\nDDD\n",
            theirs: "a\n\nb\n\nc\nd\n",
            merged: "a\n\nb\n\nc\nDDD\n",
            conflicts: 0,
            taken: "a\n\nb\n\nc\nDDD\n",
        },
        Case {
            name: "both delete the same lines",
            base: "a\nb\nc\nd\n",
            ours: "a\nd\n",
            theirs: "a\nd\n",
            merged: "a\nd\n",
            conflicts: 0,
            taken: "a\nd\n",
        },
        Case {
            // No untouched line between the two edits, so there is no
            // order to put them in. Classic diff3 calls this a conflict.
            name: "adjacent edits",
            base: "a\nb\nc\nd\n",
            ours: "a\nBBB\nc\nd\n",
            theirs: "a\nb\nCCC\nd\n",
            merged: "a\nBBB\nc\nd\n",
            conflicts: 1,
            taken: "a\nb\nCCC\nd\n",
        },
        Case {
            // Adjacency again: with nothing between the inserted line and
            // the changed one, there is no order to put them in.
            name: "a line inserted right before the line we changed",
            base: "a\nb\nc\n",
            ours: "a\nb\nCCC\n",
            theirs: "a\nb\nnew\nc\n",
            merged: "a\nb\nCCC\n",
            conflicts: 1,
            taken: "a\nb\nnew\nc\n",
        },
        Case {
            name: "the same line, changed differently",
            base: "a\nb\nc\n",
            ours: "a\nours\nc\n",
            theirs: "a\ntheirs\nc\n",
            merged: "a\nours\nc\n",
            conflicts: 1,
            taken: "a\ntheirs\nc\n",
        },
        Case {
            name: "whitespace only, on the line we are editing",
            base: "a\nb\nc\n",
            ours: "a\nb edited\nc\n",
            theirs: "a\nb \nc\n",
            merged: "a\nb edited\nc\n",
            conflicts: 1,
            taken: "a\nb \nc\n",
        },
        Case {
            name: "they deleted the region we are editing",
            base: "a\nb\nc\nd\n",
            ours: "a\nb\nC edited\nd\n",
            theirs: "a\nd\n",
            merged: "a\nb\nC edited\nd\n",
            conflicts: 1,
            taken: "a\nd\n",
        },
        Case {
            name: "a full rewrite",
            base: "a\nb\nc\n",
            ours: "a\nb edited\nc\n",
            theirs: "completely\ndifferent\ntext\n",
            merged: "a\nb edited\nc\n",
            conflicts: 1,
            taken: "completely\ndifferent\ntext\n",
        },
        Case {
            name: "both appended at the end",
            base: "a\nb\n",
            ours: "a\nb\nours\n",
            theirs: "a\nb\ntheirs\n",
            merged: "a\nb\nours\n",
            conflicts: 1,
            taken: "a\nb\ntheirs\n",
        },
        Case {
            name: "one conflict does not hold up the rest",
            base: "a\nb\nc\nd\ne\nf\ng\n",
            ours: "a\nb\nc\nOURS\ne\nf\ng\n",
            theirs: "AAA\nb\nc\nTHEIRS\ne\nf\nGGG\n",
            merged: "AAA\nb\nc\nOURS\ne\nf\nGGG\n",
            conflicts: 1,
            taken: "AAA\nb\nc\nTHEIRS\ne\nf\nGGG\n",
        },
        Case {
            // Our other change was never part of the argument, and
            // settling the argument their way leaves it where it is.
            name: "a conflict beside a change of our own",
            base: "a\nb\nc\nd\ne\n",
            ours: "a\nOURS\nc\nMINE\ne\n",
            theirs: "a\nTHEIRS\nc\nd\ne\n",
            merged: "a\nOURS\nc\nMINE\ne\n",
            conflicts: 1,
            taken: "a\nTHEIRS\nc\nMINE\ne\n",
        },
    ];

    #[test]
    fn merge_cases() {
        for case in CASES {
            let result = merge3(case.base, case.ours, case.theirs);
            assert_eq!(
                apply(case.ours, &result.changes),
                case.merged,
                "merged text for {}",
                case.name
            );
            assert_eq!(
                result.conflicts.len(),
                case.conflicts,
                "conflicts for {}: {:?}",
                case.name,
                result.conflicts
            );
            // What the buffer holds once the reader has taken their side
            // of every hunk both of us wrote (plan WP 2.1).
            assert_eq!(
                apply(case.ours, &take_everything(&result)),
                case.taken,
                "taking theirs for {}",
                case.name
            );
        }
    }

    #[test]
    fn merge_cases_hold_with_crlf_endings() {
        for case in CASES {
            let result = merge3(&crlf(case.base), &crlf(case.ours), &crlf(case.theirs));
            assert_eq!(
                apply(&crlf(case.ours), &result.changes),
                crlf(case.merged),
                "merged text for {}",
                case.name
            );
            assert_eq!(
                result.conflicts.len(),
                case.conflicts,
                "conflicts for {}",
                case.name
            );
            assert_eq!(
                apply(&crlf(case.ours), &take_everything(&result)),
                crlf(case.taken),
                "taking theirs for {}",
                case.name
            );
        }
    }

    #[test]
    fn a_conflict_carries_both_versions_and_where_ours_sits() {
        let result = merge3("a\nb\nc\n", "a\nours\nc\n", "a\ntheirs\nc\n");
        assert_eq!(
            result.conflicts,
            vec![Conflict {
                from: 2,
                to: 7,
                ours: "ours\n".to_owned(),
                theirs: "theirs\n".to_owned(),
            }]
        );
    }

    #[test]
    fn changes_and_conflicts_never_overlap() {
        let result = merge3(
            "a\nb\nc\nd\ne\nf\ng\n",
            "a\nb\nc\nOURS\ne\nf\ng\n",
            "AAA\nb\nc\nTHEIRS\ne\nf\nGGG\n",
        );
        for conflict in &result.conflicts {
            for change in &result.changes {
                assert!(
                    change.to <= conflict.from || change.from >= conflict.to,
                    "change {change:?} overlaps conflict {conflict:?}"
                );
            }
        }
    }
}

#[cfg(test)]
mod properties {
    use proptest::prelude::*;

    use super::*;

    /// Short lines from a small alphabet, so that lines repeat and the
    /// alignment has to work for it.
    fn document() -> impl Strategy<Value = String> {
        prop::collection::vec(prop_oneof!["[ab]{0,3}", Just(String::new())], 0..14).prop_map(
            |lines| {
                lines.iter().fold(String::new(), |mut text, line| {
                    text.push_str(line);
                    text.push('\n');
                    text
                })
            },
        )
    }

    proptest! {
        #[test]
        fn edits_turn_the_old_text_into_the_new(old in document(), new in document()) {
            prop_assert_eq!(apply(&old, &edits(&old, &new)), new);
        }

        /// A clean buffer takes the whole of the external write.
        #[test]
        fn merging_into_a_clean_buffer_gives_theirs(base in document(), theirs in document()) {
            let result = merge3(&base, &base, &theirs);
            prop_assert!(result.conflicts.is_empty());
            prop_assert_eq!(apply(&base, &result.changes), theirs);
        }

        /// Both sides made the same edit: there is nothing to bring over
        /// and nothing to decide.
        #[test]
        fn the_same_change_on_both_sides_is_quiet(base in document(), ours in document()) {
            let result = merge3(&base, &ours, &ours);
            prop_assert!(result.conflicts.is_empty());
            prop_assert!(result.changes.is_empty());
        }

        /// They did not write anything new, so nothing arrives.
        #[test]
        fn an_unchanged_file_changes_nothing(base in document(), ours in document()) {
            let result = merge3(&base, &ours, &base);
            prop_assert!(result.conflicts.is_empty());
            prop_assert!(result.changes.is_empty());
        }

        /// The merge does not depend on how the lines end.
        #[test]
        fn the_result_is_the_same_with_crlf(
            base in document(),
            ours in document(),
            theirs in document(),
        ) {
            let lf = merge3(&base, &ours, &theirs);
            let crlf = |text: &str| text.replace('\n', "\r\n");
            let with_crlf = merge3(&crlf(&base), &crlf(&ours), &crlf(&theirs));
            prop_assert_eq!(with_crlf.conflicts.len(), lf.conflicts.len());
            prop_assert_eq!(
                apply(&crlf(&ours), &with_crlf.changes).replace("\r\n", "\n"),
                apply(&ours, &lf.changes)
            );
        }

        /// Whatever the merge decides, the ranges it hands back are
        /// ordered and disjoint, which is what one transaction needs.
        #[test]
        fn results_are_ordered_and_disjoint(
            base in document(),
            ours in document(),
            theirs in document(),
        ) {
            let result = merge3(&base, &ours, &theirs);
            let mut spans: Vec<(u32, u32)> = result.changes.iter().map(|c| (c.from, c.to)).collect();
            spans.extend(result.conflicts.iter().map(|c| (c.from, c.to)));
            spans.sort_unstable();
            for pair in spans.windows(2) {
                prop_assert!(pair[0].1 <= pair[1].0, "{:?} then {:?}", pair[0], pair[1]);
            }
        }
    }
}
