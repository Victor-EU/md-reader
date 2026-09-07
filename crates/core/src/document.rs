//! Reading and writing a document from disk.
//!
//! WP 0.1 scope: read a UTF-8 file and hand its bytes back unchanged, plus a
//! debug save that writes bytes back unchanged. Encoding detection, line
//! ending metadata, atomic replacement, and the file watcher arrive in WP 1.1
//! and WP 1.7.

use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// A document as read from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    /// The file content, byte for byte as it was on disk, decoded as UTF-8.
    pub content: String,
    pub meta: DocumentMeta,
}

/// Metadata about a document on disk. Stub for WP 0.1; grows in WP 1.1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentMeta {
    pub path: PathBuf,
    /// Size on disk in bytes.
    pub byte_len: u64,
    /// Last modification time in milliseconds since the Unix epoch, when the
    /// filesystem reports one.
    pub modified_ms: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("cannot read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot write {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{path} is not valid UTF-8 (byte {at})")]
    NotUtf8 { path: PathBuf, at: usize },
}

/// Read a document. The returned `content` is exactly the bytes of the file;
/// CRLF, BOM, and trailing whitespace are preserved.
///
/// # Errors
/// Fails when the file cannot be read or is not valid UTF-8.
pub fn read_document(path: &Path) -> Result<Document, Error> {
    let bytes = std::fs::read(path).map_err(|source| Error::Read {
        path: path.to_path_buf(),
        source,
    })?;
    let modified_ms = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    let byte_len = bytes.len() as u64;
    let content = String::from_utf8(bytes).map_err(|e| Error::NotUtf8 {
        path: path.to_path_buf(),
        at: e.utf8_error().valid_up_to(),
    })?;
    Ok(Document {
        content,
        meta: DocumentMeta {
            path: path.to_path_buf(),
            byte_len,
            modified_ms,
        },
    })
}

/// Debug save for WP 0.1: write `content` to `path` byte for byte. Not
/// atomic; the real save path with atomic replacement lands in WP 1.1.
///
/// # Errors
/// Fails when the file cannot be written.
pub fn write_document_bytes(path: &Path, content: &str) -> Result<(), Error> {
    std::fs::write(path, content.as_bytes()).map_err(|source| Error::Write {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mdreader-core-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join(name)
    }

    #[test]
    fn read_preserves_bytes_exactly() {
        let path = temp_path("exact.md");
        let bytes = "\u{feff}# Title\r\n\r\nline with trailing spaces   \r\n\ttab\n";
        std::fs::write(&path, bytes).expect("write fixture");

        let doc = read_document(&path).expect("read");
        assert_eq!(doc.content, bytes);
        assert_eq!(doc.meta.byte_len, bytes.len() as u64);
        assert_eq!(doc.meta.path, path);
        assert!(doc.meta.modified_ms.is_some());
    }

    #[test]
    fn write_then_read_round_trips() {
        let path = temp_path("roundtrip.md");
        let content = "no newline at end";
        write_document_bytes(&path, content).expect("write");
        assert_eq!(read_document(&path).expect("read").content, content);
    }

    #[test]
    fn invalid_utf8_is_reported_with_offset() {
        let path = temp_path("bad.md");
        std::fs::write(&path, b"ok\xff\xfe").expect("write fixture");
        match read_document(&path) {
            Err(Error::NotUtf8 { at, .. }) => assert_eq!(at, 2),
            other => panic!("expected NotUtf8, got {other:?}"),
        }
    }

    #[test]
    fn missing_file_is_a_read_error() {
        let path = temp_path("does-not-exist.md");
        assert!(matches!(read_document(&path), Err(Error::Read { .. })));
    }
}
