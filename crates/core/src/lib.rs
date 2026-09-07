//! Core library for the markdown app: file IO, and later the watcher,
//! history, diff, and search. This crate never depends on Tauri.

pub mod document;

pub use document::{Document, DocumentMeta, Error, read_document, write_document_bytes};
