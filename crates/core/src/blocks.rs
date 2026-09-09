//! The semantic diff: aligning two block lists (design 7.3, plan WP 2.2).
//!
//! Line diffs are wrong for prose. Rewrapping a paragraph replaces every
//! line of it and says nothing different; changing one cell of a table
//! replaces the row. The unit that matches what a reader means by "this
//! changed" is the block, and the frontend hands both sides over already
//! flattened into blocks because it is the side that holds the parse
//! trees.
//!
//! What happens here is the alignment (design 7.3 steps 2 to 4): a
//! longest common subsequence over the blocks, then the blocks left
//! unmatched paired up — first the ones that are the same block
//! somewhere else, which is a move, then the ones that are alike enough
//! to be the same block edited — and a word diff inside each pair.

use std::collections::HashMap;
use std::ops::Range;

use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::diff::distance_floor;
use crate::types::{Block, BlockOp, WordRun};

/// How far apart two block lists may be before the alignment is not
/// worth its time, for the same reason `diff.rs` has the bound on lines,
/// and the same number: past it the whole middle is one region, because
/// the answer to a rewritten document is that it was rewritten.
///
/// Measured on the megabyte of `tests/block_budget.rs`: half of its
/// paragraphs revised is a distance of about 4700, just inside, and
/// costs 58 ms to align properly. A document rewritten from end to end
/// is twice that, and the bound turns it into one region in 2.
///
/// It is a lower bound on the distance and not an upper one, so it
/// cannot see every expensive input coming; the budget test measures
/// and bounds the one it misses.
const MAX_DISTANCE: usize = 5_000;

/// How alike two blocks have to be to be the same block edited rather
/// than one gone and another arrived.
///
/// Tuned against the cases below. Above about 0.6 a paragraph that had a
/// sentence added to it stops pairing with itself; below about 0.4 two
/// unrelated paragraphs of English pair with each other, because prose
/// in one language is more alike than it looks to an edit distance.
const PAIR_SIMILARITY: f32 = 0.5;

/// The largest region the pairing pass will look at, in blocks per side.
/// It is quadratic in the region and the region is what nobody matched,
/// so a rewritten document has to be allowed to be a rewritten document.
const MAX_PAIR_REGION: usize = 64;

/// Where a similarity stops being measured and starts being assumed.
/// Two blocks that agree for four thousand characters are the same block
/// whatever they do afterwards, and the distance between them costs the
/// product of their lengths to find out.
const MAX_PAIR_CHARS: usize = 4_000;

/// What the alignment compares: a block is the same block as another
/// when it says the same thing in the same place in the structure.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Key<'a> {
    kind: &'a str,
    text: &'a str,
}

fn keys(blocks: &[Block]) -> Vec<Key<'_>> {
    blocks
        .iter()
        .map(|block| Key {
            kind: &block.kind,
            text: &block.text,
        })
        .collect()
}

/// One step of the first pass: a pair the subsequence matched, or a
/// stretch neither side matched in.
enum Slot {
    Equal(usize, usize),
    Region(Range<usize>, Range<usize>),
}

/// What became of one block. The two sides use the same words: `Gone`
/// only ever describes an old block and `Fresh` only a new one.
#[derive(Clone, Copy, PartialEq)]
enum Fate {
    Gone,
    Fresh,
    Same(usize),
    Moved(usize),
    Changed(usize),
}

/// The longest common subsequence of the two lists, as slots.
///
/// Deletions and insertions that meet are one region: they are one place
/// where the two documents disagree, and the passes that follow ask what
/// happened *there* rather than to one list or the other.
fn slots(old: &[Key], new: &[Key]) -> Vec<Slot> {
    let ops = if distance_floor(old, new) > MAX_DISTANCE {
        vec![DiffOp::Replace {
            old_index: 0,
            old_len: old.len(),
            new_index: 0,
            new_len: new.len(),
        }]
    } else {
        capture_diff_slices(Algorithm::Myers, old, new)
    };
    let mut out: Vec<Slot> = Vec::new();
    let (mut at_old, mut at_new) = (0usize, 0usize);
    for op in &ops {
        let (old_len, new_len) = lengths(op);
        if matches!(op, DiffOp::Equal { .. }) {
            for step in 0..old_len {
                out.push(Slot::Equal(at_old + step, at_new + step));
            }
        } else {
            let (olds, news) = (at_old..at_old + old_len, at_new..at_new + new_len);
            match out.last_mut() {
                Some(Slot::Region(before, after)) => {
                    before.end = olds.end;
                    after.end = news.end;
                }
                _ => out.push(Slot::Region(olds, news)),
            }
        }
        at_old += old_len;
        at_new += new_len;
    }
    out
}

/// How many blocks an op covers on each side. `similar` fills in only
/// one of the two indices on `Insert` and `Delete`, so the walk keeps
/// its own cursors and reads only what each op states.
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

/// Blocks that are the same block somewhere else: a section moved down
/// (design 7.3 step 4).
///
/// This runs before the similarity pairing because being the same block
/// is a better answer than being alike, and a moved section usually
/// lands beside a paragraph it would otherwise be paired with.
fn moves(slots: &[Slot], old: &[Key], new: &[Key], old_fate: &mut [Fate], new_fate: &mut [Fate]) {
    let mut left: HashMap<Key, Vec<usize>> = HashMap::new();
    for slot in slots {
        if let Slot::Region(olds, _) = slot {
            for index in olds.clone() {
                left.entry(old[index]).or_default().push(index);
            }
        }
    }
    if left.is_empty() {
        return;
    }
    for slot in slots {
        let Slot::Region(_, news) = slot else {
            continue;
        };
        for index in news.clone() {
            let Some(waiting) = left.get_mut(&new[index]) else {
                continue;
            };
            // Taken in order, so two copies of the same block that both
            // moved keep the order they were written in.
            if waiting.is_empty() {
                continue;
            }
            let from = waiting.remove(0);
            old_fate[from] = Fate::Moved(index);
            new_fate[index] = Fate::Moved(from);
        }
    }
}

/// Blocks alike enough to be one another edited (design 7.3 step 2).
///
/// Only within a region: an edited paragraph is where its old self was,
/// and pairing across the document would call two paragraphs about the
/// same subject the same paragraph.
///
/// The kinds are not required to match. A heading promoted a level and a
/// paragraph made into a list item are both one block becoming another,
/// and a diff that reported them as one gone and another arrived would
/// be describing the tree rather than the document.
fn pairs(
    slots: &[Slot],
    old: &[Block],
    new: &[Block],
    old_fate: &mut [Fate],
    new_fate: &mut [Fate],
) {
    for slot in slots {
        let Slot::Region(olds, news) = slot else {
            continue;
        };
        if olds.len() > MAX_PAIR_REGION || news.len() > MAX_PAIR_REGION {
            continue;
        }
        for fresh in news.clone() {
            if new_fate[fresh] != Fate::Fresh {
                continue;
            }
            let mut best: Option<(usize, f32)> = None;
            for gone in olds.clone() {
                if old_fate[gone] != Fate::Gone {
                    continue;
                }
                let score = similarity(&old[gone].text, &new[fresh].text);
                if score >= PAIR_SIMILARITY && best.is_none_or(|(_, high)| score > high) {
                    best = Some((gone, score));
                }
            }
            if let Some((gone, _)) = best {
                old_fate[gone] = Fate::Changed(fresh);
                new_fate[fresh] = Fate::Changed(gone);
            }
        }
    }
}

/// The characters of a text up to a bound, on a character boundary.
fn capped(text: &str) -> &str {
    match text.char_indices().nth(MAX_PAIR_CHARS) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// How alike two texts are, from 0 to 1: the edit distance between them
/// against the length of the longer.
fn similarity(a: &str, b: &str) -> f32 {
    if a == b {
        return 1.0;
    }
    let (a, b) = (capped(a), capped(b));
    let (long, short) = {
        let (x, y) = (a.chars().count(), b.chars().count());
        (x.max(y), x.min(y))
    };
    if long == 0 {
        return 1.0;
    }
    // The difference in length is a lower bound on the distance, so a
    // pair that cannot clear the threshold is never measured.
    #[expect(clippy::cast_precision_loss, reason = "a ratio of two lengths")]
    let bound = short as f32 / long as f32;
    if bound < PAIR_SIMILARITY {
        return 0.0;
    }
    #[expect(clippy::cast_precision_loss, reason = "a ratio of two lengths")]
    let ratio = 1.0 - levenshtein(a, b) as f32 / long as f32;
    ratio
}

/// Edit distance in characters, two rows at a time.
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut current: Vec<usize> = vec![0; b.len() + 1];
    for (i, from) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, to) in b.iter().enumerate() {
            let substitute = prev[j] + usize::from(from != to);
            current[j + 1] = substitute.min(prev[j + 1] + 1).min(current[j] + 1);
        }
        std::mem::swap(&mut prev, &mut current);
    }
    prev[b.len()]
}

/// A word of a block, with where it is in UTF-16 code units, which is
/// what the other end of this counts in.
struct Word<'a> {
    text: &'a str,
    from: u32,
    to: u32,
}

fn words(text: &str) -> Vec<Word<'_>> {
    let mut out = Vec::new();
    let mut start: Option<(usize, u32)> = None;
    let mut at: u32 = 0;
    for (index, character) in text.char_indices() {
        let unit = u32::try_from(character.len_utf16()).unwrap_or(1);
        if character.is_whitespace() {
            if let Some((from, from_unit)) = start.take() {
                out.push(Word {
                    text: &text[from..index],
                    from: from_unit,
                    to: at,
                });
            }
        } else if start.is_none() {
            start = Some((index, at));
        }
        at = at.saturating_add(unit);
    }
    if let Some((from, from_unit)) = start {
        out.push(Word {
            text: &text[from..],
            from: from_unit,
            to: at,
        });
    }
    out
}

/// Where a run of words starts, or where the missing ones would go.
fn at(words: &[Word], index: usize) -> u32 {
    match words.get(index) {
        Some(word) => word.from,
        None => words.last().map_or(0, |word| word.to),
    }
}

fn span(words: &[Word], range: &Range<usize>) -> (u32, u32) {
    match (words.get(range.start), range.end.checked_sub(1)) {
        (Some(first), Some(last)) if range.start < range.end => (first.from, words[last].to),
        _ => {
            let point = at(words, range.start);
            (point, point)
        }
    }
}

/// The words that differ inside a pair of blocks (design 7.3 step 3).
fn word_runs(old: &str, new: &str) -> Vec<WordRun> {
    let old_words = words(old);
    let new_words = words(new);
    let old_text: Vec<&str> = old_words.iter().map(|word| word.text).collect();
    let new_text: Vec<&str> = new_words.iter().map(|word| word.text).collect();
    let ops = if distance_floor(&old_text, &new_text) > MAX_DISTANCE {
        vec![DiffOp::Replace {
            old_index: 0,
            old_len: old_text.len(),
            new_index: 0,
            new_len: new_text.len(),
        }]
    } else {
        capture_diff_slices(Algorithm::Myers, &old_text, &new_text)
    };
    let mut out = Vec::new();
    let (mut at_old, mut at_new) = (0usize, 0usize);
    for op in &ops {
        let (old_len, new_len) = lengths(op);
        if !matches!(op, DiffOp::Equal { .. }) {
            let (old_from, old_to) = span(&old_words, &(at_old..at_old + old_len));
            let (new_from, new_to) = span(&new_words, &(at_new..at_new + new_len));
            out.push(WordRun {
                old_from,
                old_to,
                new_from,
                new_to,
            });
        }
        at_old += old_len;
        at_new += new_len;
    }
    out
}

fn index(at: usize) -> u32 {
    u32::try_from(at).unwrap_or(u32::MAX)
}

/// The alignment, in the order the two documents read.
///
/// Inside a region what left comes before what arrived, which is the
/// order the two versions are in: a reader stepping through the ops sees
/// the old paragraph go and the new one take its place.
fn emit(
    slots: &[Slot],
    old: &[Block],
    new: &[Block],
    old_fate: &[Fate],
    new_fate: &[Fate],
) -> Vec<BlockOp> {
    let mut out = Vec::new();
    for slot in slots {
        match slot {
            Slot::Equal(gone, fresh) => out.push(BlockOp::Equal {
                old: index(*gone),
                new: index(*fresh),
            }),
            Slot::Region(olds, news) => {
                for gone in olds.clone() {
                    if old_fate[gone] == Fate::Gone {
                        out.push(BlockOp::Deleted { old: index(gone) });
                    }
                }
                for fresh in news.clone() {
                    out.push(match new_fate[fresh] {
                        Fate::Changed(gone) => BlockOp::Changed {
                            old: index(gone),
                            new: index(fresh),
                            words: word_runs(&old[gone].text, &new[fresh].text),
                        },
                        Fate::Moved(gone) => BlockOp::Moved {
                            old: index(gone),
                            new: index(fresh),
                        },
                        _ => BlockOp::Inserted { new: index(fresh) },
                    });
                }
            }
        }
    }
    out
}

/// Align two block lists (design 7.3).
#[must_use]
pub fn block_diff(old: &[Block], new: &[Block]) -> Vec<BlockOp> {
    let old_keys = keys(old);
    let new_keys = keys(new);
    let slots = slots(&old_keys, &new_keys);
    let mut old_fate = vec![Fate::Gone; old.len()];
    let mut new_fate = vec![Fate::Fresh; new.len()];
    for slot in &slots {
        if let Slot::Equal(gone, fresh) = slot {
            old_fate[*gone] = Fate::Same(*fresh);
            new_fate[*fresh] = Fate::Same(*gone);
        }
    }
    moves(&slots, &old_keys, &new_keys, &mut old_fate, &mut new_fate);
    pairs(&slots, old, new, &mut old_fate, &mut new_fate);
    emit(&slots, old, new, &old_fate, &new_fate)
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    /// Blocks laid end to end with a newline between them, which is what
    /// a flattened document looks like. The ranges are not what this
    /// module reasons about — it answers in indices — but they are what
    /// the frontend puts back, so they are real here too.
    fn blocks(rows: &[(&str, &str)]) -> Vec<Block> {
        let mut at = 0u32;
        rows.iter()
            .map(|(kind, text)| {
                let from = at;
                let to = from + u32::try_from(text.encode_utf16().count()).unwrap_or(0);
                at = to + 1;
                Block {
                    kind: (*kind).to_owned(),
                    text: (*text).to_owned(),
                    from,
                    to,
                }
            })
            .collect()
    }

    /// The alignment in one line: `o=n` kept, `o~n` edited, `o>n` moved,
    /// `+n` arrived, `-o` gone.
    fn shown(ops: &[BlockOp]) -> String {
        ops.iter()
            .map(|op| match op {
                BlockOp::Equal { old, new } => format!("{old}={new}"),
                BlockOp::Changed { old, new, .. } => format!("{old}~{new}"),
                BlockOp::Moved { old, new } => format!("{old}>{new}"),
                BlockOp::Inserted { new } => format!("+{new}"),
                BlockOp::Deleted { old } => format!("-{old}"),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    struct Case {
        name: &'static str,
        old: &'static [(&'static str, &'static str)],
        new: &'static [(&'static str, &'static str)],
        ops: &'static str,
    }

    /// The semantic diff cases of design section 7.3 and plan WP 2.2.
    const CASES: &[Case] = &[
        Case {
            name: "nothing changed",
            old: &[("paragraph", "one"), ("paragraph", "two")],
            new: &[("paragraph", "one"), ("paragraph", "two")],
            ops: "0=0 1=1",
        },
        Case {
            name: "a word changed in a paragraph",
            old: &[("paragraph", "The cat sat on the mat")],
            new: &[("paragraph", "The cat sat on the rug")],
            ops: "0~0",
        },
        Case {
            name: "a section moved down",
            old: &[
                ("heading2", "## A"),
                ("paragraph", "about a"),
                ("heading2", "## B"),
                ("paragraph", "about b"),
            ],
            new: &[
                ("heading2", "## B"),
                ("paragraph", "about b"),
                ("heading2", "## A"),
                ("paragraph", "about a"),
            ],
            ops: "2>0 3>1 0=2 1=3",
        },
        Case {
            name: "one cell of a table",
            old: &[
                ("table>table_row", "| a | b |"),
                ("table>table_row", "| - | - |"),
                ("table>table_row", "| 1 | 2 |"),
                ("table>table_row", "| 3 | 4 |"),
            ],
            new: &[
                ("table>table_row", "| a | b |"),
                ("table>table_row", "| - | - |"),
                ("table>table_row", "| 1 | 9 |"),
                ("table>table_row", "| 3 | 4 |"),
            ],
            ops: "0=0 1=1 2~2 3=3",
        },
        Case {
            name: "a list reordered",
            old: &[
                ("list>item>paragraph", "apples"),
                ("list>item>paragraph", "pears"),
                ("list>item>paragraph", "plums"),
            ],
            new: &[
                ("list>item>paragraph", "plums"),
                ("list>item>paragraph", "apples"),
                ("list>item>paragraph", "pears"),
            ],
            ops: "2>0 0=1 1=2",
        },
        Case {
            name: "a paragraph split in two",
            old: &[(
                "paragraph",
                "The first thought. And then the second thought.",
            )],
            new: &[
                ("paragraph", "The first thought."),
                ("paragraph", "And then the second thought."),
            ],
            ops: "+0 0~1",
        },
        Case {
            name: "a heading promoted",
            old: &[("heading2", "## Findings"), ("paragraph", "text")],
            new: &[("heading1", "# Findings"), ("paragraph", "text")],
            ops: "0~0 1=1",
        },
        Case {
            name: "a paragraph replaced by an unrelated one",
            old: &[("paragraph", "Rainfall in the valley was heavy that year")],
            new: &[("paragraph", "Compile the project with the release profile")],
            ops: "-0 +0",
        },
        Case {
            name: "a paragraph added at the end",
            old: &[("paragraph", "one")],
            new: &[("paragraph", "one"), ("paragraph", "two")],
            ops: "0=0 +1",
        },
        Case {
            name: "a paragraph taken out of the middle",
            old: &[
                ("paragraph", "one"),
                ("paragraph", "two"),
                ("paragraph", "three"),
            ],
            new: &[("paragraph", "one"), ("paragraph", "three")],
            ops: "0=0 -1 2=1",
        },
        Case {
            name: "a paragraph pulled into a list",
            old: &[("paragraph", "buy the milk")],
            new: &[("list>item>paragraph", "buy the milk")],
            ops: "0~0",
        },
        Case {
            name: "a document that starts from nothing",
            old: &[],
            new: &[("paragraph", "one")],
            ops: "+0",
        },
    ];

    /// One assertion over the whole table, so a change to the engine
    /// shows every case it moved rather than the first one.
    #[test]
    fn the_semantic_diff_cases() {
        let mut got = String::new();
        let mut want = String::new();
        for case in CASES {
            let ops = block_diff(&blocks(case.old), &blocks(case.new));
            let _ = writeln!(got, "{}: {}", case.name, shown(&ops));
            let _ = writeln!(want, "{}: {}", case.name, case.ops);
        }
        assert_eq!(got, want);
    }

    /// What makes the result an alignment: every block on both sides is
    /// accounted for exactly once. Without this a change tracker can
    /// lose a block quietly, which is the one thing it must not do.
    #[test]
    fn every_block_is_accounted_for_once() {
        for case in CASES {
            let old = blocks(case.old);
            let new = blocks(case.new);
            let mut olds = vec![0u32; old.len()];
            let mut news = vec![0u32; new.len()];
            for op in block_diff(&old, &new) {
                match op {
                    BlockOp::Equal { old, new }
                    | BlockOp::Changed { old, new, .. }
                    | BlockOp::Moved { old, new } => {
                        olds[old as usize] += 1;
                        news[new as usize] += 1;
                    }
                    BlockOp::Inserted { new } => news[new as usize] += 1,
                    BlockOp::Deleted { old } => olds[old as usize] += 1,
                }
            }
            assert!(
                olds.iter().all(|seen| *seen == 1),
                "old side: {}",
                case.name
            );
            assert!(
                news.iter().all(|seen| *seen == 1),
                "new side: {}",
                case.name
            );
        }
    }

    #[test]
    fn a_changed_block_says_which_words() {
        let old = blocks(&[("paragraph", "The cat sat on the mat")]);
        let new = blocks(&[("paragraph", "The cat sat on the rug")]);
        let [BlockOp::Changed { words, .. }] = &block_diff(&old, &new)[..] else {
            panic!("expected one changed block");
        };
        assert_eq!(
            words,
            &[WordRun {
                old_from: 19,
                old_to: 22,
                new_from: 19,
                new_to: 22,
            }]
        );
        assert_eq!(&old[0].text[19..22], "mat");
        assert_eq!(&new[0].text[19..22], "rug");
    }

    #[test]
    fn a_word_only_one_side_has_is_a_run_with_an_empty_other_side() {
        let old = blocks(&[("paragraph", "one two")]);
        let new = blocks(&[("paragraph", "one and two")]);
        let [BlockOp::Changed { words, .. }] = &block_diff(&old, &new)[..] else {
            panic!("expected one changed block");
        };
        assert_eq!(
            words,
            &[WordRun {
                old_from: 4,
                old_to: 4,
                new_from: 4,
                new_to: 7,
            }]
        );
    }

    /// Offsets are UTF-16 code units because the other end of this is a
    /// `CodeMirror` document, where an emoji is two.
    #[test]
    fn word_offsets_count_utf16_units() {
        let old = blocks(&[("paragraph", "🌊 tide out")]);
        let new = blocks(&[("paragraph", "🌊 tide in")]);
        let [BlockOp::Changed { words, .. }] = &block_diff(&old, &new)[..] else {
            panic!("expected one changed block");
        };
        assert_eq!(words[0].new_from, 8);
    }

    /// A rewrite has no pairs to find, and has to say so rather than
    /// spend the quadratic pass finding that out.
    #[test]
    fn a_rewrite_larger_than_the_pairing_bound_is_told_as_it_is() {
        let rows: Vec<(String, String)> = (0..MAX_PAIR_REGION + 5)
            .map(|n| ("paragraph".to_owned(), format!("old paragraph number {n}")))
            .collect();
        let old: Vec<(&str, &str)> = rows
            .iter()
            .map(|(kind, text)| (kind.as_str(), text.as_str()))
            .collect();
        let fresh: Vec<(String, String)> = (0..MAX_PAIR_REGION + 5)
            .map(|n| ("paragraph".to_owned(), format!("new paragraph number {n}")))
            .collect();
        let new: Vec<(&str, &str)> = fresh
            .iter()
            .map(|(kind, text)| (kind.as_str(), text.as_str()))
            .collect();
        let ops = block_diff(&blocks(&old), &blocks(&new));
        assert!(
            ops.iter()
                .all(|op| matches!(op, BlockOp::Deleted { .. } | BlockOp::Inserted { .. }))
        );
    }

    #[test]
    fn two_empty_documents_align_to_nothing() {
        assert!(block_diff(&[], &[]).is_empty());
    }
}
