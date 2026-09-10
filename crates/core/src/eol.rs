//! Line ending analysis and restoration.
//!
//! The editor normalizes every line ending to LF when it loads a string.
//! Writing the file back must undo that without touching anything else,
//! including files that mix endings: a line that survived the edit keeps
//! the ending it had, and only new lines get the file's dominant style.

use serde::{Deserialize, Serialize};
use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::diff::distance_floor;

/// One line ending style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    CrLf,
    Cr,
}

impl Eol {
    #[must_use]
    pub fn as_bytes(self) -> &'static [u8] {
        match self {
            Eol::Lf => b"\n",
            Eol::CrLf => b"\r\n",
            Eol::Cr => b"\r",
        }
    }
}

/// Counts of each terminator in a file.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EolStats {
    pub lf: usize,
    pub crlf: usize,
    pub cr: usize,
}

impl EolStats {
    /// The most common ending; LF when the file has none or on a tie.
    #[must_use]
    pub fn dominant(self) -> Eol {
        if self.crlf > self.lf && self.crlf >= self.cr {
            Eol::CrLf
        } else if self.cr > self.lf && self.cr > self.crlf {
            Eol::Cr
        } else {
            Eol::Lf
        }
    }

    /// True when more than one style occurs.
    #[must_use]
    pub fn mixed(self) -> bool {
        usize::from(self.lf > 0) + usize::from(self.crlf > 0) + usize::from(self.cr > 0) > 1
    }
}

/// Count the line terminators in `bytes`.
#[must_use]
pub fn scan(bytes: &[u8]) -> EolStats {
    let mut stats = EolStats::default();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                stats.crlf += 1;
                i += 2;
                continue;
            }
            b'\r' => stats.cr += 1,
            b'\n' => stats.lf += 1,
            _ => {}
        }
        i += 1;
    }
    stats
}

/// True when the text ends with any line terminator.
#[must_use]
pub fn ends_with_eol(bytes: &[u8]) -> bool {
    matches!(bytes.last(), Some(b'\n' | b'\r'))
}

/// Replace every CRLF and lone CR with LF, as the editor does on load.
#[must_use]
pub fn normalize_lf(text: &str) -> String {
    if !text.contains('\r') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// A line of the original file with the terminator it had.
struct Line<'a> {
    text: &'a str,
    ending: Option<Eol>,
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let ending = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => Some((Eol::CrLf, 2)),
            b'\r' => Some((Eol::Cr, 1)),
            b'\n' => Some((Eol::Lf, 1)),
            _ => None,
        };
        if let Some((eol, len)) = ending {
            lines.push(Line {
                text: &text[start..i],
                ending: Some(eol),
            });
            i += len;
            start = i;
        } else {
            i += 1;
        }
    }
    if start < bytes.len() {
        lines.push(Line {
            text: &text[start..],
            ending: None,
        });
    }
    lines
}

/// Apply one ending style to LF text, for a file that has no original.
#[must_use]
pub fn apply(content: &str, eol: Eol, ensure_trailing: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 16);
    for (i, part) in content.split('\n').enumerate() {
        if i > 0 {
            out.extend_from_slice(eol.as_bytes());
        }
        out.extend_from_slice(part.as_bytes());
    }
    if ensure_trailing && !ends_with_eol(&out) && !out.is_empty() {
        out.extend_from_slice(eol.as_bytes());
    }
    out
}

/// How far apart the two sides may be before the alignment is not worth
/// its time.
///
/// The same bound and the same reasoning as `diff::MAX_DISTANCE`: Myers
/// costs O((n+m)·d), and every save runs this on the thread the window
/// draws on. Past the bound the whole middle is one replacement, which
/// pairs the new lines with the old ones in order and is what the diff
/// would have said anyway about a file that was rewritten wholesale.
/// Measured before this guard existed: a 1 MB rewrite took 0.95 s and a
/// 10 MB one 92 s, with the window frozen for all of it.
const MAX_DISTANCE: usize = 5_000;

/// Pair each new line with the old line it should take its ending from.
///
/// Lines shared at both ends are trimmed first, so an edit in the middle
/// of a large file costs what the edit is worth rather than what the file
/// is worth -- and a rewrite past the bound still leaves the untouched
/// head and tail inheriting their own endings, which is the promise this
/// module exists to keep.
fn align_lines(old: &[Line<'_>], new: &[Line<'_>]) -> Vec<DiffOp> {
    let old_texts: Vec<&str> = old.iter().map(|l| l.text).collect();
    let new_texts: Vec<&str> = new.iter().map(|l| l.text).collect();
    let head = old_texts
        .iter()
        .zip(new_texts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let tail = old_texts[head..]
        .iter()
        .rev()
        .zip(new_texts[head..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_mid = &old_texts[head..old_texts.len() - tail];
    let new_mid = &new_texts[head..new_texts.len() - tail];
    let mut ops = Vec::new();
    if head > 0 {
        ops.push(DiffOp::Equal {
            old_index: 0,
            new_index: 0,
            len: head,
        });
    }
    if !(old_mid.is_empty() && new_mid.is_empty()) {
        if distance_floor(old_mid, new_mid) > MAX_DISTANCE {
            ops.push(DiffOp::Replace {
                old_index: head,
                old_len: old_mid.len(),
                new_index: head,
                new_len: new_mid.len(),
            });
        } else {
            for mut op in capture_diff_slices(Algorithm::Myers, old_mid, new_mid) {
                shift(&mut op, head);
                ops.push(op);
            }
        }
    }
    if tail > 0 {
        ops.push(DiffOp::Equal {
            old_index: old_texts.len() - tail,
            new_index: new_texts.len() - tail,
            len: tail,
        });
    }
    ops
}

/// Move an op from the trimmed middle back onto the whole line lists.
fn shift(op: &mut DiffOp, by: usize) {
    let (old_index, new_index) = match op {
        DiffOp::Equal {
            old_index,
            new_index,
            ..
        }
        | DiffOp::Delete {
            old_index,
            new_index,
            ..
        }
        | DiffOp::Insert {
            old_index,
            new_index,
            ..
        }
        | DiffOp::Replace {
            old_index,
            new_index,
            ..
        } => (old_index, new_index),
    };
    *old_index += by;
    *new_index += by;
}

/// Rebuild `content` (LF-normalized) with the line endings of `original`.
///
/// Lines are aligned with a line diff. A line present in both keeps its
/// original terminator, even in a file that mixes styles. A line that was
/// changed in place is paired with the line it replaced and keeps that
/// line's terminator; a wholly new line gets `dominant`. When
/// `ensure_trailing` is set and the result does not end with a terminator,
/// one is appended; a trailing terminator the buffer still has is never
/// removed.
#[must_use]
pub fn restore(original: &str, content: &str, dominant: Eol, ensure_trailing: bool) -> Vec<u8> {
    let old_lines = split_lines(original);
    let new_lines = split_lines(content);
    let ops = align_lines(&old_lines, &new_lines);
    let mut out = Vec::with_capacity(content.len() + 16);
    let mut emit = |new_index: usize, inherited: Option<Eol>| {
        if let Some(line) = new_lines.get(new_index) {
            out.extend_from_slice(line.text.as_bytes());
            if line.ending.is_some() {
                out.extend_from_slice(inherited.unwrap_or(dominant).as_bytes());
            }
        }
    };
    for op in &ops {
        match *op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for k in 0..len {
                    emit(
                        new_index + k,
                        old_lines.get(old_index + k).and_then(|l| l.ending),
                    );
                }
            }
            DiffOp::Delete { .. } => {}
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for k in 0..new_len {
                    emit(new_index + k, None);
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for k in 0..new_len {
                    let inherited = if k < old_len {
                        old_lines.get(old_index + k).and_then(|l| l.ending)
                    } else {
                        None
                    };
                    emit(new_index + k, inherited);
                }
            }
        }
    }
    if ensure_trailing && !out.is_empty() && !ends_with_eol(&out) {
        out.extend_from_slice(dominant.as_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_counts_each_style() {
        let s = scan(b"a\r\nb\nc\rd");
        assert_eq!((s.lf, s.crlf, s.cr), (1, 1, 1));
        assert!(s.mixed());
        assert_eq!(s.dominant(), Eol::Lf);
        assert_eq!(scan(b"a\r\nb\r\n").dominant(), Eol::CrLf);
        assert!(!scan(b"a\r\nb\r\n").mixed());
    }

    #[test]
    fn normalize_maps_every_style_to_lf() {
        assert_eq!(normalize_lf("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert_eq!(normalize_lf("plain"), "plain");
    }

    /// The guard, seen directly: past the bound the middle is one
    /// replacement rather than a Myers run over the whole file.
    #[test]
    fn a_wholesale_rewrite_does_not_run_the_line_diff() {
        use std::fmt::Write as _;
        let mut original = String::from("head\r\n");
        let mut content = String::from("head\n");
        for i in 0..(MAX_DISTANCE + 1_000) {
            let _ = write!(original, "old {i}\r\n");
            let _ = writeln!(content, "new {i}");
        }
        original.push_str("tail\r\n");
        content.push_str("tail\n");
        let old_lines = split_lines(&original);
        let new_lines = split_lines(&content);
        let ops = align_lines(&old_lines, &new_lines);
        assert_eq!(ops.len(), 3, "head, one replacement, tail: {ops:?}");
        assert!(matches!(ops[1], DiffOp::Replace { .. }));
        // And the lines nobody touched still keep the endings they had,
        // which is what a fallback to `apply` would have thrown away.
        let text = String::from_utf8(restore(&original, &content, Eol::Lf, false)).expect("utf8");
        assert!(text.starts_with("head\r\n"));
        assert!(text.ends_with("tail\r\n"));
    }

    /// The trim, seen directly: appending to a large file compares the
    /// appended lines and nothing else.
    #[test]
    fn an_append_only_aligns_what_was_appended() {
        use std::fmt::Write as _;
        let mut original = String::new();
        for i in 0..10_000 {
            let _ = write!(original, "line {i}\r\n");
        }
        let content = format!("{}last\n", normalize_lf(&original));
        let old_lines = split_lines(&original);
        let new_lines = split_lines(&content);
        let ops = align_lines(&old_lines, &new_lines);
        assert_eq!(
            ops.len(),
            2,
            "everything equal, then one insertion: {ops:?}"
        );
        assert!(matches!(ops[0], DiffOp::Equal { len: 10_000, .. }));
        assert!(matches!(ops[1], DiffOp::Insert { new_len: 1, .. }));
        let text = String::from_utf8(restore(&original, &content, Eol::CrLf, false)).expect("utf8");
        assert!(text.starts_with("line 0\r\n"));
        assert!(
            text.ends_with("last\r\n"),
            "a wholly new line takes the file's dominant style"
        );
    }

    #[test]
    fn restore_is_identity_when_nothing_changed() {
        for original in ["a\r\nb\r\n", "a\nb", "a\r\nb\nc\rd\n", "", "\n\n", "x\r"] {
            let content = normalize_lf(original);
            assert_eq!(
                restore(original, &content, Eol::Lf, false),
                original.as_bytes(),
                "{original:?}"
            );
        }
    }

    #[test]
    fn restore_keeps_per_line_endings_across_an_edit() {
        let original = "one\r\ntwo\nthree\r\n";
        let edited = "one\ntwo edited\nnew\nthree\n";
        // The edited line keeps its LF; the wholly new line gets the dominant CRLF.
        assert_eq!(
            restore(original, edited, Eol::CrLf, false),
            b"one\r\ntwo edited\nnew\r\nthree\r\n"
        );
        let edited = "one\ntwo\nthree\n";
        assert_eq!(
            restore(original, edited, Eol::CrLf, false),
            original.as_bytes()
        );
    }

    #[test]
    fn restore_handles_the_trailing_line() {
        assert_eq!(restore("a\r\nb", "a\nb", Eol::CrLf, false), b"a\r\nb");
        assert_eq!(restore("a\r\nb", "a\nb", Eol::CrLf, true), b"a\r\nb\r\n");
        assert_eq!(restore("a\r\nb\r\n", "a\nb", Eol::CrLf, false), b"a\r\nb");
    }

    #[test]
    fn apply_uses_one_style() {
        assert_eq!(apply("a\nb", Eol::CrLf, true), b"a\r\nb\r\n");
        assert_eq!(apply("a\nb\n", Eol::Cr, false), b"a\rb\r");
        assert_eq!(apply("", Eol::CrLf, true), b"");
    }
}
