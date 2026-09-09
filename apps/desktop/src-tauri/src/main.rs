// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

fn main() -> ExitCode {
    let context = tauri::generate_context!();
    // `--mcp-stdio` is the same binary being a pipe rather than a window
    // (plan WP 3.1). It is decided before anything Tauri owns is built,
    // because this launch opens no window and must write nothing but the
    // protocol to stdout.
    //
    // The identifier is handed over rather than written out again here:
    // it is what names the app's data directory, which is where the
    // bridge looks for the port and the token.
    //
    // Unverified on Windows, where the release binary is a GUI process
    // (see the attribute above) and so has no console of its own. A
    // client that spawns it with pipes for the standard handles should
    // be unaffected, because those handles come from the parent; if
    // that turns out to be wrong the bridge needs a console binary of
    // its own. There is no machine to find out on (ADR 0028).
    let args: Vec<String> = std::env::args().collect();
    if mdreader_app::mcp::bridge::wanted(&args) {
        let code = mdreader_app::mcp::bridge::run(&context.config().identifier);
        return ExitCode::from(u8::try_from(code).unwrap_or(1));
    }
    mdreader_app::run(context);
    ExitCode::SUCCESS
}
