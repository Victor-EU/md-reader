//! The manifest this crate's own binaries need on Windows, its tests
//! above all: without it they do not start.
//!
//! The dialog plugin links `TaskDialogIndirect`, which is in version 6 of
//! the Common Controls and not in the version Windows loads for a program
//! that does not ask for one. The app asks, in the manifest `tauri_build`
//! gives it in `apps/desktop/src-tauri`. A test binary built from this
//! crate had no manifest, so the import could not be resolved and Windows
//! refused to run it, before its first test, with
//! `STATUS_ENTRYPOINT_NOT_FOUND`. Tauri embeds the same manifest into its
//! own crate's tests the same way.

use std::env;
use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows = env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let msvc = env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|abi| abi == "msvc");
    let Some(dir) = env::var_os("CARGO_MANIFEST_DIR") else {
        return;
    };
    if !(windows && msvc) {
        return;
    }
    let manifest = Path::new(&dir).join("windows-test.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
