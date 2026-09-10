# Markdown Viewer and Editor for the AI Round Trip

Design document. Name: Markdown (decided 2026-09-10). Status: draft v1.1, 2026-09-07 (three edits from the build plan review: Cmd+O and drop to open, second views per window, non-conflicting merge in Phase 1).

---

## 1. The job

An AI produces a markdown file. A human opens it, reads it, marks it up, edits it, and hands it back to the AI. The AI produces the next version. Repeat.

Markdown is the exchange format because both sides read it natively. The app exists to make the human side of this loop pleasant, and to make sure nothing the human does damages the AI side.

Everything below follows from that job. Features that do not serve the round trip are deliberately out of scope for v1, however nice they might be in a general-purpose editor.

### Who it is for

- People who work with AI agents daily: plans, reports, research notes, specs, code review summaries.
- Technical enough to know what markdown is, not necessarily interested in its syntax.
- They already have Obsidian, Typora, or VS Code available and would still choose this because it does the round trip better.

### What delight means here

- The file opens instantly and looks like a finished document, not like source code.
- Editing feels like editing a document, and the source underneath comes out exactly as the human intended, byte for byte, with nothing else touched.
- When the AI rewrites the file mid-session, nothing interrupts the human. The change appears, the cursor stays, and the parts that changed are visible.
- When the human hands the file back, their highlights and notes reach the AI as words, not as lost formatting.
- No dialogs. No "file changed on disk, reload?". No "unsaved changes?" surprises. The app is quiet.

---

## 2. Principles

1. **The file is the truth. Bytes the human did not touch never change.**
   There is no serializer. Every edit is a patch against the source text. Reformatting only happens when the user explicitly asks for it (for example "format table").

2. **Anything written to the file must be readable by any markdown tool and any model.**
   No sidecar files. No private syntax. The test: paste the file into GitHub, into a chat window, and into a plain text editor. It must degrade gracefully in all three.

3. **The visuals are for humans. The data is for the AI.**
   Anything that only changes how a document looks to a reader, such as font, size, theme, page background, and measure, lives in the app and never in the file. Anything that carries meaning to the next reader, human or model, such as highlights, colors, strikethroughs, and comments, lives in the file as portable markdown. The test for any new feature is which side of this line it falls on.

4. **Change is a first-class object.**
   The app always knows what the AI changed since the human last looked, and what the human changed since the AI last wrote. This is not a feature bolted on later. It shapes storage, the file watcher, and the editor.

5. **We can afford the hard things.**
   Where a shortcut would compromise 1 through 4, take the hard path. The lossless editing core, live merge of external writes, and semantic diff are all hard. They are also the product.

6. **Keyboard first, mouse complete.**
   Every action reachable from the command palette with a shortcut. Every action also reachable by clicking something obvious.

---

## 3. Scenarios

These are the concrete flows the design must make excellent. They double as acceptance tests.

**S1. Read a plan.** An agent writes `plan.md` with headings, a table of tasks, a Mermaid diagram, and a few code blocks. The human double-clicks it. It opens in under 100 ms in a new tab, fully rendered, with good typography. They scroll, fold sections, and click a heading in the outline to jump.

**S2. Mark up and hand back.** Reading the plan, the human highlights a paragraph and attaches the note "too ambitious, cut to two weeks". They strike a bullet and color one sentence red. They press "Copy for AI" and paste into a chat. The pasted text is the full markdown plus a short annotations section. The AI understands all of it.

**S3. Edit a table in place.** The human clicks a cell in the rendered task table, changes "Owner: Sam" to "Owner: Lee", presses Tab to the next cell, changes a date. On disk, exactly those two cell contents changed. Pipe alignment, spacing, and every other line are byte-identical.

**S4. The agent rewrites the file while it is open.** The human has an unsaved edit in section 3. The agent rewrites sections 1 and 5. The buffer updates in place, the cursor and the unsaved edit are untouched, and sections 1 and 5 get a change marker in the gutter. The human presses a key to step through the changes, then "mark reviewed".

**S5. Conflict.** Same as S4, but the agent also rewrote the paragraph the human is editing. That paragraph shows both versions inline with "keep mine" and "take theirs". Nothing else is blocked.

**S6. Work across a folder.** The agent produced a `research/` folder with twelve files. The human opens the folder. The sidebar shows the tree, Cmd+P opens any file by fuzzy name, Cmd+Shift+F searches contents, and each file opens in its own tab.

**S7. Agent reads the human's markup directly.** With the app running, an agent connected over MCP asks for the open document and its annotations, and receives the markdown plus a structured list of highlights and comments with their anchor text. It writes a new version through the same channel, and the app shows it as "changed by <agent name>".

**S8. Write a brief for the AI.** The human presses Cmd+N, types a heading and three bullets describing what they want, and saves. The file lands in the current folder, named from the heading, and the agent picks it up. No template, no dialog beyond choosing a location the first time.

---

## 4. Product surface

### 4.1 Shell

Modeled on a browser window.

- **Tab strip** at the top. Each tab is one document view. Tabs show the file name, a dirty dot, and a pin state. Drag to reorder. Drag out of the window to tear into a new window. Middle-click closes. Overflow scrolls horizontally with the active tab kept visible.
- **Shortcuts:** written as Cmd here; Ctrl on Windows and Linux throughout. Cmd+T new tab (opens quick open), Cmd+W close, Cmd+Shift+T reopen closed, Cmd+1..9 jump, Cmd+Shift+[ and ] cycle, Cmd+N new untitled document, Cmd+O open a file from disk, Cmd+Shift+N new window. Files can also be dropped onto the window.
- **Toolbar** under the tabs, kept minimal: a breadcrumb path, the mode switch (Read, Edit, Source), the annotation tools, and a "Changes" badge that appears when there are unreviewed external changes.
- **Command palette:** Cmd+P for files, Cmd+Shift+P for commands. This replaces the address bar.
- **Sidebar** (toggle Cmd+Shift+B): folder tree when a folder is open, recent files otherwise. A second panel shows the outline of the current document. Cmd+Shift+F searches the open folder.
- **Status bar:** word count, cursor position in source mode, encoding and line ending, autosave state, and the MCP connection indicator when an agent is attached.
- **Session restore:** on launch, reopen the windows and tabs from last time, like Chrome's "continue where you left off".

### 4.2 Three modes, one document

| Mode | What it is | When it is used |
|---|---|---|
| Read | Rendered HTML with the best typography we can produce. Not editable. Click anywhere to switch to Edit at that exact position. | Default when opening a file. Most sessions start and end here. |
| Edit | Live preview. The document looks rendered, but the block under the cursor reveals its source. Everything is editable in place. | Any change. |
| Source | Plain text with syntax highlighting. Same buffer, decorations off. | "Show me what the AI sees." Debugging odd syntax. |

Switching modes is instant because all three views are projections of the same source string. There is no conversion step and therefore nothing to lose.

Read mode is not a separate parser. It renders the same parse tree as Edit mode, so the two never disagree about what a document looks like. Each rendered element carries its source range, which is what makes click-to-edit land on the right character.

### 4.3 Annotations

These are the features the user asked for, mapped to what the file stores.

| Feature | Stored as | Rendered as | Notes |
|---|---|---|---|
| Highlight | `==text==` | `<mark>` | Widely supported. Unambiguous to models. |
| Text color | `<span style="color:#hex">text</span>` | Colored text | Only `color`. Background highlighting is `==text==`, page background is a reader setting. |
| Comment | `<!-- kind: text -->` immediately after the anchored span, or on its own line before a block. `kind` is one of `note`, `attention`, `question`, `remove`, `keep`, `rewrite`. | A margin note, or an inline bubble at narrow widths, attached to the span or block. Hidden text in the file. | The main channel for talking to the AI. Words, not colors. |
| Strikethrough | `~~text~~` | `<s>` | GFM. Already understood as "remove this". |
| Font and size | Never written to the file | Applied by the reader's settings | See "Fonts are for the reader" below. |

**Fonts are for the reader.** Font family, size, measure, and theme are app settings. A user can also override them per document, and the override is stored in the app's own data keyed by file path, never in the file. The document looks the way that reader wants on that machine, and the file stays exactly as the AI wrote it. Two readers of the same file may see different fonts. That is the intended outcome, not a limitation. The one thing this rules out is a document that carries its own look to another tool, and for the round-trip job that is the right trade.

**Why color stays in the file but font does not.** Both are visual. The difference is intent. A reader picks a font for comfort, and nothing about the document's meaning changes. A reader colors a sentence red to say something about that sentence. Color is on the data side of the line only because we give it a meaning through the palette below. A color without a comment is weak data, which is why the palette pre-fills one.

**The comment vocabulary.** Every comment starts with one of six fixed words followed by a colon: `note` for a plain remark, and `attention`, `question`, `remove`, `keep`, `rewrite` for the palette meanings. There is no author field. The app is a single reader talking to a model, not a collaboration tool, so a name would be noise. A closed vocabulary is what makes the comments machine-readable: a model, or a regular expression, can find every `<!-- question: ... -->` in a file without guessing.

**The palette with meanings.** The color picker offers a small set of named colors: Attention, Question, Remove, Keep, Rewrite. Picking one applies the color and pre-fills a comment with the matching kind. The user can edit or delete the comment text. The point is that a color alone is invisible to a model, while `<!-- rewrite: too long -->` is an instruction it will act on.

**Comment anchoring.** A comment placed directly after an inline element is anchored to it. A comment on its own line is anchored to the following block. In the editor, comments render in the margin at wide widths and as inline bubbles at narrow widths. Hovering a comment highlights its anchor. Comments are folded away in Read mode by default with a toggle to show them.

**Copy for AI** produces:

```
<full markdown source>

---
Annotations (3):
1. Highlight, "The migration can be done in one sprint" — note: too ambitious, cut to two weeks
2. Removed (strikethrough), "Rewrite the auth service"
3. Question, "Do we still need the legacy exporter?" — question: is this still used
```

The annotations section is generated, never stored. If there are no annotations it is omitted.

### 4.4 Changes and history

Every document has a local history. Snapshots are taken:

- when the file is opened,
- every time an external write is detected,
- every time the app saves.

Each snapshot records content, timestamp, and author: `user`, `external`, or a named agent when the write came over MCP.

Per document, the app tracks a **last reviewed** snapshot. The gutter shows change markers for everything that differs between last reviewed and the current buffer. "Mark reviewed" advances the pointer. This is the mechanism behind "what did the AI change since I looked".

**Review mode** (Cmd+Shift+R) walks through changes one at a time with inline old and new text, like a track-changes view. Each change can be reverted individually.

**History panel** lists snapshots and lets the user diff any two or restore one. Restore is itself a user snapshot, so nothing is ever lost.

The diff is semantic, not line based. See section 7.

### 4.5 Editing conveniences

None of these are novel, and all of them are expected. Missing any one of them breaks the "feels like a document" illusion.

- Cmd+B, Cmd+I, Cmd+K, Cmd+E for bold, italic, link, code. Applying a mark to a selection wraps it; applying to a word wraps the word.
- Enter continues lists and task lists. Tab and Shift+Tab indent and outdent list items. Enter on an empty item ends the list.
- Clicking a checkbox toggles `[ ]` and `[x]`. This is a one-byte change at a known position.
- Paste a URL over a selection to make a link. Paste rich text converts to markdown. Paste an image writes it to an `assets/` folder next to the document and inserts a relative link. Drag and drop the same.
- Tables: Tab and Shift+Tab move between cells. Enter moves down. Commands to add and remove rows and columns. "Format table" aligns the pipes on request.
- Find and replace with regex. Native spell check from the webview.
- Heading folding. Outline navigation. Cmd+= and Cmd+- zoom.
- Smart typography is off by default. AI output already contains the characters it means.
- **New files.** Cmd+N opens an untitled tab that is immediately editable. The first save asks for a location once, defaulting to the open folder or the folder of the active document, with a file name proposed from the first heading. After that autosave applies as usual. In the sidebar, "New file" creates `Untitled.md` in the selected folder and starts a rename. Untitled tabs survive session restore so nothing typed is lost.

---

## 5. The markdown dialect

### 5.1 What we render

CommonMark plus GitHub Flavored Markdown, plus the extensions AI output actually uses:

- GFM tables, task lists, strikethrough, autolinks, footnotes.
- `==highlight==`.
- Math: `$inline$` and `$$block$$`, rendered with KaTeX.
- Mermaid in fenced code blocks with language `mermaid`.
- Callouts: `> [!note]`, `> [!warning]`, and the rest of the Obsidian and GitHub set.
- YAML frontmatter, shown as a properties panel, stored as text.
- Internal links to headings: `[Section](#section)`.
- A whitelist of inline HTML (5.3).

Not supported in v1: wiki links, embeds, custom containers, emoji shortcodes, definition lists. They can be added as parser extensions later without touching the editing core.

### 5.2 Leniency

AI output is imperfect. Unclosed code fences, mixed tab and space indentation, tables with ragged columns, headings without a blank line before them, stray HTML fragments. The parser must never fail and must render the most plausible intent. Where CommonMark already defines the fallback we follow it. Where it does not, we prefer rendering something readable over showing raw text, but we never rewrite the source to "fix" it.

### 5.3 Inline HTML whitelist

Allowed and rendered: `span` (with `style` limited to `color`), `mark`, `sub`, `sup`, `u`, `s`, `br`, `kbd`, `details`, `summary`, `img` with a local relative `src`, and comments.

Everything else, including `script`, `iframe`, `style`, and event handlers, is shown as literal text. Images with a remote `src` follow the rule in section 8: blocked by default, enabled per document. Nothing is removed from the file. The whitelist is a rendering decision, not a sanitization on save.

### 5.4 What we write

The app only ever writes the constructs above. It never emits anything not in this document.

---

## 6. Architecture

### 6.1 Overview

```
┌──────────────────────────────────────────────────────┐
│ Tauri 2 shell                                        │
│                                                      │
│  ┌────────────────────────┐   ┌────────────────────┐ │
│  │ Webview (Svelte 5, TS) │   │ Rust core          │ │
│  │                        │   │                    │ │
│  │  Tab and window UI     │◄─►│  File IO, encoding │ │
│  │  CodeMirror 6 editor   │   │  Watcher + merge   │ │
│  │  Lezer markdown parse  │   │  History store     │ │
│  │  Read-mode renderer    │   │  Workspace search  │ │
│  │  Diff presentation     │   │  Diff engine       │ │
│  │                        │   │  MCP server        │ │
│  └────────────────────────┘   └────────────────────┘ │
│              invoke + events (typed)                 │
└──────────────────────────────────────────────────────┘
```

One Rust process, one webview per window. The webview is WKWebView on macOS and WebView2 on Windows, so every rendering golden runs on both. Document state that must survive a window closing, and anything that touches disk, lives in Rust. Everything about how a document looks and is edited lives in the webview.

### 6.2 Frontend stack

- **Svelte 5 with TypeScript**, Vite. Chosen over React for a smaller runtime and simpler reactivity. The editor itself is framework-independent, so this choice is not load-bearing.
- **CodeMirror 6** for the editing surface. This is the central decision and is justified in section 7.
- **@lezer/markdown** as the one parser for all three modes. It is incremental, produces a tree with exact source ranges, and is what CodeMirror uses natively. We extend it for highlight, math, callouts, footnotes, frontmatter, and comments.
- **Read-mode renderer:** our own tree-to-DOM renderer over the Lezer tree, so Read and Edit share one parse. Each element carries `data-from` and `data-to` for click-to-edit.
- **Shiki** for code highlighting in Read mode. CodeMirror language packages for Edit mode, with a shared token color theme so blocks look the same in both.
- **KaTeX** for math, `trust: false`. **Mermaid** with `securityLevel: 'strict'`, rendered asynchronously into a widget so a slow diagram never blocks typing.

### 6.3 Rust core

- **File IO:** read with encoding detection (UTF-8 fast path, otherwise detect and open read-only with a banner). Record BOM, line ending style, and trailing newline presence at load and restore them on write. Atomic write via temp file and rename, preserving permissions.
- **Watcher:** `notify` crate on the parent directory of each open file, since many tools write via rename. Debounced. Own writes are recognized by content hash and ignored.
- **Diff engine:** line and word diffs via the `similar` crate. Three-way merge for external writes. Block-level semantic diff takes the block list from the frontend and does the sequence alignment.
- **History store:** SQLite via `rusqlite` for the index, content-addressed blobs compressed with zstd on disk under the app data directory. Retention: unlimited for 30 days, then thin to daily, configurable.
- **Workspace:** directory listing that respects `.gitignore`, content search with the `grep-searcher` and `ignore` crates.
- **Settings and session:** JSON files in the app config directory. Window and tab layout saved on every change, throttled.
- **MCP server:** phase 3, section 9.

### 6.4 IPC contract

Typed commands generated from one schema so the two sides cannot drift. Key commands:

- `open_document(path) -> { content, meta }` where meta carries encoding, eol, bom, trailing newline, mtime, hash.
- `save_document(path, content, expected_disk_hash) -> { hash, mtime }`. If the disk hash does not match, the save is refused and the frontend runs the merge path first. This prevents a save from clobbering an agent write that arrived a moment earlier.
- `watch(path)` / `unwatch(path)`.
- Event `external_change { path, content, hash }`.
- `merge3(base, ours, theirs) -> { changes, conflicts }` where changes are position-based edits the frontend can apply as a CodeMirror transaction.
- `snapshot(path, content, author)`, `list_snapshots(path)`, `read_snapshot(id)`.
- `block_diff(old_blocks, new_blocks) -> alignment`.
- `list_dir(path)`, `search(root, query, options)`.

### 6.5 Document store

One document object per open path, shared by every tab and window that shows it. Opening a file already open focuses the existing tab, in whichever window holds it, or opens a second view onto the same buffer if the user asks for it explicitly.

Per document: source string, parse tree, disk hash, buffer hash, base snapshot (last known disk content), last reviewed snapshot, dirty flag, view state per tab (mode, scroll, selection, folds).

Second views on the same document are kept in sync by forwarding transactions, so both stay identical and undo is shared. Because each window is its own webview, a second view lives in the same window as the first; moving a document to another window moves it, with its view state and undo history, rather than sharing it.

### 6.6 Autosave

On by default. Saves are debounced 800 ms after the last keystroke and also fire on blur, tab switch, and window close. Because the file on disk is the channel to the AI, an unsaved buffer is a hidden state the AI cannot see, so we keep that window short. Users who prefer explicit saves can turn autosave off and get the dirty dot behavior instead.

---

## 7. The hard parts

### 7.1 The lossless editing core

**Decision:** live preview on CodeMirror 6, where the source string is the model and rendering is decoration. Not a ProseMirror WYSIWYG with a markdown serializer.

**Why.** A WYSIWYG editor holds a rich document model and produces markdown from it on save. That step is the enemy of principle 1: it normalizes list markers, re-wraps, re-escapes, drops constructs it does not model, and reformats tables. Every one of those is a spurious diff to the AI. With decoration-over-source there is no serializer to get wrong. An edit is a `ChangeSet` on the string. Untouched bytes cannot change because nothing ever rewrites them. Losslessness is a property of the architecture, not a test we hope passes.

**How live preview works.**

- A `StateField` holds the Lezer tree, updated incrementally on every transaction.
- A `ViewPlugin` walks the visible range of the tree and builds decorations:
  - **Marks** apply CSS classes to emphasis, strong, code, links, highlight, strikethrough.
  - **Replace decorations** hide syntax characters: the asterisks, backticks, brackets, and URLs of links, the `==` of highlights, the `#` of headings, and the `- ` of list items (replaced with a bullet widget).
  - **Line decorations** style headings, blockquotes, callouts, code fences, list indentation.
  - **Block widgets** replace whole ranges with rendered output: tables, math blocks, Mermaid, images, frontmatter. The source underneath still exists and is still the truth.
- **Reveal rule.** When the selection touches a node, that node's syntax is revealed at the smallest useful unit: the inline element for inline marks, the whole block for block widgets. Moving the cursor out re-hides it. This is the Obsidian model and it is what users already know.
- Code fences are never widgets, with one exception. They are always editable text with language highlighting, with the fence lines dimmed when the cursor is elsewhere. The exception is a `mermaid` fence, which follows the block widget rule so the diagram is shown when the cursor is outside it.

**Tables.** The hardest widget, and the one that proves the design. When the cursor is outside a table, the whole table range is a widget rendering a real HTML table. Clicking a cell does not drop to source. Instead:

- Each cell is an editable region inside the widget. The Lezer table extension gives exact source ranges for every `TableCell`.
- Typing in a cell dispatches a CodeMirror transaction that replaces exactly that cell's source range with the new cell text. Pipes, padding, and every other cell are untouched.
- A cell with inline markdown shows its source while being edited and renders again on blur. This is the reveal rule at cell granularity.
- Tab, Shift+Tab, Enter, and arrow keys move between cells. Adding a row inserts one line. Adding a column inserts one `|`-delimited segment per row, which is structural and only happens on explicit command.
- The widget uses `ignoreEvent` so CodeMirror does not fight the cell editor for focus. Selection inside the widget is a DOM selection; the mapping back to source is via the cell's range plus the offset within the cell.

This is genuinely hard, mostly in focus management and IME handling. It is also the first thing to prototype, because if it works the rest of the widgets are simpler versions of the same pattern.

**Frontmatter** is a block widget that renders a properties panel. Editing a property replaces exactly that line. Adding one appends a line before the closing `---`. The YAML is never reparsed and re-emitted.

**Read mode click-to-edit.** The Read renderer emits source ranges on every element. A click resolves the caret position within the element's text to a source offset, switches the tab to Edit, and places the cursor there. Because Edit is the same string, the document does not visibly change; only the block under the cursor reveals.

**Invariant to test.** For any document D and any editor action A whose intended effect is edit E, `apply(A, D)` equals `D` with exactly E applied. The corpus test in section 10 checks this mechanically.

### 7.2 Live merge of external writes

When the watcher reports a change to an open file:

1. If the buffer is clean, apply the diff from buffer to new content as a transaction. Cursor, scroll, folds, and undo history all map through the change set. Take an `external` snapshot. Show gutter markers for the changed ranges.
2. If the buffer is dirty, run a three-way merge with base = last known disk content, ours = buffer, theirs = new disk content.
   - Non-conflicting hunks from theirs are applied as a transaction, same as case 1.
   - Conflicting hunks are inserted as conflict regions rendered by a widget showing both versions with "keep mine" and "take theirs". The document stays fully editable around them. A conflict region is never written to disk; save is held for that document until it is resolved, and the status bar says so.
3. After a successful merge, base becomes the new disk content.

There are no modal dialogs anywhere in this flow.

A save that races an external write is caught by the expected-hash check on `save_document`. The frontend then runs the merge and retries. The user never sees this.

### 7.3 Semantic diff

Line diffs are wrong for prose: rewrapping a paragraph shows as a full replacement, a changed cell shows as a changed row.

The engine works on the tree:

1. Flatten each document into a sequence of leaf blocks: paragraphs, headings, list items, table rows, code blocks, math blocks. Each carries its normalized text and source range.
2. Align the two sequences by block hash with a longest-common-subsequence pass, then a second pass pairing unmatched blocks by similarity so an edited paragraph pairs with its old self rather than showing as delete plus insert.
3. Within paired blocks, word-level diff.
4. Structural moves (a section moved down) are detected as delete plus insert with identical hashes and shown as a move.

Output is a list of change records with source ranges on both sides. The editor uses it for gutter markers and Review mode. "Copy for AI" can include it as "changes since the last agent version" when the user asks.

---

## 8. Files, images, and safety

- **Encodings:** UTF-8 read and write. Other encodings open read-only with a banner offering to convert.
- **Line endings, BOM, trailing newline:** detected on load, preserved on write. The editor works in LF internally.
- **Large files:** up to 10 MB open normally. Above that, Read mode only with a banner. Above 100 MB, refuse with a message.
- **Images:** relative paths resolve against the document's directory and load through the Tauri asset protocol, scoped to that directory and its subdirectories. Absolute local paths work if inside an opened folder. Remote images are blocked by default and can be enabled per document, since loading them leaks the reader's presence to a third party.
- **Webview hardening:** strict CSP, no `eval`, no remote scripts. All dependencies bundled. Mermaid and KaTeX in their strict modes. The inline HTML whitelist is enforced at render time.
- **File associations:** `.md`, `.markdown`, `.mdx` (rendered as markdown, JSX shown as code). Registered as an "open with" handler on all platforms. Files opened from Finder, Explorer, or a terminal go to the existing window as a new tab, not a new window, unless the user holds a modifier.

---

## 9. Giving back to the AI

Three channels, in order of ambition.

1. **Clipboard.** Copy as markdown copies exact source. Copy as rich text copies HTML from the same renderer, for pasting into documents and email. Copy for AI (section 4.3) copies source plus the generated annotations section.
2. **The file itself.** Autosave and atomic writes mean the file on disk is always a coherent, current version. Agents that watch files see the human's edits within a second.
3. **MCP server.** The Rust core exposes a local Model Context Protocol server over Streamable HTTP on `127.0.0.1` with a random port and a bearer token, written to a well-known file so clients can be configured with one command. Tools:
   - `list_documents()`: open documents with paths, dirty state, and last modified.
   - `read_document(path)`: the current buffer, which may be ahead of disk.
   - `list_annotations(path)`: highlights, colors, strikethroughs, and comments as structured records with kind, anchor text, and position.
   - `changes_since(path, snapshot_id)`: the semantic diff.
   - `write_document(path, content, agent_name)`: goes through the same merge path as an external write. The snapshot is attributed to the agent by name and the gutter markers appear immediately.
   - Resources: each open document as `doc://<path>`.

   This turns a highlight into something an agent can query. It also gives the app a reliable author for attribution, which plain file watching cannot provide.

---

## 10. Testing strategy

- **Round-trip corpus.** Assemble a corpus of at least a thousand AI-generated markdown files across models and tasks. For each file, apply randomized editor actions (type in a paragraph, toggle a checkbox, edit a table cell, apply a highlight, add a comment) and assert that the resulting byte diff is exactly the intended edit and nothing else. This is the linchpin test and runs in CI on every change to the editor core.
- **Rendering goldens.** Snapshot the DOM for each corpus file in Read and Edit mode. Diffs must be reviewed by a human.
- **Merge cases.** A table of diff3 scenarios including adjacent edits, whitespace-only external changes, full rewrites, and deletions of the region being edited.
- **Semantic diff cases.** Rewrapped paragraphs, moved sections, single-cell table edits, list reorderings.
- **Performance budget.** Open to first paint under 100 ms for a 1 MB file. Keystroke to paint under 16 ms at the 95th percentile. Merge of a 1 MB external change under 200 ms. Measured in CI with thresholds that fail the build.
- **Manual delight pass.** Before each release, someone runs scenarios S1 through S8 on both macOS and Windows and writes down every moment of friction.

---

## 11. Typography and themes

Read mode is where most time is spent, so its defaults matter more than any setting.

- Measure around 68 characters, line height 1.6, generous heading spacing, a type scale that keeps four heading levels distinguishable without being loud.
- Three bundled families under open licenses: a humanist sans, a text serif, and a monospace. System font stacks as fallbacks.
- Four curated themes, each in light and dark, following the system by default. Page background is its own setting within a theme: white, cream, yellow pad, and black for high contrast, since paper color changes reading comfort more than most people expect. Theme, background, family, size, and measure are app settings. A per-document override is stored in app data keyed by path, so a reader can give one report a serif and a wider measure without the file knowing.
- Tables get row striping, aligned numerics, and horizontal scroll inside their own container rather than widening the page.
- Code blocks get a language label, a copy button, and line wrapping on by default because AI output often has long lines.

---

## 12. Non-goals for v1

- Cloud sync, accounts, collaboration.
- A plugin system. Parser extensions are added in code.
- Export to PDF or DOCX. HTML export is cheap and included; the others wait.
- Wiki links, backlinks, graph views. This is not a knowledge base.
- Mobile.
- Any AI features inside the app. The app is the human's side of the loop. The AI lives elsewhere.

---

## 13. Phasing

**Phase 0: prove the core.**
A bare window with one CodeMirror instance. Live preview for headings, emphasis, lists, code fences, and tables with in-place cell editing. The round-trip corpus test passing. No tabs, no shell, no saving beyond a debug button. Exit criterion: S3 works and the corpus test is green. If this phase fails, the architecture changes before anything else is built.

**Phase 1: minimum delightful product.**
Tabs, open and save with autosave, the three modes with the full dialect rendered including Mermaid and math, outline and heading folding, highlight, color, strikethrough, comments, Copy for AI, live merge of external writes for the non-conflicting case (conflicts are set aside with a snapshot until Phase 2), snapshots and gutter markers, file associations, session restore, one good theme in light and dark. Exit criterion: S1, S2, S3, S4, S8 work.

**Phase 2: the loop.**
Conflict merge UI, semantic diff and Review mode, history panel, folder workspace with sidebar and search, multi-window with tab tearing, the remaining themes and bundled fonts, per-document reader overrides for font and measure. Exit criterion: S5, S6 work.

**Phase 3: the agent side.**
MCP server, agent attribution, HTML export, performance hardening on large files. Exit criterion: S7 works.

---

## 14. Decisions made

| Question | Decision | Reason |
|---|---|---|
| Editing model | Live preview over source, CodeMirror 6 | Losslessness by construction |
| Parser | Lezer markdown for all modes | One tree, exact ranges, incremental |
| Highlight syntax | `==text==` | Widest support among extensions |
| Color | Inline `span` with `color` only | Only universally portable option; highlight already covers background |
| Fonts and size | Never in the file; app settings plus per-document overrides in app data | Visuals are for humans, data is for the AI |
| Comments | HTML comments after the anchor, `<!-- kind: text -->` with a six-word vocabulary | Invisible when rendered, trivially parseable by models |
| Frontend | Svelte 5 | Lighter shell; the editor is framework-agnostic anyway |
| Platforms | macOS and Windows as equal first-class targets; Linux builds and is tested but not polished | Users are on both; file associations, shortcuts, and webview differences need per-platform work |
| Autosave | On by default | The file on disk is the channel to the AI |
| External changes | Merge in place, never a dialog | Principle 4 and S4 |

---

## 15. Open questions and risks

- **Table widget focus and IME.** The biggest technical risk. CJK input inside a widget cell needs testing early. Phase 0 must include it.
- **Comment rendering in the margin** needs a layout that does not jump as the document reflows. Fall back to inline bubbles if margins prove unstable.
- **Attribution of plain file writes** is unknowable in general. Accept `external` as the author and let the MCP path supply names. Consider a heuristic that reads the agent name from a trailing HTML comment if agents adopt a convention.
- **Per-document reader overrides keyed by path** break when a file is moved or renamed. Acceptable for v1. If it matters, key by a content hash of the first snapshot as a fallback.
- **History storage growth** for users with hundreds of agent-written files. The retention policy handles it; measure real usage before tuning.
- **Name.** Decided 2026-09-10: Markdown, one word. It says "markdown" to the average user, and the app is named after the thing it opens, like Preview or Notes. Accepted costs: the bare word is unsearchable, and some will object to an app claiming the format's name. The GitHub URL is the name in practice.
