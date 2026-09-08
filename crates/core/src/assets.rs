//! Where a pasted or dropped image goes: an `assets` folder beside the
//! document, with a relative link written into the file (design 4.5).
//!
//! Two rules keep the folder honest. The bytes have to be an image — the
//! extension a clipboard or a file name claims is never trusted, the
//! magic number decides — because a paste should not be able to drop an
//! arbitrary file next to somebody's notes. And a name that is already
//! taken by the same bytes is reused rather than duplicated, so pasting
//! one screenshot into three places leaves one file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::atomic;
use crate::document::{Error, hash_bytes};

/// The folder images go in, beside the document.
const FOLDER: &str = "assets";

/// How long a stem may be, in characters. The same limit the frontend
/// proposes file names with, and comfortably inside every path limit.
const MAX_STEM: usize = 60;

/// How many names to try before giving up on a collision.
const MAX_TRIES: u32 = 999;

/// A stored image: where it landed, and the link the document gets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct AssetWrite {
    pub path: PathBuf,
    /// Relative to the document's folder, with forward slashes, ready to
    /// go between the parentheses of a markdown link.
    pub relative: String,
    /// False when the bytes were already there under this name.
    pub written: bool,
}

/// The image formats we recognise, by what the bytes actually start with.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    const FTYP: &[(&[u8], &str)] = &[
        (b"avif", "avif"),
        (b"avis", "avif"),
        (b"heic", "heic"),
        (b"heix", "heic"),
        (b"hevc", "heic"),
        (b"mif1", "heic"),
    ];
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        return Some("tiff");
    }
    if bytes.get(4..8) == Some(b"ftyp")
        && let Some(brand) = bytes.get(8..12)
        && let Some((_, ext)) = FTYP.iter().find(|(b, _)| *b == brand)
    {
        return Some(ext);
    }
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start();
    if (trimmed.starts_with("<svg") || trimmed.starts_with("<?xml")) && text.contains("<svg") {
        return Some("svg");
    }
    None
}

/// The stem of a name, with everything a file system objects to taken
/// out and everything else left alone. Never empty: `image` stands in.
fn safe_stem(name: &str) -> String {
    let base = Path::new(name)
        .file_stem()
        .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed
        .chars()
        .take(MAX_STEM)
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_owned();
    if trimmed.is_empty() {
        "image".to_owned()
    } else {
        trimmed
    }
}

fn folder_of(document: &Path) -> Result<PathBuf, Error> {
    document
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(FOLDER))
        .ok_or_else(|| Error::Write {
            path: document.to_path_buf(),
            message: "save the document before adding an image to it".to_owned(),
        })
}

fn write_error(path: &Path, message: &str) -> Error {
    Error::Write {
        path: path.to_path_buf(),
        message: message.to_owned(),
    }
}

/// The first free name in `dir`, or the taken one whose bytes are already
/// the bytes we are storing.
fn place(dir: &Path, stem: &str, ext: &str, hash: &str) -> Result<(PathBuf, bool), Error> {
    for n in 0..MAX_TRIES {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let path = dir.join(&name);
        match std::fs::read(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((path, true)),
            Err(error) => return Err(write_error(&path, &error.to_string())),
            Ok(existing) if hash_bytes(&existing) == hash => return Ok((path, false)),
            Ok(_) => {}
        }
    }
    Err(write_error(dir, "too many images with this name"))
}

/// Store `bytes` as an image beside `document`.
///
/// # Errors
/// Fails when the document has no folder yet, when the bytes are not an
/// image we recognise, or when the folder cannot be written to.
pub fn store_asset(document: &Path, name: &str, bytes: &[u8]) -> Result<AssetWrite, Error> {
    let dir = folder_of(document)?;
    let Some(ext) = sniff(bytes) else {
        return Err(write_error(
            Path::new(name),
            "that is not an image this app knows how to store",
        ));
    };
    std::fs::create_dir_all(&dir).map_err(|e| write_error(&dir, &e.to_string()))?;
    let (path, fresh) = place(&dir, &safe_stem(name), ext, &hash_bytes(bytes))?;
    if fresh {
        atomic::replace(&path, bytes).map_err(|e| write_error(&path, &e.to_string()))?;
    }
    let file = path
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    Ok(AssetWrite {
        path,
        relative: format!("{FOLDER}/{file}"),
        written: fresh,
    })
}

/// Store the file at `source` as an image beside `document`. The dropped
/// half of the same gesture.
///
/// # Errors
/// As `store_asset`, plus a source that cannot be read.
pub fn copy_asset(document: &Path, source: &Path) -> Result<AssetWrite, Error> {
    let bytes = std::fs::read(source).map_err(|e| Error::Read {
        path: source.to_path_buf(),
        message: e.to_string(),
    })?;
    let name = source
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    store_asset(document, &name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";

    fn doc(dir: &Path) -> PathBuf {
        dir.join("notes.md")
    }

    #[test]
    fn stores_an_image_in_an_assets_folder_beside_the_document() {
        let dir = tempfile::tempdir().unwrap();
        let write = store_asset(&doc(dir.path()), "Screenshot.png", PNG).unwrap();
        assert_eq!(write.relative, "assets/Screenshot.png");
        assert_eq!(write.path, dir.path().join("assets/Screenshot.png"));
        assert!(write.written);
        assert_eq!(std::fs::read(&write.path).unwrap(), PNG);
    }

    #[test]
    fn the_extension_comes_from_the_bytes_and_not_from_the_name() {
        let dir = tempfile::tempdir().unwrap();
        let write = store_asset(&doc(dir.path()), "pasted.jpg", PNG).unwrap();
        assert_eq!(write.relative, "assets/pasted.png");
    }

    #[test]
    fn the_same_bytes_under_the_same_name_are_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = store_asset(&doc(dir.path()), "a.png", PNG).unwrap();
        let second = store_asset(&doc(dir.path()), "a.png", PNG).unwrap();
        assert_eq!(first.path, second.path);
        assert!(!second.written);
        assert_eq!(
            std::fs::read_dir(dir.path().join("assets"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn different_bytes_under_a_taken_name_get_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut other = PNG.to_vec();
        other.push(b'x');
        store_asset(&doc(dir.path()), "a.png", PNG).unwrap();
        let second = store_asset(&doc(dir.path()), "a.png", &other).unwrap();
        assert_eq!(second.relative, "assets/a-1.png");
        assert!(second.written);
    }

    #[test]
    fn a_name_a_file_system_would_object_to_is_made_safe() {
        let dir = tempfile::tempdir().unwrap();
        let write = store_asset(&doc(dir.path()), "../../etc/pa:ss wd.png", PNG).unwrap();
        assert_eq!(write.relative, "assets/pa ss wd.png");
        assert_eq!(write.path.parent().unwrap(), dir.path().join("assets"));
    }

    #[test]
    fn an_empty_name_still_gets_one() {
        let dir = tempfile::tempdir().unwrap();
        let write = store_asset(&doc(dir.path()), "", PNG).unwrap();
        assert_eq!(write.relative, "assets/image.png");
    }

    #[test]
    fn bytes_that_are_not_an_image_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let error = store_asset(&doc(dir.path()), "notes.md", b"# not an image\n").unwrap_err();
        assert!(matches!(error, Error::Write { .. }));
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn every_format_the_dialect_can_show_is_recognised() {
        assert_eq!(sniff(PNG), Some("png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0"), Some("jpg"));
        assert_eq!(sniff(b"GIF89a..."), Some("gif"));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(sniff(b"BM\x00\x00"), Some("bmp"));
        assert_eq!(sniff(b"\x00\x00\x00\x18ftypavif\x00"), Some("avif"));
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Some("svg")
        );
        assert_eq!(sniff(b"MZ\x90\x00"), None);
    }

    #[test]
    fn a_document_with_no_folder_yet_has_nowhere_to_put_one() {
        let error = store_asset(Path::new("Untitled.md"), "a.png", PNG).unwrap_err();
        assert!(matches!(error, Error::Write { .. }));
    }

    #[test]
    fn copies_a_dropped_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("from finder.png");
        std::fs::write(&source, PNG).unwrap();
        let write = copy_asset(&doc(dir.path()), &source).unwrap();
        assert_eq!(write.relative, "assets/from finder.png");
    }
}
