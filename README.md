# md-reader

Markdown viewer and editor for the AI round trip. Working title.

- [Design](docs/markdown-app-design.md)
- [Build plan](docs/markdown-app-build-plan.md)
- [Decision records](docs/adr/)
- [Releasing](docs/release.md)

## Layout

```
apps/desktop      Tauri 2 app: src-tauri/ (thin Rust binary) and src/ (Svelte shell)
packages/markdown Lezer grammar extensions, the read renderer, extraction. Pure TypeScript.
packages/editor-core  CodeMirror 6 extensions: live preview, reveal rule, widgets. Framework free.
packages/ipc      Generated bindings for the Rust commands, plus an in-memory fake for tests
tools/bench       Performance harness (browser runner): first paint, keystrokes, the diff scan,
                  a 200-tab session, and what a tab switch costs; results under tools/bench/results
tools/corpus-gen  Corpus generator script and manifest writer
corpus/           Round-trip corpus: adversarial (hand-written), generated (from models), goldens
crates/core       File IO, watcher, history, diff, search. No Tauri types.
crates/app        Tauri command handlers. Thin.
docs/             Design, plan, ADRs
```

## Connecting an agent

The app runs an MCP server on `127.0.0.1` while it is open: the documents
you have in front of you, what you have marked in them, what has changed
in them, and a way to write one back under a name you will see in the
history. See [design section 9](docs/markdown-app-design.md) for what it
is for and [ADR 0028](docs/adr/0028-wp-3.1-mcp-server.md) for how it
works.

The port is different on every launch and the bearer token is not, so
neither belongs in a client's configuration. `Copy Agent Client
Configuration` in the palette copies one with neither in it:

```json
{
  "mcpServers": {
    "md-reader": {
      "command": "/Applications/MD Reader.app/Contents/MacOS/mdreader-desktop",
      "args": ["--mcp-stdio"]
    }
  }
}
```

That mode reads the app's own endpoint file (`mcp.json` in the app data
directory, owner-readable only) every time it connects, so it follows the
port and picks up a rotated token by itself. `Rotate the Agent Token` in
the palette is how you stop anything that was configured by hand.

## Exporting a page

`Export as HTML…` in the palette writes the document in front of you as a
page that opens anywhere: the same renderer Read mode uses, the theme you
are reading in inlined, fences coloured, formulas set as MathML and
diagrams drawn. No stylesheet to fetch, no fonts to install, no scripts,
no network.

Images travel inside the page as `data:` URLs while they are small enough
to mail — over four megabytes of them and they are copied into a folder
beside it instead. The status bar says which happened. See
[ADR 0029](docs/adr/0029-wp-3.2-html-export.md).

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
pnpm bench          # the performance harness, both browsers, one file at a time (also a CI job)
pnpm corpus:gen     # generate corpus files from a model API (needs a key; see tools/corpus-gen)
cargo clippy --workspace --all-targets
cargo test --workspace
```

## Releasing

```
pnpm release:version 0.2.0   # the version, in all three files that carry it
pnpm release:version         # with no argument: what they say now
```

Then commit and push a `v0.2.0` tag; `.github/workflows/release.yml`
builds, signs and drafts the release. What has to exist before any of
that works — the Apple Developer Program enrollment, the repository
secrets, and where the updater's private key lives — is in
[docs/release.md](docs/release.md).

`pnpm tauri build` on this machine needs two variables set, because the
config asks for updater artifacts: `TAURI_SIGNING_PRIVATE_KEY` to the
contents of that key, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to the
empty string. Without the key the build stops before the bundle; without
the password variable it builds the bundle and then fails signing it,
because the CLI asks for a password on a terminal a script does not have
(`Device not configured (os error 6)`). To build without a key at all,
add `--config src-tauri/unsigned.conf.json`, which is what CI's nightly
bundle does.

The `.dmg` target additionally drives Finder over Apple Events to lay the
window out, so the first local `--bundles dmg` will sit waiting on a
permission prompt until Automation access is granted.
