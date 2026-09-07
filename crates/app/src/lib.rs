//! Tauri command handlers. Each command is a thin adapter over
//! `mdreader_core`; nothing in here holds logic worth testing on its own.

// Command arguments arrive owned from the IPC deserializer; borrowing them
// would only add a clone on the caller side.
#![allow(clippy::needless_pass_by_value)]

use std::path::PathBuf;

use mdreader_core::{Document, Error, FileFormat, SaveResult};

/// Read a document from disk and return its content and metadata.
#[tauri::command]
fn open_document(path: PathBuf) -> Result<Document, Error> {
    mdreader_core::read_document(&path)
}

/// Save the buffer in the file's stored form, refusing when the file on
/// disk no longer matches `expected_hash` (design 6.4).
#[tauri::command]
fn save_document(
    path: PathBuf,
    content: String,
    expected_hash: Option<String>,
    format: FileFormat,
) -> Result<SaveResult, Error> {
    mdreader_core::save_document(&path, &content, expected_hash.as_deref(), &format)
}

/// Rewrite a non-UTF-8 file as UTF-8 and return it freshly read.
#[tauri::command]
fn convert_document_to_utf8(path: PathBuf) -> Result<Document, Error> {
    mdreader_core::convert_to_utf8(&path)
}

/// Build and run the application with the given generated context.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run(context: tauri::Context) {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            convert_document_to_utf8
        ])
        .run(context)
        .expect("error while running tauri application");
}
