//! The merge budget from design section 10: an external change to a 1 MB
//! document has to be merged in under 200 ms, because the reader is
//! typing while it happens.
//!
//! The number below is measured, not promised: `cargo test` builds
//! without optimizations, so the release budget only applies when the
//! test is built that way. The debug bound is loose on purpose. What it
//! guards is the shape of the algorithm, and an accidental quadratic
//! shows up at ten times over budget, not at ten percent.

use std::fmt::Write;
use std::time::Instant;

use markdown_core::{apply, merge3};

const BUDGET_MS: u128 = if cfg!(debug_assertions) { 2_000 } else { 200 };

/// Five times the budget on a runner whose cores are shared with other
/// work, which is what `BENCH_RUNNER=shared` says (ADR 0038). The
/// numbers below are measured on the machine they were written on, and
/// the shared runner measures anything from that to ten times it: what
/// plan 7.4 asks of it is to catch a disaster, not to flake on a busy
/// machine.
fn bound(ms: u128) -> u128 {
    if std::env::var("BENCH_RUNNER").is_ok_and(|runner| runner == "shared") {
        ms * 5
    } else {
        ms
    }
}

/// About a megabyte of ordinary prose: short paragraphs under headings.
fn document(seed: usize) -> String {
    let mut text = String::with_capacity(1_050_000);
    let mut n = seed;
    while text.len() < 1_000_000 {
        n = n.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let paragraph = (n >> 16) % 900;
        let _ = writeln!(text, "## Section {paragraph}\n");
        for line in 0..6 {
            let _ = writeln!(
                text,
                "Line {line} of section {paragraph}, with enough words on it to look like prose."
            );
        }
        text.push('\n');
    }
    text
}

/// Replace every `every`th line, which is what a tool that rewrites parts
/// of a document does.
fn revise(text: &str, every: usize, word: &str) -> String {
    text.lines()
        .enumerate()
        .map(|(i, line)| {
            if i % every == 0 && !line.is_empty() {
                format!("{word} {line}\n")
            } else {
                format!("{line}\n")
            }
        })
        .collect()
}

fn timed(name: &str, base: &str, ours: &str, theirs: &str) -> u128 {
    let start = Instant::now();
    let result = merge3(base, ours, theirs);
    let took = start.elapsed().as_millis();
    let merged = apply(ours, &result.changes);
    println!(
        "{name}: {took} ms, {} changes, {} conflicts, {} bytes in, {} out",
        result.changes.len(),
        result.conflicts.len(),
        base.len(),
        merged.len(),
    );
    took
}

#[test]
fn a_one_megabyte_external_change_merges_within_the_budget() {
    let base = document(7);
    assert!(base.len() > 1_000_000, "the fixture is a megabyte");
    let ours = revise(&base, 400, "OURS");
    let theirs = revise(&base, 37, "THEIRS");
    let took = timed("scattered changes on both sides", &base, &ours, &theirs);
    let budget = bound(BUDGET_MS);
    assert!(took < budget, "{took} ms is over the {budget} ms budget");
}

/// The worst case for a line diff: nothing survives. It has to stay
/// inside the budget by giving up early, not by working harder.
#[test]
fn a_full_rewrite_stays_within_the_budget() {
    let base = document(7);
    let ours = revise(&base, 400, "OURS");
    let theirs = document(99);
    let took = timed("a full rewrite", &base, &ours, &theirs);
    let budget = bound(BUDGET_MS);
    assert!(took < budget, "{took} ms is over the {budget} ms budget");
}

/// A clean buffer taking a whole external write is the common case, and
/// the one the reader waits on with the file already in front of them.
#[test]
fn a_clean_buffer_takes_a_one_megabyte_write_within_the_budget() {
    let base = document(7);
    let theirs = revise(&base, 37, "THEIRS");
    let took = timed("into a clean buffer", &base, &base, &theirs);
    let budget = bound(BUDGET_MS);
    assert!(took < budget, "{took} ms is over the {budget} ms budget");
}
