# Build Plan: Markdown Viewer and Editor for the AI Round Trip

Companion to `markdown-app-design.md` (design draft v1.1, 2026-09-07). Status: draft v2, 2026-09-07. v1 was reviewed the same day; the corrections are listed at the end of section 12.

This plan turns the design into an ordered set of work packages with tests, gates, and fallbacks. It does not change the design. Where it makes a choice the design left open, section 12 lists it so the design can be updated or the choice reversed.

---

## 0. How to read this plan

**Assumptions.**

- One experienced developer working full time with AI coding agents, plus occasional help for design review and manual testing. If the team is larger, the parallel tracks in sections 4 and 5 are where a second person plugs in.
- Sizes are given in focused weeks and are for ordering and gating, not commitments. The first two phases are sized honestly and will be re-estimated at each gate.
- macOS and Windows are built and tested from the first commit. Linux builds in CI and is smoke tested only.

**Structure.** Four phases, each ending in a gate with an explicit exit criterion taken from the design's scenarios. Within a phase, work is split into work packages (WP) with a stated deliverable, tests, and dependencies. A WP is done when its tests are green on both platforms and its scenario check passes by hand.

**The one rule that governs ordering.** Risk first. The design says the lossless editing core and the in-place table widget are the product and the biggest risk. Phase 0 exists only to retire that risk before a single tab or menu is built. Nothing in Phase 1 starts until the Phase 0 gate is passed or the fallback in section 3.7 is chosen.

---

## 1. Repository and toolchain

### 1.1 Layout

One repository, two workspaces (pnpm and Cargo) sharing a root.

```
/
  apps/
    desktop/               Tauri 2 app: src-tauri/ (thin Rust binary) and src/ (Svelte shell)
  packages/
    markdown/              Lezer grammar extensions, read renderer, block extraction,
                           annotation extractor. Pure TypeScript. The renderer emits a
                           node structure; DOM and HTML-string adapters consume it.
    editor-core/           CodeMirror 6 extensions: live preview, reveal rule, widgets,
                           editing commands. Framework free.
    ipc/                   Generated TypeScript bindings for Rust commands and events.
    ui/                    Svelte components shared by the shell (tabs, palette, sidebar).
  crates/
    core/                  Library: file IO, watcher, history, diff, search. No Tauri types.
    mcp/                   MCP server (Phase 3). Depends on core.
    app/                   Tauri command handlers and event plumbing. Thin.
  corpus/
    generated/             AI-generated markdown files (section 7.1)
    adversarial/           Hand-written edge cases
    goldens/               Rendered DOM snapshots per platform
  tools/
    corpus-gen/            Script that produces corpus files from model APIs
    bench/                 Performance harness and fixtures (100 KB, 1 MB, 10 MB)
  docs/                    Design, this plan, ADRs
```

The split between `packages/markdown`, `packages/editor-core`, and `apps/desktop` matters. The corpus test and most of the hard work run against `editor-core` in a headless browser with no Tauri at all. That keeps the inner loop under ten seconds and keeps the risky code testable in CI without a desktop.

### 1.2 Tool choices

| Concern | Choice | Note |
|---|---|---|
| Shell | Tauri 2, latest stable | WKWebView on macOS, WebView2 on Windows |
| Frontend | Svelte 5 with runes, TypeScript strict, Vite | No UI kit. Own components. |
| Editor | CodeMirror 6, `@codemirror/lang-markdown` over `@lezer/markdown`, `@codemirror/language-data` for lazy fence languages | Pin minor versions; upgrade deliberately |
| IPC typing | tauri-specta v2 | Generates `packages/ipc` from Rust command signatures. One schema, no drift. Pin the exact version; it has lived in release candidates for a long time. |
| Rust | stable toolchain, edition 2024, workspace lints deny warnings | |
| Diff | `similar` for line and word diffs; three-way merge written in `crates/core` on top of two diffs (diff3 algorithm) | `similar` has no merge. `diffy` has one but emits conflict markers; we need positioned hunks. |
| Watcher | `notify` plus `notify-debouncer-full` | Watch parent directory; the debouncer pairs rename events |
| Windows file replace | `windows` crate, `ReplaceFileW` | `std::fs::rename` drops the original file's ACL |
| Fuzzy matching | Small scorer in TS for recents; `nucleo` in Rust for folders | Folders can hold tens of thousands of files |
| Link opening | `tauri-plugin-opener` | External links never navigate the webview |
| History | `rusqlite` (bundled) plus `zstd` | Content addressed blobs |
| Search | `ignore`, `grep-searcher`, `grep-regex` | Same engine as ripgrep |
| MCP | `rmcp` (official Rust MCP SDK), streamable HTTP transport | Phase 3 |
| Code highlight | Shiki with its JavaScript regex engine (Read), CodeMirror language packages (Edit) | Shared theme JSON. No WASM engine, languages loaded lazily, highlighting after first paint. |
| Math | KaTeX, `trust: false` | |
| Diagrams | Mermaid, `securityLevel: 'strict'` | Rendered asynchronously |
| TS unit tests | Vitest | |
| Editor tests | Vitest browser mode on Playwright Chromium and WebKit | CodeMirror needs real layout |
| Rust tests | cargo test, `insta` for snapshots, `proptest` for merge properties | |
| Shell UI tests | Playwright against the Vite dev server with a fake IPC layer | Fast, cross platform |
| Real app smoke | tauri-driver on Windows and Linux; manual checklist on macOS | tauri-driver has no macOS support |
| Lint and format | Biome for TS, rustfmt and clippy for Rust | |
| CI | GitHub Actions matrix: macos-14, windows-2022, ubuntu-24.04 | |

### 1.3 CI from day one

`check` (lint, typecheck, clippy) and `test` (unit, editor, Rust) run on every push on all three platforms. `build` (Tauri bundle, artifacts uploaded) runs on main, on release tags, and nightly, because a cold Rust build on three runners is too slow for the pull-request loop. A fourth job `bench` runs nightly and on demand on two pinned machines, one Mac and one Windows PC, because shared runners are too noisy for the 16 ms keystroke budget and because the numbers that matter come from WKWebView and WebView2, not from Playwright's browsers. The corpus test joins the `test` job in Phase 0 and never leaves it.

---

## 2. Engineering rules that apply to every work package

1. **Definition of done.** Tests written with the WP, green on macOS and Windows in CI, the relevant scenario checked by hand, and a short note in the WP's ADR if a design detail was interpreted.
2. **Nothing writes to a markdown file except the editor transaction path and the Rust save path.** Any code that produces markdown text goes through a function in `packages/markdown` that is covered by the corpus test. This is how principle 1 is enforced in the codebase, not just in the design.
3. **Every construct the app writes has a fixture in `corpus/adversarial`** showing it next to the ugliest AI output we have seen for that construct.
4. **Performance is a test.** Any WP that touches the editor path runs the bench harness before merge and posts the numbers in the PR.
5. **No dialogs.** A PR that adds a modal must cite the design section that allows it. The only ones the design allows are the OS file pickers for opening a file or folder and for choosing a location on the first save of a new file (design 4.5 and S8). Everything else is a status bar state, a banner, or an inline widget.
6. **Platform parity in the same PR.** A feature that needs platform-specific code lands with both implementations or with the second platform explicitly stubbed and tracked.

---

## 3. Phase 0: prove the core

**Goal.** Retire the two biggest risks: that decoration-over-source live preview can feel like a document, and that a table widget with in-place cell editing works with focus and IME on both webviews. Exit criterion from the design: S3 works and the round-trip corpus test is green.

**Size.** 25 work-package days, five weeks for one person, since WP 0.4 and 0.5 are only parallel if an agent carries one of them. If it runs past 7, stop and take the fallback decision in 3.7.

**What is deliberately absent.** Tabs, menus, saving beyond a debug button, Read mode, themes, Rust beyond a file read command. A single window with one CodeMirror instance and a file picker.

### WP 0.1 Skeleton and CI (2 days)

- Create the layout in 1.1. pnpm and Cargo workspaces, Tauri app that opens one window and loads a CodeMirror instance with the stock markdown language.
- `open_document(path)` in Rust returning content and a stub meta. A debug "save" that writes bytes back unchanged.
- Fix the bundle identifier (reverse-DNS) and the repository license now. The product name can change later; the identifier is baked into file associations, the updater, and app data paths, and changing it later strands users' history and settings. The license must exist before the first corpus file is committed.
- CI `check` and `test` green on all three platforms with an empty test suite. One unsigned bundle per platform produced by hand.
- Deliverable: an unsigned nothing that runs on both machines. Signing comes with WP 1.12.

### WP 0.2 Parser extensions (4 days)

Extend `@lezer/markdown` in `packages/markdown` with:

- `Highlight` for `==text==`, delimiter based, following the Strikethrough extension as a template.
- `InlineMath` and `BlockMath` for `$...$` and `$$...$$`, using Pandoc's `tex_math_dollars` rules: the opening `$` must not be followed by whitespace, the closing `$` must not be preceded by whitespace or followed by a digit, so "$5 and $10" stays prose.
- `Callout` as a refinement of blockquote when the first line matches `[!type]`.
- `Frontmatter` as a block at document start only, delimited by `---` lines.
- Comments: verify what the stock parser produces for `<!-- -->` inline and as a block (it yields `Comment` and `CommentBlock` nodes). Add a lightweight post-pass that classifies a comment as `Annotation` when it matches the six-word vocabulary, without changing the tree.
- Footnotes are deferred to Phase 1; they do not affect the editing core.

Tests: a fixture directory of small markdown files with `insta`-style tree snapshots. Property test: parsing never throws on random byte strings up to 4 KB, including unclosed fences and unbalanced delimiters (design 5.2).

### WP 0.3 Live preview for the common blocks (5 days)

In `packages/editor-core`:

- `syntaxTreeField`: a StateField holding the tree, incremental.
- `livePreview` ViewPlugin building decorations for the visible range: marks for emphasis, strong, code, links, highlight, strikethrough; replace decorations hiding delimiters; line decorations for headings, blockquotes, callouts, fences, list indentation; bullet widget for list markers.
- `revealRanges(state)`: one pure function from selection and tree to the set of source ranges whose syntax is shown. Smallest useful unit rule from design 7.1. Unit tested exhaustively because every widget depends on it.
- Fence lines dimmed, never widgets, with language highlighting through `@codemirror/lang-markdown`'s `codeLanguages` fed from `@codemirror/language-data`, so grammars load lazily on first use. The `mermaid` fence exception from design 7.1 arrives with the Mermaid widget in WP 1.5.
- Keystroke latency measured on the 1 MB bench file with decorations on. Target: under 16 ms p95 in Chromium and WebKit.

Tests: decoration snapshots per fixture, `revealRanges` table tests, bench numbers recorded.

### WP 0.4 The table widget (8 days)

The centerpiece. Build in this order and do not skip steps.

1. **Read-only widget.** When the selection is outside the table, replace the table range with a widget rendering a real `<table>`. Clicking a cell places the CodeMirror cursor in that cell's source and, for now, reveals the whole table as source. This is the floor: it is what live-preview editors did before Obsidian 1.5 added in-place cells.
2. **Editable cells through a nested editor.** Clicking a cell mounts a small nested CodeMirror `EditorView` inside that cell whose document is the cell's source text. It carries no history extension and a minimal keymap. Its `dispatch` is intercepted: every change is rebased onto the outer document as one transaction replacing exactly that cell's `TableCell` range, tagged with the same `userEvent` so undo groups naturally, and the nested view is then updated from the outer state, never the other way round. The outer widget returns `true` from `ignoreEvent` for events inside the cell. The reason to nest an editor rather than wire up a raw `contenteditable` is that CodeMirror's DOM reconciliation, composition handling, and dictation quirks come for free, and Obsidian runs on the same engine in both webviews. If focus handling between the nested and outer views cannot be made reliable, the fallback is a `contenteditable` cell that is observed after `input` and reconciled, never intercepted at `beforeinput`, because IME insertions are not cancelable.
3. **Selection mapping.** The nested editor's selection offset plus the cell range start. Both are UTF-16 offsets into JavaScript strings, so no conversion is needed; the tests still cover cells with inline markdown, escaped pipes, and CJK, because escaped pipes make the cell's source differ from its rendered text.
4. **Navigation.** Tab, Shift+Tab, Enter, arrows move the nested editor to the next cell. Escape drops to source for the whole table. Tab in the last cell adds a row. Cmd+Z inside a cell undoes on the outer view and the cell re-syncs.
5. **Inline markdown in cells.** The cell being edited shows its source; on blur it renders. Cells not being edited render marks (bold, code, links).
6. **IME.** Verify, do not reimplement: synthesized `compositionstart`, `compositionupdate`, and `compositionend` sequences in the browser runner, then the manual checklist in 7.5 on both platforms before calling this step done. Only the fallback path needs its own composition buffering. This is the step most likely to fail, and it is why the widget exists in Phase 0.
7. **Structural commands.** Add and remove row and column, format table. These are explicit commands and produce larger diffs by design.

Tests: corpus actions for cell edits (WP 0.5), synthesized composition event sequences in the browser test runner, and the manual IME checklist signed off on macOS and Windows.

### WP 0.5 Round-trip corpus test (5 days, in parallel with 0.4)

The linchpin test from design section 10.

- **Corpus assembly** (`tools/corpus-gen`). Prompt several current models for the document types in the design's audience list: plans, reports, research notes, specs, review summaries. Vary length, ask for tables, code, math, callouts, task lists, and nested lists. Target 1000 files at Phase 0 exit, grown to 2000 over Phase 1. Store with a manifest recording model and prompt. Add 50 hand-written adversarial files: CRLF, BOM, tabs, unclosed fences, ragged tables, mixed list markers, trailing spaces, no final newline, four-space code blocks, HTML fragments.
- **Action catalog.** Each action is a pure function `(state, rng) -> { command, expectedChange }` where `expectedChange` is a ChangeSet computed independently of the editor. Phase 0 catalog: type a character in a paragraph, delete a character, toggle a checkbox, edit a table cell, press Enter in a list item, wrap a selection in bold, wrap a selection in highlight, insert a comment after a selection.
- **Invariants.**
  - **A. Exactness.** After running the command, `state.doc` equals `expectedChange.apply(before)`.
  - **B. Locality.** The parse tree outside the changed block is structurally identical before and after. This catches an edit that accidentally changes meaning elsewhere, such as an unescaped pipe.
  - **C. Identity.** Opening and saving with no edits is byte identical, including BOM, EOL, and trailing newline. In Phase 0 it runs against the frontend only and only for LF files: CodeMirror normalizes line endings when it loads a string, so CRLF and BOM identity is a property of the Rust path (WP 1.1) and is tested there. The adversarial CRLF and BOM files are in the corpus from day one so the Phase 1 run has something to catch.
- Two runners. Actions that are pure functions of `EditorState`, which is most of them, run under plain Vitest in Node in seconds, on every save. Actions that need the DOM, such as the table cell edit and the synthesized composition sequences, run in Vitest browser mode on Chromium and WebKit. Seeded RNG, failures print the file, the action, and the byte diff. Budget: under 30 seconds for the Node run and under 3 minutes for the browser run at 1000 files.

### WP 0.6 Gate review (1 day)

Sit down with the numbers.

- S3 by hand on both platforms, including one CJK cell edit each.
- Corpus test green on both browsers.
- Keystroke p95 and open-to-first-paint on the 1 MB file, both browsers.
- A 30-minute session of writing a real document in the prototype. Write down every moment the illusion broke.

Pass: everything above. Partial: the widget works in Chromium but IME fails in WebKit or WebView2, or latency is over budget. Fail: cell editing cannot be made reliable.

### 3.7 Fallbacks if the gate is not passed

- **IME unreliable in one webview.** Ship the table widget with cells that drop to source on focus for that platform only, keep in-place editing where it works, and file the fix for Phase 2. S3 still passes on the byte level; the delight is reduced on one platform.
- **In-place cell editing unreliable everywhere.** Cells drop to source on click, the widget renders when the cursor leaves. This is what Obsidian did before 1.5. Losslessness is unaffected. Reassess in Phase 2 with what was learned.
- **Live preview latency over budget at 1 MB.** Virtualize decoration building to the viewport plus a margin and defer widget rendering with `requestIdleCallback`. If still over budget, raise the Read-only threshold from 10 MB down to 2 MB and record it as a design change.
- **Decoration-over-source cannot feel like a document at all.** This is the architecture failing. The alternative is a ProseMirror editor with a lossless strategy: serialize, then compute a minimal diff against the original source and apply only that diff. It preserves untouched bytes by construction of the diff rather than of the editor. It is a rewrite of Phase 0, not of the design. Decide only with the 30-minute session notes in hand.

---

## 4. Phase 1: minimum delightful product

**Goal.** The design's Phase 1 list. Exit criterion: S1, S2, S3, S4, S8 work on macOS and Windows.

**Size.** 56 work-package days, about 11 weeks, plus two weeks of dogfood before the gate. Two tracks run in parallel: the Rust core track (WP 1.1, 1.2, 1.7, 1.8) needs no editor and can start on day one of the phase; the frontend track builds on Phase 0.

### Rust core track

### WP 1.1 File IO with metadata (4 days)

- `open_document` returns content and meta: encoding, EOL style, BOM presence, trailing newline presence, mtime, blake3 hash. Non-UTF-8 files are detected (`chardetng`) and returned with a read-only flag; conversion is a separate command.
- `save_document(path, content, expected_disk_hash)`: refuse on hash mismatch with a typed error; otherwise reapply BOM and EOL, restore trailing newline state, write to a temp file in the same directory, fsync, rename over the original, preserve permissions. On Windows `std::fs::rename` is `MoveFileExW`, which gives the target the temp file's ACL rather than the original's; use `ReplaceFileW` through the `windows` crate so attributes and ACLs survive, and retry `ERROR_SHARING_VIOLATION` with backoff, because antivirus, indexers, and cloud sync clients hold files briefly.
- Tests: identity invariant C over the corpus through the real path; property tests over EOL and BOM combinations; a Windows-only test that retries through a simulated sharing violation.

### WP 1.2 IPC schema (2 days)

- tauri-specta wired so `packages/ipc` is regenerated whenever the app starts in dev, with a CI check that fails when the committed bindings are stale. All commands from design 6.4 declared, stubbed where not yet implemented. The frontend fake IPC used by Playwright tests implements the same generated interface, so shell tests cannot drift from the real contract.

### WP 1.7 Watcher, snapshots, non-conflicting merge (8 days)

- Watcher on the parent directory of each open file, debounced 100 ms, coalescing rename-into-place. Own writes are recognized by comparing the new content hash to the hash returned by the last save and dropped. A file deleted under an open tab keeps its buffer, the status bar says the file is gone, and the next save recreates it. A rename reported by the debouncer moves the tab to the new path.
- `external_change` event carries content, hash, and the position edits from the last known disk content to the new content, computed in Rust with `similar`, so the frontend applies one transaction and cursor, scroll, folds, and undo map through.
- `merge3(base, ours, theirs)` in Rust: two diffs against base with `similar`, hunks interleaved by the diff3 algorithm, returning non-conflicting hunks as position edits plus conflict regions. `similar` has no merge of its own. Property tests: merging `theirs` into a clean buffer equals `theirs`; identical changes on both sides yield no conflicts; results are stable under EOL variation.
- Phase 1 applies the non-conflicting hunks to a dirty buffer. This is S4, whose buffer is dirty by definition, and it is more than the "clean-buffer case" the design's phasing names; section 12 records the correction. A conflicting hunk in Phase 1 keeps the buffer's version, takes an `external` snapshot of theirs so nothing is lost, and the status bar says a conflict was set aside. The widget that shows both versions is WP 2.1.
- History store: SQLite index (path, snapshot id, author, timestamp, hash) with a `schema_version` table and migrations from the first version, and zstd blobs by hash under app data. Snapshots on open, on external change, on save. Retention job at startup.
- Gutter markers: change ranges between last-reviewed snapshot and buffer, computed with line diff for now; replaced by the semantic engine in Phase 2 behind the same interface.
- "Mark reviewed" command and the Changes badge.
- Tests: watcher integration tests writing via rename, via truncate-and-write, via delete, and via rename-away from a second process; own-write suppression; snapshot round trip; the merge cases table from design section 10 for the non-conflicting rows.

### WP 1.8 Settings, session, single instance, associations (4 days)

- Settings and session as JSON in the app config directory, written throttled and atomically, since a crash mid-write must not lose the session.
- Session restore of windows and tabs, including untitled tabs whose content is stored in the session file.
- `tauri-plugin-single-instance` so a second launch forwards its file arguments to the running app. macOS open-file events via `RunEvent::Opened`. Windows file arguments via the single-instance callback. Rust keeps a registry of open paths per window, so a file that is already open focuses its tab in whichever window holds it (design 6.5) and a new one lands in the focused window.
- Pending autosaves are flushed before a window closes and before the process exits; the kill-mid-autosave check in 7.5 covers the crash case.
- File associations for `.md`, `.markdown`, `.mdx` in the bundle config on both platforms.
- Tests: session round trip; manual check of double-click open on both platforms, with the app running and not running.

### Frontend track

### WP 1.3 Document store, tabs, modes, one window (6 days)

- `Document` object per path: source, tree, disk hash, buffer hash, base snapshot, last reviewed, dirty, views. Svelte 5 runes for reactivity. A second view onto the same document in the same window forwards transactions so undo is shared.
- Command registry: every action is registered once with an id, a title, and a default shortcut per platform. The palette, the menu bar, and the keymap are derived from it, which is how principle 6 stays true as commands are added.
- Tab strip with reorder, close, reopen closed, pin, overflow scroll, dirty dot, Cmd+1..9 and cycling. It sits below a native title bar in Phase 1; moving the tabs into the title bar is WP 2.8. Tearing waits for Phase 2.
- Toolbar with breadcrumb, the mode switch, and the slot for the Changes badge. Source mode is the Phase 0 editor with the live preview compartment off and plain syntax highlighting on; Read mode arrives in WP 1.4.
- Opening files: Cmd+O native picker, drag and drop onto the window, OS open events from WP 1.8, and Cmd+T quick open over recents. The design gives no way to open an arbitrary file for the first time; Cmd+O and drop are listed in section 12.
- Command palette shell: Cmd+P file list from recents, Cmd+Shift+P commands. Fuzzy match with a small scorer.
- Status bar with word count, cursor position in Source mode, encoding and EOL, autosave state.
- Tests: Playwright against the dev server with fake IPC for every tab interaction.

### WP 1.4 Read mode renderer and click-to-edit (5 days)

- Tree-to-DOM renderer in `packages/markdown`, emitting a small node structure that either a DOM adapter or an HTML-string adapter consumes, so WP 3.2 reuses it. Every element carries `data-from` and `data-to`. Shiki for fences, KaTeX for math, Mermaid rendered asynchronously with a placeholder of the right height to avoid layout jump.
- First paint budget. A 1 MB document is tens of thousands of elements, which is more than 100 ms of DOM work. The renderer builds the first viewport synchronously and the rest in idle chunks, and Shiki highlighting runs after first paint and swaps in. The Phase 1 gate measures this path, so it lives here and not in WP 2.7.
- Links. Headings get GitHub-style ids so `[Section](#section)` scrolls; external links open in the system browser through the opener plugin and never navigate the webview.
- Click resolves the caret in the clicked text node to a source offset using the element's range plus offset, switches to Edit, and places the cursor. Verify with a test that clicks every word in a fixture and checks the cursor lands on that word.
- Heading folding and the outline panel, both driven by the same tree. The outline needs a home, so the sidebar shell (Cmd+Shift+B) ships here with the outline as its only panel; the folder tree and the recents panel come with WP 2.4.
- Rendering goldens: DOM snapshots for the golden set in Read mode, on Chromium and WebKit, reviewed by a human when they change (7.2).

### WP 1.5 The rest of the dialect (5 days)

- Footnotes extension. Callout rendering with the Obsidian and GitHub type set. Frontmatter properties widget that edits one line per property and appends before the closing `---`. Math widgets, the Mermaid fence widget (the one fence that follows the block widget rule), and the image widget in Edit mode. `.mdx` is parsed as markdown; import and export lines and JSX blocks fall to the HTML rules and show as literal text.
- Image loading through the Tauri asset protocol, with the scope extended at runtime to each opened document's directory and subdirectories; remote images blocked unless enabled per document.
- Leniency cases from design 5.2 in the adversarial corpus, each with a golden showing the "most plausible intent" rendering.
- Inline HTML whitelist enforced at render time in both the Read renderer and Edit decorations. Everything else shown as literal text.

### WP 1.6 Annotations and Copy for AI (6 days)

- Commands: highlight, color with the five-meaning palette, strikethrough, comment. Each is a pure function from state to ChangeSet, added to the corpus action catalog.
- Comment insertion rules: after the anchored inline element, or on its own line before a block. Comment widget rendering in the margin at wide widths and inline at narrow widths; hover highlights the anchor; folded in Read mode with a toggle.
- Annotation extractor: walks the tree, pairs comments with anchors by adjacency, emits records with kind, anchor text, and range. Shared later by `list_annotations` over MCP.
- Copy for AI: source plus the generated section in the design's format. Copy as markdown and copy as rich text.
- Tests: extractor fixtures; Copy for AI goldens; corpus actions for all four annotation commands.

### WP 1.9 Theme one and typography (4 days)

- One theme in light and dark following the system, with page background variants: white, cream, yellow pad, black. Bundled fonts: one sans, one serif, one mono under open licenses (proposal: Inter, Source Serif 4, JetBrains Mono; not load-bearing). Type scale, measure near 68 characters, line height 1.6, table striping, code block label and copy button, wrapping on by default.
- Shared token color theme JSON consumed by both Shiki and the CodeMirror highlighter, with a golden that renders the same code block in both modes and diffs the colors.
- Settings open as a tab, not a modal: theme, background, family, size, measure. Cmd+= and Cmd+- zoom.

### WP 1.10 Editing conveniences (5 days)

- Bold, italic, link, code shortcuts. List continuation, indent and outdent, empty item ends list. Checkbox toggle. Paste URL over selection, paste rich text as markdown, paste and drop image into `assets/` with a relative link. Find and replace with regex. Native spell check enabled.
- Every one of these is a corpus action. Smart typography stays off.

### WP 1.11 Autosave and new files (3 days)

- Autosave debounced 800 ms, also on blur, tab switch, window close. Off switch restores dirty-dot behavior.
- Cmd+N untitled tab; first save picks a location once, proposes a name from the first heading; sidebar "New file" comes with the sidebar in Phase 2, so in Phase 1 new files are created from Cmd+N and the palette only.
- Save races: on hash mismatch, run the merge path and retry, silently.

### WP 1.12 Packaging and the dogfood build (4 days)

- Prerequisites with lead time, applied for during Phase 0: Apple Developer Program enrollment for notarization, and Windows signing through Azure Trusted Signing or an OV certificate, either of which can take weeks.
- macOS: Developer ID signing and notarization in CI, universal binary. Windows: code signing in CI, x64 and arm64. Installers: `.dmg` and `.msi` (WebView2 evergreen bootstrapper).
- Updater: `tauri-plugin-updater` with a static release manifest. The design does not mention an updater; it is required to dogfood safely and is listed in section 12.
- Crash handling: none beyond the OS. No telemetry in v1 (section 12).

### Phase 1 gate

- S1, S2, S3, S4, S8 by hand on both platforms.
- Corpus test green with the full Phase 1 action catalog on Chromium and WebKit.
- Identity invariant through the real save path over the corpus.
- Open to first paint under 100 ms for 1 MB on both platforms on the bench runner.
- The developer uses the app for their own AI round trips for two weeks before the gate. Friction log reviewed.

---

## 5. Phase 2: the loop

**Goal.** Conflict merge UI, semantic diff and Review mode, history panel, folder workspace with sidebar and search, multi-window with tab tearing, tabs in the title bar, remaining themes and fonts, per-document reader overrides. Exit criterion: S5 and S6 work.

**Size.** 37 work-package days, 7 to 8 weeks.

### WP 2.1 Conflict widget (4 days)

- Conflict regions from `merge3` (WP 1.7) become editor state rendered by a widget showing both versions with "keep mine" and "take theirs". The document stays editable around it. Save is held while any conflict region exists and the status bar says so. Conflict regions are never bytes on disk.
- Merge cases table from design section 10 as fixtures, now including the conflicting rows: adjacent edits, whitespace-only external changes, full rewrites, deletion of the region being edited.

### WP 2.2 Semantic diff engine (7 days)

- Block extraction in TypeScript from the tree: paragraphs, headings, list items, table rows, code blocks, math blocks, each with normalized text, hash, and range. Sent to Rust as a list.
- Alignment in Rust: LCS on hashes, then pairing of unmatched blocks by similarity (normalized Levenshtein on text with a threshold, tuned against the semantic diff cases), then word diff within pairs, then move detection for identical hashes deleted and inserted elsewhere.
- Output: change records with ranges on both sides. Gutter markers switch to this engine behind the interface from WP 1.7.
- Cases: rewrapped paragraphs, moved sections, single-cell table edits, list reorderings. Benchmark: 1 MB external change under 200 ms end to end.

### WP 2.3 Review mode and history panel (5 days)

- Review mode walks change records with inline old and new text, per-change revert, keyboard stepping. History panel lists snapshots, diffs any two, restores one as a new user snapshot.

### WP 2.4 Workspace (6 days)

- Folder open, sidebar tree respecting `.gitignore`, file watching for the tree, "New file" with inline rename, recents when no folder is open.
- Cmd+P fuzzy over the folder, matched in Rust with `nucleo` over the `ignore` walk so a folder of fifty thousand files stays instant. Cmd+Shift+F content search through `grep-searcher` streaming results over an event channel, results panel with click to open at line.
- S6 by hand with a twelve-file folder.

### WP 2.5 Multi-window and tab tearing (5 days)

- Second window creation, moving a tab between windows, drag out to tear. Each window is its own webview, so the document store lives per window and Rust holds the registry of which window has which path (WP 1.8). A torn tab closes the document in the source window and reopens it in the target with view state and serialized undo history carried across through Rust. A second view of one document across two windows is out of scope; second views work within a window (WP 1.3).
- Files opened from the OS follow the WP 1.8 rule: the window that already holds the path, else the focused window.

### WP 2.6 Themes, fonts, overrides (3 days)

- Remaining three themes, remaining bundled families, per-document overrides keyed by path in app data, the settings UI for them.

### WP 2.7 Large files (3 days)

- Above 10 MB Read mode only with a banner; above 100 MB refuse. Full virtualization of Read rendering on top of the chunked renderer from WP 1.4. Measure the 10 MB bench file.

### WP 2.8 Tabs in the title bar (4 days)

- The Chrome look. macOS: overlay title bar with the traffic lights inset beside the tabs. Windows: no native decorations, custom caption buttons, drag regions, and the Windows 11 snap layout flyout on the maximize button, which needs the native hit test. Double-click to maximize, mixed-DPI moves, and full screen verified on both.

### Phase 2 gate

S5 and S6 by hand on both platforms. Merge property tests and semantic diff cases green. Bench numbers within budget. Beta build to a handful of outside users.

---

## 6. Phase 3: the agent side

**Goal.** MCP server, agent attribution, HTML export, performance hardening. Exit criterion: S7 works.

**Size.** 14 work-package days, about 3 weeks.

### WP 3.1 MCP server (7 days)

- `rmcp` server over streamable HTTP on `127.0.0.1`, random port, bearer token. The token is generated once and kept, with a palette command to rotate it, because a token that changes on every launch breaks every configured client. Port and token are written to a well-known file in app data with owner-only permissions.
- Most MCP clients are configured with a stdio command, so the app binary gets a `--mcp-stdio` mode: a thin bridge that reads the well-known file and proxies stdio to the HTTP server. A palette command copies a ready-to-paste client configuration for it.
- Tools from design section 9: `list_documents`, `read_document`, `list_annotations`, `changes_since`, `write_document`. Resources `doc://<path>` for open documents.
- `write_document` goes through the external-change path with the agent name as author. Gutter markers appear immediately. Status bar shows the connection.
- Tests: an in-process MCP client exercising every tool against a running core; an end-to-end test where a scripted agent reads annotations, writes a new version, and the frontend shows attribution.

### WP 3.2 HTML export (2 days)

Same renderer as Read mode, inlined CSS from the current theme, images embedded or copied alongside. No PDF.

### WP 3.3 Performance hardening (5 days)

Profile on the 10 MB file and on a 200-tab session. Fix what the profiler shows. Tighten CI thresholds to the measured numbers minus margin so regressions fail the build.

### Phase 3 gate

S7 by hand with a real agent client. All eight scenarios re-run on both platforms. v1 release candidate.

---

## 7. Test infrastructure in detail

### 7.1 Corpus

- Generated files are produced by `tools/corpus-gen` and committed, so the test is deterministic. The manifest records model, prompt category, and date. Regenerate quarterly and keep the old set; never delete a file that once failed.
- Every bug found in the wild adds its reduced file to `corpus/adversarial` with a comment naming the bug.
- Licensing: generated text is committed under the repository license; the generation prompts avoid quoting external sources.

### 7.2 Rendering goldens

DOM snapshots serialized with stable attribute order, one per file per mode per engine (Chromium and WebKit), for a golden set: every adversarial file plus a fixed sample of 100 generated files. The full corpus renders in the same job without snapshots and asserts only that nothing throws and that no whitelisted construct fell through as literal text; two thousand files times two modes times two engines would turn every CSS change into an eight-thousand-file diff. A change to a golden requires a human to approve the visual diff in the PR, with a screenshot generated by the test runner.

### 7.3 Merge and diff cases

Plain text fixtures: `base.md`, `ours.md`, `theirs.md`, `expected.json`. Property tests in Rust cover the algebraic cases; fixtures cover the user-visible ones.

### 7.4 Performance harness

- Fixtures: 100 KB, 1 MB, 10 MB synthetic documents with a realistic mix of blocks, plus the largest real corpus file.
- Measurements: open to first paint, keystroke to paint p95 over 200 keystrokes at three positions, external change apply time, mode switch time.
- The harness runs in two places: in Vitest browser mode for the inner loop, and inside the real app through a `--bench` flag that loads the fixtures, drives the editor, and writes JSON, because the budgets are promises about WKWebView and WebView2, not about Playwright's browsers.
- Bench runners are two pinned machines, one Mac and one Windows PC. Shared runners run the harness but only fail on a 50 percent regression, to catch disasters without flakiness.

### 7.5 Manual protocol

Run before each gate and each release, on macOS and Windows, results kept in `docs/manual-runs/`.

- The eight scenarios, in order, with a friction note per step.
- IME checklist: Simplified Chinese pinyin and Japanese on both platforms, in a paragraph, in a table cell, in a comment, in the palette input. Compose, cancel composition, commit, delete after commit. Check the byte diff after each.
- Open a file with the app closed, with the app open, with the file already open in a tab.
- Kill the app mid-autosave; reopen; confirm no truncated file and session restored.
- External writer scripts: a shell loop that rewrites the file every two seconds while typing.

---

## 8. Platform work

### macOS

- Signing, notarization, `.dmg`. Open-file Apple events. Menu bar with the standard items and the app's commands. Trackpad horizontal scroll in the tab strip. WKWebView specifics: `contenteditable` composition events, asset protocol scoping, native spell check availability.

### Windows

- Code signing, `.msi`, WebView2 evergreen bootstrapper. File association registration and "open with". Single instance forwarding of file arguments. Sharing-violation retry on rename. High-DPI and mixed-DPI window moves. Keyboard: Ctrl for every Cmd, Alt for Option, and the WebView2 behavior of Ctrl+Shift+[ and ] verified. Browser accelerator keys disabled on the webview (`browserAcceleratorKeys: false`), otherwise Ctrl+P prints, Ctrl+F opens the WebView2 find bar, and F5 reloads the app. OneDrive placeholders and sync writes exercised by the watcher tests.

### Linux

- Builds in CI as AppImage and `.deb`. Smoke test through tauri-driver. Not polished, not blocking gates.

---

## 9. Release engineering

- Versions: `0.x` through Phase 2, `1.0` at Phase 3 gate. Tag driven release workflow producing signed installers for all platforms and the updater manifest.
- Channels: `dev` (every merge to main, updater on), `beta` (Phase 2 gate onward), `stable` (1.0).
- Release checklist: manual protocol run, corpus and goldens green, bench within budget, changelog written from the merged PR titles.

---

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation | Owner phase |
|---|---|---|---|---|
| Table cell IME on WebView2 or WKWebView | High | High | Nested editor in WP 0.4 step 2, verification in step 6, fallback 3.7 | 0 |
| Nested cell editor and outer view fight over focus | Medium | High | Fallback to an observed `contenteditable` in WP 0.4 step 2 | 0 |
| Live preview latency at 1 MB | Medium | High | Bench from WP 0.3; viewport virtualization | 0 |
| Decoration flicker on reveal and re-hide | Medium | Medium | Batch decoration updates in one transaction; measure paint count | 0 |
| Own-write detection misses and the app merges its own save | Medium | High | Hash compare plus a short suppression window after save; integration test | 1 |
| Antivirus holds files on Windows during rename | High | Medium | Retry with backoff; test with Defender enabled on the CI runner | 1 |
| Read mode first paint over 100 ms at 1 MB | High | Medium | Chunked rendering and deferred highlighting in WP 1.4 | 1 |
| Signing credentials arrive late | Medium | Medium | Apply during Phase 0 (WP 1.12) | 1 |
| Click-to-edit lands off by one in mixed-script text | Medium | Medium | Test that clicks every word of every corpus file | 1 |
| Margin comments jump on reflow | Medium | Low | Fall back to inline bubbles, per design open questions | 1 |
| Semantic diff pairs the wrong paragraphs | Medium | Medium | Similarity threshold tuned on the cases; show as delete plus insert when unsure | 2 |
| Tab tearing loses undo history | Low | Medium | Carry view state and history through Rust; test | 2 |
| MCP token file readable by other users | Low | High | Owner-only permissions; rotate on command | 3 |
| Corpus grows stale as models change | Certain | Low | Quarterly regeneration, never delete | all |

---

## 11. Schedule summary

| Phase | Content | WP days | Calendar | Gate |
|---|---|---|---|---|
| 0 | Editing core, table widget, corpus test | 25 | 5 weeks, stop at 7 | S3, corpus green, latency in budget |
| 1 | Tabs, modes, annotations, watcher, merge, autosave, theme, packaging | 56 | 11 weeks plus 2 of dogfood | S1, S2, S3, S4, S8 |
| 2 | Conflicts, semantic diff, history, workspace, windows, title bar, themes | 37 | 7 to 8 weeks, then beta | S5, S6 |
| 3 | MCP, export, performance | 14 | 3 weeks | S7; 1.0 |

The work packages sum to 132 days, about 26 weeks. Add the dogfood period, a beta period, and a 20 percent buffer, and the honest number is eight calendar months for one focused developer with agents, with the caveat that Phase 0 can move everything. Draft v1 said five to six months; that figure had no dogfood period and no buffer, and it did not match its own work package sums.

---

## 12. Decisions this plan makes beyond the design

Each of these should either be folded into the design or reversed here.

| Decision | Reason |
|---|---|
| tauri-specta for IPC typing | Fulfills "generated from one schema" with a maintained tool |
| rmcp as the MCP implementation | Official SDK, streamable HTTP supported |
| Vitest browser mode on Chromium and WebKit for the editor and corpus tests | Real layout without a desktop; WebKit approximates WKWebView |
| An updater from the first dogfood build | Not in the design; needed to ship fixes to testers safely |
| No telemetry and no crash reporting in v1 | Consistent with no accounts and a quiet app; revisit at beta |
| Comment classification as a post-pass, not a grammar change | Keeps the parser stock-compatible and the vocabulary easy to extend |
| Gutter markers use line diff in Phase 1 and switch to semantic diff in Phase 2 | Lets S4 ship early behind a stable interface |
| Proposed bundled fonts: Inter, Source Serif 4, JetBrains Mono | Open licenses, wide script coverage; easy to swap |
| Sidebar "New file" ships with the sidebar in Phase 2; Cmd+N covers S8 in Phase 1 | S8 does not need the tree |
| Linux is built and smoke tested but never gates | Matches the platform decision in the design |
| Cmd+O and drag-and-drop to open files | The design has no first-time way to open an arbitrary file; Cmd+T covers recents only |
| Non-conflicting three-way merge in Phase 1, conflict widget in Phase 2 | S4 has a dirty buffer, so the design's "clean-buffer case" for Phase 1 is not enough; design section 13 should say "non-conflicting merge" |
| Nested CodeMirror view per table cell instead of raw `contenteditable` | Inherits proven composition and DOM handling; the design's description of cells still holds |
| Native title bar in Phase 1, tabs in the title bar in Phase 2 (WP 2.8) | Custom decorations on Windows are a work package of their own |
| Second views of one document only within a window | One webview per window means the store cannot be shared across windows; design 6.5 should say so |
| External links open in the system browser | Navigating the webview is a security and usability hole the design does not mention |
| MCP token is stable and rotated on command; the binary has a stdio bridge mode | Per-launch rotation breaks configured clients; most clients speak stdio |
| Goldens for adversarial files plus a 100-file sample, not the whole corpus | Repository churn |
| Bundle identifier and license chosen in WP 0.1 | Both are hard to change once file associations, the updater, and the corpus exist |
| Stepping through changes is `Cmd+Alt+G` and `Cmd+Alt+Shift+G`, and wraps | S4 says "presses a key" without saying which; these are the siblings of Find Next and Find Previous, over a different list |

**Corrections from the review of draft v1.** `similar` was credited with a three-way merge it does not have. The Phase 1 gate required S4 while the phase only merged clean buffers. The schedule headline did not match the work package sums. Read mode had no path to the 100 ms budget at 1 MB before Phase 2. The table cell design intercepted `beforeinput`, which IME does not honor. The Windows rename note named the wrong API. The plan promised a signed build in WP 0.1 and a single bench runner for two webviews. Obsidian was described as lacking in-place cells, which stopped being true at 1.5.

---

## 13. The first two weeks

Concrete enough to start tomorrow.

**Week 1**

1. Repository, bundle identifier, license, workspaces, CI `check` and `test` on three platforms, Tauri window with a CodeMirror instance, `open_document` stub. (WP 0.1)
2. `Highlight`, `InlineMath`, `BlockMath` extensions with tree snapshots. (WP 0.2)
3. `Callout`, `Frontmatter`, comment classification pass. Property test that parsing never throws. (WP 0.2)
4. `syntaxTreeField`, marks and replace decorations for inline syntax, `revealRanges` with its table tests. (WP 0.3)
5. Line decorations, list bullets, fence dimming. First keystroke latency numbers on the 1 MB file. (WP 0.3)

**Week 2**

6. Corpus generator running; first 300 files committed with manifest; adversarial set started. (WP 0.5)
7. Action catalog and invariants A and B; corpus test running on Chromium with the paragraph and checkbox actions. (WP 0.5)
8. Table widget step 1, read-only with click to source. (WP 0.4)
9. Table widget step 2, nested cell editor with rebased dispatch; cell edit action added to the corpus. (WP 0.4)
10. Table widget step 3, selection mapping with the CJK and escaped-pipe tests. First manual IME pass on macOS. (WP 0.4)

By the end of week 2 the question "does this architecture work" has a preliminary answer, and the remaining Phase 0 time goes to IME, navigation, WebKit, and the gate.
