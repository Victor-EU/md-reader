# Phase 0 gate, September 2026

Plan section 3.6 (WP 0.6). Fill in per platform. Every moment the illusion broke
is a line here, however small.

Run on 2026-09-08 by Claude (agent), macOS 15 (Darwin 24.5.0), Apple silicon.
Commit `f983306` plus the cell-editor fix below. Two passes were made:

- **Pass A** (morning): Playwright Chromium and WebKit against the editor on the
  Vite dev server. Found and fixed the cell-space defect. Not the shipping webview.
- **Pass B** (09:35–10:12, after an Accessibility grant): the real `MD Reader`
  window, real WKWebView, real Tauri file IO, driven by synthesized HID events —
  keystrokes through System Events and single clicks through `CGEvent`. S3 and
  the 30-minute session were done this way. **The IME checklist and Windows are
  still not run.**

Raw artefacts from pass B: [2026-09-08-session-notes.txt](2026-09-08-session-notes.txt)
(timestamped, unedited, including the harness mistakes) and
[2026-09-08-session-document.md](2026-09-08-session-document.md) (the document
that was written during the session, as saved by the app).

## How this run was done

| Leg | What actually drove it | Is this the shipping path? |
|---|---|---|
| App launch | `pnpm tauri dev`, real WKWebView window on screen | Yes |
| S3 cell edits, pass A | Playwright Chromium 1.63 and WebKit 1.63 against the editor on the Vite dev server | No — real WebKit, not WKWebView, no Tauri IO |
| S3 cell edits, pass B | The app window. Open dialog via Cmd+Shift+G, cell click via `CGEvent` (click count 1), keys via System Events, Save via the toolbar button, `git diff` on disk | **Yes** — WKWebView, Tauri save |
| Composition | Chromium CDP `Input.imeSetComposition` (pass A only) | Partly — Blink's real composition pipeline, not a macOS input method |
| 30-minute session | The app window, keystrokes at 0.03–0.2 s per key, screenshots at each checkpoint, file read back after every save | **Yes**, with the caveats below |
| Windows | Not run | — |

What still blocks the rest:

1. **No CJK input source is enabled on this machine.** At 10:11 the enabled
   sources were still U.S., ABC and the character palette. Without Pinyin or
   Japanese there is no real IME to drive. Add them under System Settings →
   Keyboard → Input Sources; the harness can then type romaji/pinyin key codes
   through the active IME and press Space, Enter and Escape, which is a real
   composition, not a synthesized one.
2. **No Windows machine.**

**Caveats on pass B, all about the harness, none about the product.** These are
recorded because two of them produced false findings that were retracted, and
anyone repeating this by script will hit the same walls:

- System Events `click at` is delivered to WKWebView as a multi-click. A "single"
  click into a rendered paragraph selected the whole paragraph, and the next key
  replaced it. A `CGEvent` click with click count 1 placed the caret exactly.
  Every click-then-type result below was re-done with the `CGEvent` click; the
  earlier click-then-navigation-key results (Cmd+Right before typing) were
  unaffected because the navigation key collapsed the selection.
- Option+Arrow key events were intercepted by the Claude desktop app's global
  quick-entry hotkey, which opened a chat popup and swallowed the rest of that
  sequence. One sentence of the session document lost eight characters to it.
- After clicking Save, keyboard focus stays on the button. Typing without
  clicking back into the page went to the toolbar.
- System Events `keystroke` of non-ASCII text under a US layout arrives as `a`;
  CJK was delivered through the clipboard (Cmd+V) instead, after a first attempt
  with a non-UTF-8 shell locale put Mac Roman mojibake on the clipboard. The app
  round-tripped those bytes faithfully too.
- Tab inside typed text is an editor finding, not a harness one (below), but it
  twice sent the rest of a typed passage into the file dialog.

**Aside, worth knowing:** `target/release/bundle/macos/MD Reader.app` is stale.
Its bundled JS contains `Save (debug)`; its Save is a no-op stub. Both passes used
`pnpm tauri dev`. Rebuild the bundle before anyone treats it as the artifact.

## Automated results (filled by the build)

Re-run on this machine, not copied from a previous run.

- `pnpm test`: green, 220 tests in 25 files, ~13 s. Includes the corpus test on
  Chromium and WebKit, and the three typing tests from the fix below.
- Corpus: 218 files, 37 adversarial and 181 generated (plus one golden).
- Keystroke work p95 at 1 MB, four runs: **6.2–7.2 ms Chromium, 6–13 ms
  WebKit**, budget 16 ms. In budget every time; the WebKit spread is most of the
  budget on a machine that was also running a dev build and two browsers.
- Worst single keystroke at 1 MB: **30–33 ms on both engines**. p95 is
  comfortable; the tail is over one frame.
- The bench types into a paragraph through the outer view and never activates a
  cell, so it does not exercise the cell editor or the fix.
- First paint at 1 MB: 7.5 ms Chromium, 9 ms WebKit.
- These are Playwright's browsers. The in-app `--bench` on the pinned machines
  has not happened. Nothing in pass B measured latency; typing at 0.03 s per key
  (faster than a person) never visibly lagged, dropped or reordered a character.

## S3, edit a table in place

**Pass B, in the app.** `sample-plan.md` pristine at the start (sha256
`d7fdfcae…5194f9`). The gesture as a person does it: click just after `Sam`
(`CGEvent`, click count 1, no navigation key), Backspace ×3, type `Lee`, Tab,
Backspace ×5, type `10-01`, click Save.

```
-| Write the brief | Owner: Sam | 2026-09-15 |
+| Write the brief | Owner: Lee | 2026-10-01 |
```

```
00000010: 6620 7c20 4f77 6e65 723a 204c 6565 207c  f | Owner: Lee |
```

500 → 500 bytes, one line changed, every other line byte identical. Then, from
pristine again, the same click after `Sam`, Backspace ×3, Cmd+V with `東京` on the
clipboard, Tab, date edit, Save:

```
-| Write the brief | Owner: Sam | 2026-09-15 |
+| Write the brief | Owner: 東京 | 2026-10-01 |
```

```
00000010: 6620 7c20 4f77 6e65 723a 20e6 9db1 e4ba  f | Owner: .....
00000020: ac20 7c20 3230 3236 2d31 302d 3031 207c  . | 2026-10-01 |
```

500 → 503 bytes, `e6 9d b1 e4 ba ac`, padding intact, every other line byte
identical. The same two edits were also done earlier in pass B with Cmd+Right
before typing, with identical output. Pass A (Playwright, both engines) matched
byte for byte.

| Step | macOS | Windows |
|---|---|---|
| Open `docs/manual-runs/sample-plan.md`; table renders as a table | **Pass** in the app (WKWebView) | Not run |
| Click "Owner: Sam", change to "Owner: Lee" | **Pass** in the app, typed key by key with a real single click and no navigation key. Failed in pass A before the fix below | Not run |
| Tab to the date cell, change the date | **Pass** in the app. Tab lands at the *end* of the next cell | Not run |
| Save; diff on disk is exactly the two cells (`git diff`) | **Pass** through Tauri's save. Status bar `Saved · 500 bytes · utf-8 · lf` | Not run |
| Repeat with a CJK edit in one cell (e.g. 東京), diff exact | **Pass** in the app, CJK delivered by paste (see caveats) | Not run |

`sample-plan.md` was restored to pristine afterwards.

## Finding: a space typed into a table cell was destroyed — fixed

Found in pass A, before any of the above. Recorded in full because the gate is
also a record of what nearly shipped.

**Symptom.** No space could be typed into a table cell. Every space was dropped
from the visible cell and simultaneously left in the document as trailing
whitespace the user could not see or reach.

| Typed into the cell | Cell showed | File held |
|---|---|---|
| `a b` | `ab` | `\| ab  \|` |
| `a b c d` | `abcd` | `\| abcd    \|` |
| `Owner: Lee` | `Owner:Lee` | `\| Owner:Lee  \|` |
| ` Lee` (leading space) | `Lee` | `\| Lee  \|` |

The stray bytes accumulated, one per space typed. The document and the cell
editor disagreed from the first space onward, and the file grew bytes the user
never put there.

**Scope.** Chromium and WebKit, identically, at inter-key delays of 0, 60, 150
and 400 ms. Paragraphs unaffected. Only spaces at an edge of the cell's text —
which, typing left to right, is every space.

**Mechanism.** `rowCells` in
[model.ts:55](packages/editor-core/src/preview/table/model.ts:55) defines a
cell's range as its *trimmed* content. The widget rebuild after each keystroke
called `sync`, which overwrote the nested view with `cellText` over exactly that
range, so a trailing space vanished from the cell while the outer document kept
it, and everything typed afterwards was rebased to the left of the orphan.

**The fix**
([cell-editor.ts](packages/editor-core/src/preview/table/cell-editor.ts)). The
manager keeps `cellStart`, the offset where the nested document begins in the
outer one. `sync` skips the overwrite when the rebuild is the manager's own
rebase *and* the outer document still reads back exactly as the nested view over
the span it occupies; `onNested` rebases onto that span. Undo, redo and outside
changes still overwrite the nested view from the document; the outer document
remains the truth. Three tests in `widget.browser.test.ts` now type one
transaction per character and fail against the old code on both engines.

**Verified after the fix**, pass A on both engines at all four speeds, and pass B
in WKWebView by the S3 gesture above.

**Residual, deliberately not fixed, confirmed in WKWebView.** Type ` x ` at the
end of a cell and Tab away: the file holds `\| two x  \|`. The table is well
formed and the byte is padding, not content. Normalising it would mean writing to
the document on blur. Worth a second opinion.

## IME checklist (table cell and paragraph)

Pinyin and Japanese: compose, cancel, commit, delete after commit. Byte diff after each.

**Not run as specified.** No input method was available: the machine has no
Pinyin or Japanese source enabled (checked at 09:35, 09:50 and 10:11). Pass A's
Chromium CDP composition results stand as the only composition evidence:

| Case | macOS | Windows |
|---|---|---|
| Paragraph, compose and commit | Chromium CDP only: pass | Not run |
| Paragraph, cancel composition | Chromium CDP only: pass, byte identical | Not run |
| Table cell, compose and commit | Chromium CDP only: pass | Not run |
| Table cell, cancel composition | Chromium CDP only: pass | Not run |
| Delete after commit | Chromium CDP only: pass, one grapheme | Not run |
| **WKWebView, any case, real IME** | **Not run — no input source on the machine** | — |
| **WebView2, any case, real IME** | — | **Not run** |

What pass B does add: CJK and emoji *pasted* into a WKWebView paragraph and a
table cell round-trip byte-exact (`東京 🍣 café`, `東京` in a cell). That says
nothing about composition.

Once Pinyin and Japanese are enabled, the pass-B harness can drive them: it types
key codes, so `toukyou` Space Enter goes through the real IME. The cases to try
first remain a commit that ends in a space, and a commit into a cell whose text
already ends in one.

## 30-minute writing session

Write a real document from scratch in Edit mode. Note each friction moment with the time.

**Run.** 09:42:25 to 10:11:27 in the app, 29 minutes wall clock, about 26 of
active input; the rest was reading screenshots between segments. The document
was started from a one-line file and grew to 3,601 bytes: headings, paragraphs
with inline marks, bullet, ordered and task lists, callouts, a code fence, two
tables typed by hand and edited through the widget, undo and redo, mode toggles,
paste, Escape, keyboard walks. The full timestamped log is in the notes file.
Every save was read back; **the file never held anything other than what had
been typed** — a 451-character paragraph typed key by key plus a pasted CJK/emoji
string compared byte-exact against the intended text, as did a Source→Edit→Save
round trip, select-all/delete/undo, and 40 undos followed by 40 redos.

The illusion broke at these moments, worst first. Every one is reproducible from
the notes; none lost text; each made the page do something other than what the
hands expected.

1. **09:44 / 10:07 — Backspace on an empty auto-inserted list marker turns it
   into indentation, and the indentation sticks.** Type `- one`, Enter (editor
   supplies `- `), Backspace to cancel the bullet: the line becomes two spaces
   and everything typed after it — including a `> quote` two paragraphs later —
   is a continuation of `one`. With an ordered item it is three spaces; a task
   item typed inside that and cancelled the same way leaves nine. The closing
   paragraph of the session sits nine spaces deep in the source and **renders as
   a code block**. A writer sees their prose turn monospace and has no idea why.
2. **09:44 — Enter twice at the end of a list or quote does not make a new
   paragraph.** The second Enter removes the marker but adds no blank line, so
   the next paragraph is a lazy continuation: `- item two` / `after bullets` in
   the source, and rendered inside the list (or inside the quote bar). Same for
   ordered and task lists. Three Enters do give the blank line, but nobody
   knows to press three. This is why the seg-1 code fence ended up inside the
   callout as `>```js`.
3. **09:55 — Tab leaves the editor.** In a bullet or in a paragraph, Tab moves
   focus to the web view (`AXWebArea`); Shift+Tab lands on a toolbar button. A
   writer who presses Tab to indent a list item and then Enter opens the file
   dialog. This happened twice to the harness before it was isolated.
4. **09:47 — ArrowDown into a table below the fold activates a cell you cannot
   see.** Walking down from the top, the header cell became the active editor
   while the whole table was still off screen; nothing scrolled until the first
   character was typed. Typing blind.
5. **09:51 — Backspace at the start of the paragraph under a table.** The first
   press removes the blank line; the second joins the paragraph onto the table's
   last row (`\| #4\| \|Below the table.`). Undo ×2 restored it exactly.
6. **09:49 — Bare `[like these]` in prose renders as a link**, blue and
   underlined with the brackets hidden, and styled as a link in Source mode too.
   Plain Markdown leaves it as text.
7. **09:48 — Table cursor placement is inconsistent:** Tab into a cell puts the
   caret at the end, ArrowDown into a cell keeps column 0. Tab past the last cell
   appends `\| \| \|` and typing into it gives `\| #4\| \|`, no padding after the
   text, unlike every hand-typed row.
8. **09:51 — Residual from the fix**, above: a trailing space typed in a cell
   stays as padding.

Worked as a document, for the record: marker reveal on the cursor line (`**bold**`
shows its stars when the caret is on that line); a click on a rendered link edits
rather than navigates; the checkbox click writes `[x]`; clicking into rendered
prose, a heading, a list item and a callout body placed the caret at the glyph
(with a real single click); Escape from a cell drops to source with the table
shown as source; ArrowUp from below enters the table; the widget re-rendered
after every cell keystroke without a visible flicker at 0.03 s per key.

Not a finding, noted so nobody chases it: after 40 fast ArrowDowns the cursor was
one row short of where it should have been; the specific step (header cell →
body row) reproduced correctly on its own, so a key was dropped in transit.

## Windows

- **Parked (2026-09-08).** No Windows machine is available, so the Windows
  column is deferred rather than pending. S3, the IME list and the writing
  session remain outstanding there, and WebView2 has been exercised by nothing
  in this run. The gate cannot reach *Pass* as the plan defines it until a
  machine turns up; the macOS evidence is what the Phase 0 decision rests on.

## Verdict

**Not passed, and still not decidable on the plan's three outcomes, but much
closer, and nothing found points at Fail.**

Against plan section 3.6: *Pass* requires everything on the list, and the IME
checklist and the whole Windows column were never executed. *Fail* is "cell
editing cannot be made reliable", to be decided with session notes in hand. The
notes are now in hand: 29 minutes in the shipping webview, and not one of the
eight frictions is about cells losing or corrupting text. Cell editing was the
part that worked. *Partial* as the plan defines it — widget fine in Chromium but
IME failing in WebKit or WebView2 — has not happened either, because no real IME
has been tried anywhere.

What is now known that was not known this morning:

- S3 passes **in the app**, in WKWebView, through Tauri's save, by the natural
  gesture, ASCII and CJK, byte exact. The morning's browser results were not an
  artefact of the browser.
- Thirty minutes of real use never produced a byte in the file that had not been
  typed. The serializer and the decoration-over-source model hold up under a
  person's worth of input.
- The session findings are all keyboard-gesture bugs in list, quote and
  focus handling — items 1 to 3 above — plus two smaller table ones. They are
  the kind of thing that makes the editor feel unfinished, not the kind that
  argues for the "rewrite Phase 0" fallback. But item 1 in particular will end
  a real writer's session in the first five minutes, and should be fixed before
  anyone is asked to judge whether this "feels like a document".

Recommended next steps, in order:

1. ~~Fix items 1, 2 and 3 of the session list (Backspace on a marker, Enter-Enter
   to leave a block, Tab captured by the editor). They share one area of code.~~
   Done the same afternoon, see below.
2. Enable Pinyin and Japanese on this machine and run the IME checklist — by
   hand, or with the pass-B harness now that Accessibility is granted.
3. Rebuild the macOS bundle; the current one has a stubbed Save.
4. Windows: S3, IME, session. Parked until a Windows machine is available.
5. Decide the residual trailing-space question.
6. Consider a pinned-machine `--bench` run before Phase 1 latency work leans on
   the browser numbers.

## Fixes made after the run (2026-09-08, afternoon)

Session findings 1 to 7 are fixed in `packages/editor-core`; the verdict above
is unchanged because the IME checklist and Windows are still not run.

| Finding | Fix | Where |
|---|---|---|
| 1. Backspace on an empty marker left spaces that grew into a code block | Backspace right after a list marker removes the marker, its indentation and task box; after a quote marker it removes that marker. Nothing is written in its place. | `commands/list.ts`, `deleteMarkerBackward` |
| 2. Enter twice did not leave a list or quote | Enter on an empty item under text turns the item into the blank line that ends the block and opens a fresh line below it. An empty nested item moves out to its parent's level first. | `commands/newline.ts` |
| 3. Tab and Shift+Tab left the editor | Tab indents a list item under the item above (Shift+Tab outdents); in text it inserts a tab except as line indentation, where it does nothing. The key is always consumed. | `commands/list.ts` |
| 4. Keyboard entry into a below-fold table did not scroll | The cell that opens scrolls itself into view. | `table/cell-editor.ts` |
| 5. Backspace under a table joined the paragraph into the last row | Backspace at the start of the line under a table, or of the first text line after the blank line under it, opens the last cell and changes nothing. | `table/cell-editor.ts` |
| 6. Bare `[like these]` styled as a link | A `Link` node is styled and its brackets hidden only when it has a URL or its label has a definition in the document. | `preview/build.ts` |
| 7. A row added with Tab was `\| \| \|`, so typing gave `\| #4\| \|` | New rows are `\|  \|  \|`, the padding a hand-typed row has. | `table/commands.ts` |

Not changed: the caret lands at the end of a cell reached by Tab and at the
start of one reached by an arrow key (finding 7's second half, a choice), and
the trailing-space residual (recommendation unchanged, leave it).

Checked in the shipping webview through Tauri's save, on a scratch file, by the
same harness as pass B: Enter-Enter after a bullet gave `- two`, blank line,
`para`; Enter then Backspace on `1. first` left an empty line with no spaces;
Tab on `- one` gave `  - one` with focus still in the editor and Shift+Tab took
it back; Backspace at the start of `Below.` under the table opened the last
cell (focus probe: "table cell") and a key typed there landed as `| x | yW |`
with the blank line and the paragraph untouched. Automated: 241 tests green in
Node, Chromium and WebKit; the `callout.md` decoration snapshot changed by
exactly the four `[!…]` spans that are not callouts and no longer read as links.

