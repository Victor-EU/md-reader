//! Writes `packages/ipc/src/bindings.ts` from the command contract.

fn main() {
    let path = markdown_app::bindings_path();
    match markdown_app::export_bindings(&path) {
        Ok(()) => println!("wrote {}", path.display()),
        Err(e) => {
            eprintln!("export failed: {e}");
            std::process::exit(1);
        }
    }
}
