//! Reading and writing a document from disk (design 6.3, plan WP 1.1).
//!
//! Reading returns the content exactly as the bytes decode, with metadata
//! about how the file was stored. Writing takes the editor's LF-normalized
//! content and restores the stored form: BOM, per-line endings, and the
//! trailing newline, then replaces the file atomically. A save is refused
//! when the file on disk no longer has the hash the caller last saw.

use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::atomic;
use crate::eol::{self, Eol};

const BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF8: &str = "utf-8";

/// A document as read from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct Document {
    /// The decoded content. For UTF-8 files this is the file's bytes minus the
    /// BOM, with line endings untouched; the editor normalizes them itself.
    pub content: String,
    pub meta: DocumentMeta,
}

/// How a file is stored, so a save can restore it. Returned on open and
/// passed back on save; the app may change fields the user asked to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct FileFormat {
    /// Dominant line ending, used for new lines.
    pub eol: Eol,
    /// True when the file mixes endings; existing lines keep theirs on save.
    pub mixed_eol: bool,
    pub bom: bool,
    /// True when the file ended with a line terminator.
    pub trailing_newline: bool,
    /// Encoding label from `encoding_rs`; only `utf-8` documents can be saved.
    pub encoding: String,
}

/// Metadata about a document on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct DocumentMeta {
    pub path: PathBuf,
    /// Size on disk in bytes.
    #[specta(type = specta_typescript::Number)]
    pub byte_len: u64,
    /// Last modification time in milliseconds since the Unix epoch, when the
    /// filesystem reports one.
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_ms: Option<u64>,
    /// BLAKE3 of the bytes on disk, hex. The token a save must present.
    pub hash: String,
    /// True for a file that is not UTF-8: it was decoded for display and
    /// cannot be saved until converted.
    pub read_only: bool,
    pub format: FileFormat,
}

/// What a successful save reports back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SaveResult {
    pub hash: String,
    #[specta(type = specta_typescript::Number)]
    pub byte_len: u64,
    #[specta(type = Option<specta_typescript::Number>)]
    pub modified_ms: Option<u64>,
}

/// Errors, serializable so the frontend can branch on `kind`.
#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Error {
    #[error("{command} is not implemented yet")]
    NotImplemented { command: String },
    #[error("cannot read {path}: {message}")]
    Read { path: PathBuf, message: String },
    #[error("cannot write {path}: {message}")]
    Write { path: PathBuf, message: String },
    #[error("{path} changed on disk (expected {expected}, found {actual})")]
    HashMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("{path} is {encoding}; convert it to UTF-8 before saving")]
    ReadOnlyEncoding { path: PathBuf, encoding: String },
    #[error("{what} is unavailable: {message}")]
    Unavailable { what: String, message: String },
}

fn read_error(path: &Path, source: &io::Error) -> Error {
    Error::Read {
        path: path.to_path_buf(),
        message: source.to_string(),
    }
}

fn write_error(path: &Path, source: &io::Error) -> Error {
    Error::Write {
        path: path.to_path_buf(),
        message: source.to_string(),
    }
}

fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok())
}

/// BLAKE3 hex digest of a file's bytes.
#[must_use]
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Decode `bytes` after any BOM: UTF-8 when valid, otherwise the encoding
/// `chardetng` guesses. Returns the text and the encoding label.
fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_owned(), UTF8);
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    // UTF-8 already failed above, so the guess must not fall back to it.
    let encoding = detector.guess(None, chardetng::Utf8Detection::Deny);
    let (text, _, _) = encoding.decode(bytes);
    (text.into_owned(), encoding.name())
}

/// Read a document.
///
/// # Errors
/// Fails when the file cannot be read.
pub fn read_document(path: &Path) -> Result<Document, Error> {
    let bytes = std::fs::read(path).map_err(|e| read_error(path, &e))?;
    let hash = hash_bytes(&bytes);
    let bom = bytes.starts_with(BOM);
    let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
    let (content, encoding) = decode(body);
    let stats = eol::scan(body);
    Ok(Document {
        content,
        meta: DocumentMeta {
            path: path.to_path_buf(),
            byte_len: bytes.len() as u64,
            modified_ms: modified_ms(path),
            hash,
            read_only: encoding != UTF8,
            format: FileFormat {
                eol: stats.dominant(),
                mixed_eol: stats.mixed(),
                bom,
                trailing_newline: eol::ends_with_eol(body),
                encoding: encoding.to_owned(),
            },
        },
    })
}

/// Build the bytes a save writes: the editor's content in the file's
/// stored form. `disk` is the current file, used to keep per-line endings.
#[must_use]
pub fn encode(content: &str, format: &FileFormat, disk: Option<&[u8]>) -> Vec<u8> {
    let normalized = eol::normalize_lf(content);
    let body = match disk {
        Some(bytes) => {
            let bytes = if bytes.starts_with(BOM) {
                &bytes[BOM.len()..]
            } else {
                bytes
            };
            let original = String::from_utf8_lossy(bytes);
            eol::restore(&original, &normalized, format.eol, format.trailing_newline)
        }
        None => eol::apply(&normalized, format.eol, format.trailing_newline),
    };
    if format.bom {
        let mut out = Vec::with_capacity(body.len() + BOM.len());
        out.extend_from_slice(BOM);
        out.extend_from_slice(&body);
        out
    } else {
        body
    }
}

/// Save `content` to `path` in the file's stored form, atomically.
///
/// With `expected_hash` set, the save is refused unless the file on disk
/// still has that hash; a missing file is treated as consent to recreate
/// it, which is what a tab whose file was deleted expects.
///
/// # Errors
/// `HashMismatch` when another writer got there first, `ReadOnlyEncoding`
/// for a document that is not UTF-8, `Write` for I/O failures.
pub fn save_document(
    path: &Path,
    content: &str,
    expected_hash: Option<&str>,
    format: &FileFormat,
) -> Result<SaveResult, Error> {
    if format.encoding != UTF8 {
        return Err(Error::ReadOnlyEncoding {
            path: path.to_path_buf(),
            encoding: format.encoding.clone(),
        });
    }
    let disk = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(read_error(path, &e)),
    };
    if let (Some(expected), Some(bytes)) = (expected_hash, disk.as_deref()) {
        let actual = hash_bytes(bytes);
        if actual != expected {
            return Err(Error::HashMismatch {
                path: path.to_path_buf(),
                expected: expected.to_owned(),
                actual,
            });
        }
    }
    let out = encode(content, format, disk.as_deref());
    atomic::replace(path, &out, atomic::Create::AsUser).map_err(|e| write_error(path, &e))?;
    Ok(SaveResult {
        hash: hash_bytes(&out),
        byte_len: out.len() as u64,
        modified_ms: modified_ms(path),
    })
}

/// Rewrite a non-UTF-8 file as UTF-8, keeping its line endings and BOM
/// choice, and return it freshly read. The one command that changes bytes
/// the user did not type, run only when asked.
///
/// # Errors
/// Fails when the file cannot be read or written.
pub fn convert_to_utf8(path: &Path) -> Result<Document, Error> {
    let doc = read_document(path)?;
    let format = FileFormat {
        encoding: UTF8.to_owned(),
        ..doc.meta.format
    };
    let out = encode(&doc.content, &format, None);
    atomic::replace(path, &out, atomic::Create::AsUser).map_err(|e| write_error(path, &e))?;
    read_document(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdreader-core-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    fn write(name: &str, bytes: &[u8]) -> PathBuf {
        let path = temp_path(name);
        std::fs::write(&path, bytes).expect("write fixture");
        path
    }

    #[test]
    fn read_reports_bom_eol_and_trailing_newline() {
        let path = write("meta.md", "\u{feff}# T\r\n\r\nx  \r\n".as_bytes());
        let doc = read_document(&path).expect("read");
        assert_eq!(doc.content, "# T\r\n\r\nx  \r\n");
        let f = &doc.meta.format;
        assert!(f.bom);
        assert_eq!(f.eol, Eol::CrLf);
        assert!(!f.mixed_eol);
        assert!(f.trailing_newline);
        assert_eq!(f.encoding, "utf-8");
        assert!(!doc.meta.read_only);
        assert_eq!(doc.meta.hash.len(), 64);
    }

    #[test]
    fn read_detects_a_legacy_encoding_as_read_only() {
        let path = write("latin1.md", b"caf\xe9 au lait\n");
        let doc = read_document(&path).expect("read");
        assert!(doc.meta.read_only);
        assert_ne!(doc.meta.format.encoding, "utf-8");
        assert!(doc.content.contains("caf"));
        assert!(matches!(
            save_document(&path, &doc.content, Some(&doc.meta.hash), &doc.meta.format),
            Err(Error::ReadOnlyEncoding { .. })
        ));
        let converted = convert_to_utf8(&path).expect("convert");
        assert!(!converted.meta.read_only);
        assert_eq!(converted.content, "café au lait\n");
    }

    #[test]
    fn save_restores_the_stored_form_from_lf_content() {
        let original = "\u{feff}one\r\ntwo\nthree\r\n";
        let path = write("form.md", original.as_bytes());
        let doc = read_document(&path).expect("read");
        let edited = "one\ntwo edited\nthree\n";
        let result =
            save_document(&path, edited, Some(&doc.meta.hash), &doc.meta.format).expect("save");
        let bytes = std::fs::read(&path).expect("read back");
        assert_eq!(bytes, "\u{feff}one\r\ntwo edited\nthree\r\n".as_bytes());
        assert_eq!(result.hash, hash_bytes(&bytes));
        assert_eq!(result.byte_len, bytes.len() as u64);
    }

    #[test]
    fn save_refuses_a_stale_hash_and_recreates_a_deleted_file() {
        let path = write("stale.md", b"a\n");
        let doc = read_document(&path).expect("read");
        std::fs::write(&path, b"b\n").expect("external write");
        match save_document(&path, "c\n", Some(&doc.meta.hash), &doc.meta.format) {
            Err(Error::HashMismatch {
                expected, actual, ..
            }) => {
                assert_eq!(expected, doc.meta.hash);
                assert_eq!(actual, hash_bytes(b"b\n"));
            }
            other => panic!("expected HashMismatch, got {other:?}"),
        }
        assert_eq!(std::fs::read(&path).expect("untouched"), b"b\n");
        std::fs::remove_file(&path).expect("delete");
        save_document(&path, "c\n", Some(&doc.meta.hash), &doc.meta.format).expect("recreate");
        assert_eq!(std::fs::read(&path).expect("recreated"), b"c\n");
    }

    #[test]
    fn errors_serialize_with_a_kind() {
        let err = Error::HashMismatch {
            path: PathBuf::from("x.md"),
            expected: "1".into(),
            actual: "2".into(),
        };
        let json = serde_json::to_string(&err).expect("json");
        assert!(json.contains("\"kind\":\"hash_mismatch\""));
    }
}

#[cfg(test)]
mod properties {
    use proptest::prelude::*;

    use super::*;

    fn eol_strategy() -> impl Strategy<Value = Eol> {
        prop_oneof![Just(Eol::Lf), Just(Eol::CrLf), Just(Eol::Cr)]
    }

    proptest! {
        /// Any file, whatever mix of endings, BOM, or trailing newline, comes
        /// back byte for byte after open and save of the unchanged buffer.
        #[test]
        fn open_then_save_is_identity(
            lines in prop::collection::vec("[a-z ]{0,8}", 0..8),
            endings in prop::collection::vec(eol_strategy(), 0..8),
            bom in any::<bool>(),
            trailing in any::<bool>(),
        ) {
            let mut bytes = Vec::new();
            if bom { bytes.extend_from_slice(BOM); }
            for (i, line) in lines.iter().enumerate() {
                bytes.extend_from_slice(line.as_bytes());
                let last = i + 1 == lines.len();
                if !last || trailing {
                    bytes.extend_from_slice(endings.get(i).copied().unwrap_or(Eol::Lf).as_bytes());
                }
            }
            let doc_content = {
                let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
                String::from_utf8(body.to_vec()).unwrap()
            };
            let stats = eol::scan(doc_content.as_bytes());
            let format = FileFormat {
                eol: stats.dominant(),
                mixed_eol: stats.mixed(),
                bom,
                trailing_newline: eol::ends_with_eol(doc_content.as_bytes()),
                encoding: UTF8.to_owned(),
            };
            let editor_view = eol::normalize_lf(&doc_content);
            prop_assert_eq!(encode(&editor_view, &format, Some(&bytes)), bytes);
        }
    }
}
