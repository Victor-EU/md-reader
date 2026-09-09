//! Content search across the open folder (design 4.1, plan WP 2.4).
//!
//! ripgrep's own pieces: the same walker the tree uses, `grep-regex` for
//! the pattern and `grep-searcher` for the reading. The searcher is what
//! makes this worth borrowing rather than writing — memory maps where
//! they help, a line buffer where they do not, and binary files left
//! alone at the first zero byte.
//!
//! Results are handed out one at a time as they are found rather than
//! collected and returned. A search of a large folder has its first
//! answers in milliseconds and its last ones much later, and a reader
//! looking for a phrase they know is in one file should not wait for the
//! walk to finish before they can click it.

use std::ops::Range;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use grep_matcher::Matcher as _;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};

use crate::document::Error;
use crate::folder::walker;
use crate::types::{SearchHit, SearchOptions};

/// Where a result row's text is cut. A matching line can be a whole
/// minified file; what the panel can show is the neighbourhood of the
/// match, and what it cannot show it says nothing about.
const LINE_LIMIT: usize = 300;
/// How much of the line before the match is kept when it is cut.
const AROUND: usize = 60;

/// What a finished search has to say about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub hits: u32,
    /// The result limit was reached, so the folder holds more of them.
    pub truncated: bool,
}

fn matcher(query: &str, options: &SearchOptions) -> Result<RegexMatcher, Error> {
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .fixed_strings(!options.regex)
        .line_terminator(Some(b'\n'))
        // The searcher hands the matcher one line at a time, terminator
        // and all, so `^` and `$` are the line's ends and not the file's.
        // This is what makes `^TODO` mean what the reader typed it to.
        .multi_line(true)
        .build(query)
        .map_err(|error| Error::BadQuery {
            query: query.to_owned(),
            message: error.to_string(),
        })
}

/// Whether this is a search that can be run, without running it.
///
/// A regular expression with a typo in it is the reader's mistake to see
/// at once, in the field they typed it into — not something a search
/// thread discovers and reports through a result channel.
///
/// # Errors
/// Fails when the pattern will not compile.
pub fn check(query: &str, options: &SearchOptions) -> Result<(), Error> {
    matcher(query, options).map(|_| ())
}

/// Search every file under `root`, calling `hit` with each result as it
/// is found. Returns once the folder is walked, the limit is reached, or
/// `stop` is set.
///
/// # Errors
/// Fails when the pattern will not compile. A file that cannot be read
/// is skipped: one unreadable file is not a reason to answer nothing.
pub fn search(
    root: &Path,
    query: &str,
    options: &SearchOptions,
    stop: &AtomicBool,
    mut hit: impl FnMut(SearchHit),
) -> Result<Found, Error> {
    let matcher = matcher(query, options)?;
    let limit = usize::try_from(options.max_results)
        .unwrap_or(usize::MAX)
        .max(1);
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .build();
    let mut hits: usize = 0;
    let mut truncated = false;
    for entry in walker(root).build() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let outcome = searcher.search_path(
            &matcher,
            path,
            UTF8(|line, text| {
                // One hit a line, at its first match: the panel is a list
                // of places to go, and a line is one place.
                let Ok(Some(at)) = matcher.find_at(text.as_bytes(), 0) else {
                    return Ok(true);
                };
                let found = shown(text, at.start()..at.end());
                hit(SearchHit {
                    path: path.to_path_buf(),
                    line: u32::try_from(line).unwrap_or(u32::MAX),
                    from: found.from,
                    to: found.to,
                    column: found.column,
                    text: found.text,
                });
                hits += 1;
                Ok(hits < limit && !stop.load(Ordering::Relaxed))
            }),
        );
        // A file that will not open — permissions, or it left between the
        // walk and the read — is one file, not the end of the search.
        drop(outcome);
        if hits >= limit {
            truncated = true;
            break;
        }
    }
    Ok(Found {
        hits: u32::try_from(hits).unwrap_or(u32::MAX),
        truncated,
    })
}

/// What a result row shows of the line, and where the match is — in the
/// row, and in the line, which are the same number until a long line is
/// cut. Offsets are UTF-16, which is what every position on the IPC is
/// counted in.
struct Shown {
    text: String,
    from: u32,
    to: u32,
    column: u32,
}

fn shown(line: &str, at: Range<usize>) -> Shown {
    let line = line.trim_end_matches(['\n', '\r']);
    let (mut start, mut end) = (0, line.len());
    if line.len() > LINE_LIMIT {
        start = floor(line, at.start.saturating_sub(AROUND));
        end = ceil(line, (start + LINE_LIMIT).min(line.len()));
    }
    let head = if start > 0 { "…" } else { "" };
    let tail = if end < line.len() { "…" } else { "" };
    let (from, to) = (at.start.clamp(start, end), at.end.clamp(start, end));
    let before = utf16(head) + utf16(&line[start..from]);
    Shown {
        text: format!("{head}{}{tail}", &line[start..end]),
        from: before,
        to: before + utf16(&line[from..to]),
        column: utf16(&line[..at.start.min(line.len())]),
    }
}

fn floor(text: &str, mut at: usize) -> usize {
    while at > 0 && !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

fn ceil(text: &str, mut at: usize) -> usize {
    while at < text.len() && !text.is_char_boundary(at) {
        at += 1;
    }
    at
}

fn utf16(text: &str) -> u32 {
    u32::try_from(text.chars().map(char::len_utf16).sum::<usize>()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    fn options(max: u32) -> SearchOptions {
        SearchOptions {
            case_sensitive: false,
            regex: false,
            max_results: max,
        }
    }

    /// Run a whole search and collect it, which is what a test wants and
    /// what the app never does.
    fn run(root: &Path, query: &str, options: &SearchOptions) -> (Vec<SearchHit>, Found) {
        let stop = AtomicBool::new(false);
        let mut hits = Vec::new();
        let found = search(root, query, options, &stop, |hit| hits.push(hit)).expect("search");
        hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        (hits, found)
    }

    #[test]
    fn finds_a_phrase_and_says_where_it_is() {
        let dir = folder(&[
            ("one.md", "first line\nthe cat sat\nlast line\n"),
            ("two.md", "nothing here\n"),
        ]);
        let (hits, found) = run(dir.path(), "cat", &options(100));
        assert_eq!(found.hits, 1);
        assert!(!found.truncated);
        assert_eq!(hits[0].path, dir.path().join("one.md"));
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].text, "the cat sat");
        assert_eq!((hits[0].from, hits[0].to), (4, 7));
        assert_eq!(hits[0].column, 4);
    }

    #[test]
    fn ignores_case_unless_asked_not_to() {
        let dir = folder(&[("a.md", "Cat\ncat\n")]);
        let (hits, _) = run(dir.path(), "cat", &options(100));
        assert_eq!(hits.len(), 2);
        let strict = SearchOptions {
            case_sensitive: true,
            ..options(100)
        };
        let (hits, _) = run(dir.path(), "cat", &strict);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
    }

    /// The plain search is for text, not for a pattern: a reader looking
    /// for `a.md` means those four characters.
    #[test]
    fn takes_a_plain_query_literally() {
        let dir = folder(&[("a.md", "a.md\naXmd\n")]);
        let (hits, _) = run(dir.path(), "a.md", &options(100));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
    }

    #[test]
    fn runs_a_regular_expression_when_asked_to() {
        let dir = folder(&[("a.md", "TODO: one\ndone\nTODO: two\n")]);
        let pattern = SearchOptions {
            regex: true,
            ..options(100)
        };
        let (hits, _) = run(dir.path(), r"^TODO: \w+$", &pattern);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn refuses_a_pattern_that_will_not_compile() {
        let bad = SearchOptions {
            regex: true,
            ..options(100)
        };
        assert!(check("open(", &bad).is_err());
        assert!(check("open(", &options(100)).is_ok());
    }

    #[test]
    fn leaves_out_what_gitignore_says_to() {
        let dir = folder(&[
            (".gitignore", "vendor/\n"),
            ("mine.md", "needle\n"),
            ("vendor/theirs.md", "needle\n"),
        ]);
        let (hits, _) = run(dir.path(), "needle", &options(100));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, dir.path().join("mine.md"));
    }

    #[test]
    fn stops_at_the_limit_and_says_it_did() {
        let files: Vec<(String, &str)> = (0..20).map(|n| (format!("{n}.md"), "needle\n")).collect();
        let pairs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), *b)).collect();
        let dir = folder(&pairs);
        let (hits, found) = run(dir.path(), "needle", &options(5));
        assert_eq!(hits.len(), 5);
        assert_eq!(found.hits, 5);
        assert!(found.truncated);
    }

    #[test]
    fn stops_when_it_is_told_to() {
        let files: Vec<(String, &str)> = (0..40).map(|n| (format!("{n}.md"), "needle\n")).collect();
        let pairs: Vec<(&str, &str)> = files.iter().map(|(a, b)| (a.as_str(), *b)).collect();
        let dir = folder(&pairs);
        let stop = AtomicBool::new(false);
        let mut hits = 0;
        let found = search(dir.path(), "needle", &options(1000), &stop, |_| {
            hits += 1;
            stop.store(true, Ordering::Relaxed);
        })
        .expect("search");
        assert_eq!(hits, 1);
        assert_eq!(found.hits, 1);
        assert!(!found.truncated);
    }

    #[test]
    fn says_nothing_about_a_binary_file() {
        let dir = folder(&[("a.md", "needle\n")]);
        fs::write(dir.path().join("blob.bin"), b"needle\x00needle").expect("write");
        let (hits, _) = run(dir.path(), "needle", &options(100));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, dir.path().join("a.md"));
    }

    /// A minified file is one line long. The panel shows the part of it
    /// the match is in, and says at both ends that there is more.
    #[test]
    fn shows_the_neighbourhood_of_a_match_on_a_very_long_line() {
        let line = format!("{}needle{}", "x".repeat(500), "y".repeat(500));
        let dir = folder(&[("a.md", line.as_str())]);
        let (hits, _) = run(dir.path(), "needle", &options(100));
        let hit = &hits[0];
        assert!(hit.text.len() < 320, "{} characters", hit.text.len());
        assert!(hit.text.starts_with('…') && hit.text.ends_with('…'));
        // Where it is in the row is not where it is in the line, and the
        // cursor goes by the line.
        assert_eq!(hit.column, 500);
        assert_ne!(hit.from, hit.column);
        let from = usize::try_from(hit.from).expect("offset");
        let to = usize::try_from(hit.to).expect("offset");
        assert_eq!(
            &hit.text.chars().collect::<Vec<_>>()[from..to],
            "needle".chars().collect::<Vec<_>>()
        );
    }

    /// Offsets are UTF-16, so a line with an emoji in front of the match
    /// still points at the match.
    #[test]
    fn counts_offsets_the_way_the_frontend_will() {
        let dir = folder(&[("a.md", "🌍 needle\n")]);
        let (hits, _) = run(dir.path(), "needle", &options(100));
        assert_eq!((hits[0].from, hits[0].to), (3, 9));
    }

    #[test]
    fn reports_one_hit_a_line_however_many_matches_it_holds() {
        let dir = folder(&[("a.md", "needle needle needle\n")]);
        let (hits, _) = run(dir.path(), "needle", &options(100));
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].from, hits[0].to), (0, 6));
    }
}
