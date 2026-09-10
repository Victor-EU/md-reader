//! The semantic diff budget from plan WP 2.2: an external change to a
//! 1 MB document has to be aligned in time for the marks to appear with
//! the write rather than after it.
//!
//! This is the Rust half of the end-to-end number. The other half is the
//! frontend's — flattening both sides and putting the middle on the
//! bridge — and is measured in `tools/bench/src/blockdiff.bench.test.ts`,
//! in the engines the app actually runs in.
//!
//! As with the merge budget, the number is measured rather than
//! promised: `cargo test` builds without optimizations, so the release
//! budget only applies when the test is built that way. What the loose
//! debug bound guards is the shape of the algorithm, and an accidental
//! quadratic shows up at ten times over budget, not at ten percent.

use std::fmt::Write as _;
use std::time::Instant;

use markdown_core::{Block, BlockOp, block_diff};

const BUDGET_MS: u128 = if cfg!(debug_assertions) { 4_000 } else { 150 };

/// The one shape of input that is allowed to cost more: a document
/// rebuilt out of its own paragraphs in another order. Myers costs
/// O((n+m)*d) and `d` is what a shuffle makes large, while the cheap
/// lower bound the alignment guards on stays small -- every block is
/// still there, so nothing about the two lists says in advance that
/// aligning them is expensive. Nothing that arrives from a file watcher
/// looks like this, the scan it happens on is in the background, and the
/// marks land a third of a second later than usual.
const WORST_MS: u128 = if cfg!(debug_assertions) { 20_000 } else { 700 };

/// About a megabyte of ordinary prose, as the blocks it flattens to:
/// short sections of a heading and a paragraph.
fn document(seed: usize) -> Vec<Block> {
    written(seed, "Line")
}

/// The same, with a word of its own, so two of them share no block.
fn written(seed: usize, word: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut bytes = 0usize;
    let mut n = seed;
    let mut at = 0u32;
    while bytes < 1_000_000 {
        n = n.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let section = (n >> 16) % 900;
        let mut push = |kind: &str, text: String| {
            let from = at;
            let to = from + u32::try_from(text.encode_utf16().count()).unwrap_or(0);
            at = to + 2;
            bytes += text.len() + 2;
            blocks.push(Block {
                kind: kind.to_owned(),
                text,
                from,
                to,
            });
        };
        push("heading2", format!("## {word} section {section}"));
        let mut paragraph = String::new();
        for line in 0..6 {
            let _ = write!(
                paragraph,
                "{word} {line} of section {section}, with enough words on it to look like prose. "
            );
        }
        push("paragraph", paragraph.trim_end().to_owned());
    }
    blocks
}

/// What a tool that rewrites parts of a document does: every `every`th
/// block comes back different.
fn revise(blocks: &[Block], every: usize, word: &str) -> Vec<Block> {
    blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            if i % every == 0 {
                Block {
                    text: format!("{word} {}", block.text),
                    ..block.clone()
                }
            } else {
                block.clone()
            }
        })
        .collect()
}

fn timed(name: &str, old: &[Block], new: &[Block]) -> u128 {
    let start = Instant::now();
    let ops = block_diff(old, new);
    let took = start.elapsed().as_millis();
    let changed = ops
        .iter()
        .filter(|op| !matches!(op, BlockOp::Equal { .. }))
        .count();
    println!(
        "{name}: {took} ms, {} blocks in, {} ops out, {changed} of them changes",
        old.len(),
        ops.len(),
    );
    took
}

#[test]
fn a_one_megabyte_external_change_aligns_within_the_budget() {
    let old = document(7);
    let new = revise(&old, 6, "REVISED");
    let took = timed("scattered changes", &old, &new);
    assert!(
        took < BUDGET_MS,
        "{took} ms is over the {BUDGET_MS} ms budget"
    );
}

/// The worst case: nothing survives. It has to stay inside the budget by
/// giving up early, not by working harder — the pairing pass is
/// quadratic and a rewritten document has nothing for it to find.
/// Half the document revised: the heaviest change the alignment still
/// takes on properly, and the case the `MAX_DISTANCE` bound is set just
/// above. Past it the answer stops being worth what it costs.
#[test]
fn half_the_paragraphs_revised_stays_within_the_budget() {
    let old = document(7);
    let new = revise(&old, 2, "REVISED");
    let took = timed("every second block", &old, &new);
    assert!(
        took < BUDGET_MS,
        "{took} ms is over the {BUDGET_MS} ms budget"
    );
}

/// Nothing survives. It has to stay inside the budget by giving up
/// early rather than working harder: the count of blocks one side holds
/// and the other does not is the whole document, which is the bound the
/// alignment refuses on, and the pairing pass has nothing to find in a
/// document that was rewritten.
#[test]
fn a_rewrite_gives_up_rather_than_working_harder() {
    let old = document(7);
    let new = written(99, "Sentence");
    let took = timed("a rewrite", &old, &new);
    assert!(
        took < BUDGET_MS,
        "{took} ms is over the {BUDGET_MS} ms budget"
    );
}

/// The worst case, and the one no cheap bound sees coming: the same
/// paragraphs in another order. Every block of the old document is still
/// somewhere in the new one, so the lower bound on the distance is small
/// and Myers runs -- and then finds a long edit script, because almost
/// nothing is where it was.
#[test]
fn the_same_material_in_another_order_is_the_worst_case() {
    let old = document(7);
    let new = document(99);
    let shared = old
        .iter()
        .filter(|block| new.iter().any(|other| other.text == block.text))
        .count();
    println!("{shared} of {} blocks are in both", old.len());
    let took = timed("another order", &old, &new);
    assert!(took < WORST_MS, "{took} ms is over the {WORST_MS} ms bound");
}

/// The common case while somebody is typing: the frontend has matched
/// off both ends and what arrives is the paragraph they are in.
#[test]
fn one_edited_paragraph_costs_what_one_paragraph_costs() {
    let old = document(7);
    let middle = old.len() / 2;
    let new = revise(&old[middle..=middle], 1, "TYPED");
    let took = timed("one paragraph", &old[middle..=middle], &new);
    assert!(took < 5, "{took} ms for one block");
}
