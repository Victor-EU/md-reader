# md-reader

Markdown viewer and editor for the AI round trip. Working title.

- [Design](docs/markdown-app-design.md)
- [Build plan](docs/markdown-app-build-plan.md)
- [Decision records](docs/adr/)

## Layout

```
apps/desktop      Tauri 2 app: src-tauri/ (thin Rust binary) and src/ (Svelte shell)
packages/markdown Lezer grammar extensions, renderer, extraction. Pure TypeScript.
packages/editor-core  CodeMirror 6 extensions: live preview, reveal rule, widgets. Framework free.
tools/bench       Keystroke latency harness (browser runner); results under tools/bench/results
tools/corpus-gen  Corpus generator script and manifest writer
corpus/           Round-trip corpus: adversarial (hand-written), generated (from models), goldens
crates/core       File IO, watcher, history, diff, search. No Tauri types.
crates/app        Tauri command handlers. Thin.
docs/             Design, plan, ADRs
```

## Prerequisites

- Node 24 and pnpm 12 (`corepack enable` or `npm i -g pnpm`)
- Rust via rustup; the pinned toolchain in `rust-toolchain.toml` installs itself
- macOS: Xcode command line tools. Windows: Visual Studio Build Tools with the
  C++ workload and WebView2 (preinstalled on Windows 11).
  Linux: see `.github/actions/setup/action.yml` for the apt packages.
- Browsers for the editor tests: `pnpm exec playwright install chromium webkit`

## Commands

```
pnpm install
pnpm dev            # Vite dev server only (no Tauri)
pnpm tauri dev      # the app, with hot reload
pnpm tauri build    # unsigned bundle under target/release/bundle
pnpm check          # Biome, tsc, svelte-check
pnpm test           # Vitest: node projects and browser projects (Chromium, WebKit)
pnpm bench          # keystroke latency on 100 KB and 1 MB documents, both browsers
pnpm corpus:gen     # generate corpus files from a model API (needs a key; see tools/corpus-gen)
cargo clippy --workspace --all-targets
cargo test --workspace
```
