//! Tauri command handlers. Each command is a thin adapter over
//! `mdreader_core`; nothing in here holds logic worth testing on its own.

// Command arguments arrive owned from the IPC deserializer; borrowing them
// would only add a clone on the caller side.
#![allow(clippy::needless_pass_by_value)]

use std::path::PathBuf;

use mdreader_core::Document;

/// Read a document from disk and return its content and metadata.
#[tauri::command]
fn open_document(path: PathBuf) -> Result<Document, String> {
    mdreader_core::read_document(&path).map_err(|e| e.to_string())
}

/// Debug save (WP 0.1): write the buffer back byte for byte.
#[tauri::command]
fn save_document_debug(path: PathBuf, content: String) -> Result<(), String> {
    mdreader_core::write_document_bytes(&path, &content).map_err(|e| e.to_string())
}

/// Build and run the application with the given generated context.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run(context: tauri::Context) {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_document, save_document_debug])
        .run(context)
        .expect("error while running tauri application");
}
