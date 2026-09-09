//! Invariant C from design section 10 through the real file path: every
//! committed corpus file, opened and saved with the buffer the editor
//! would hold (LF-normalized, BOM kept as U+FEFF), comes back byte for
//! byte. Then one edit, and the only difference is that edit.
//!
//! Both sets, because they fail differently. The adversarial files are
//! hand-written to break the encoder — BOMs, CRLF, no final newline. The
//! generated files are what a model actually writes, which is the shape
//! this app spends its life saving.

use std::path::{Path, PathBuf};

use mdreader_core::{encode, read_document, save_document};

fn corpus_dir(set: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus")
        .join(set)
}

fn files() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ["adversarial", "generated"]
        .iter()
        .flat_map(|set| {
            std::fs::read_dir(corpus_dir(set))
                .unwrap_or_else(|e| panic!("corpus/{set} exists: {e}"))
                .filter_map(Result::ok)
                .map(|e| e.path())
        })
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    out.sort();
    assert!(
        out.len() >= 200,
        "expected both corpus sets, found {}",
        out.len()
    );
    out
}

fn editor_view(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

#[test]
fn open_and_save_unchanged_is_byte_identical() {
    let scratch = std::env::temp_dir().join(format!("mdreader-corpus-{}", std::process::id()));
    std::fs::create_dir_all(&scratch).expect("scratch dir");
    for file in files() {
        let original = std::fs::read(&file).expect("read corpus file");
        let target = scratch.join(file.file_name().expect("name"));
        std::fs::write(&target, &original).expect("copy");
        let doc = read_document(&target).expect("open");
        if doc.meta.read_only.is_some() {
            continue;
        }
        let view = editor_view(&doc.content);
        save_document(&target, &view, Some(&doc.meta.hash), &doc.meta.format).expect("save");
        let saved = std::fs::read(&target).expect("read back");
        assert_eq!(
            saved,
            original,
            "{} changed on a no-op save",
            file.display()
        );
    }
}

#[test]
fn one_edit_changes_only_its_bytes() {
    for file in files() {
        let original = std::fs::read(&file).expect("read corpus file");
        let doc = read_document(&file).expect("open");
        if doc.meta.read_only.is_some() || doc.content.is_empty() {
            continue;
        }
        let view = editor_view(&doc.content);
        let at = view.find('\n').map_or(view.len(), |i| i.min(view.len()));
        let edited = format!("{}Q{}", &view[..at], &view[at..]);
        let saved = encode(&edited, &doc.meta.format, Some(&original));
        let bom = usize::from(doc.meta.format.bom) * 3;
        let insert_at = bom + at;
        assert_eq!(
            &saved[..insert_at],
            &original[..insert_at],
            "{} prefix",
            file.display()
        );
        assert_eq!(saved[insert_at], b'Q', "{} inserted byte", file.display());
        assert_eq!(
            &saved[insert_at + 1..],
            &original[insert_at..],
            "{} suffix",
            file.display()
        );
    }
}
