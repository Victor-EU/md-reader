# ADR 0018: the Phase 1 gate

Status: accepted, 2026-09-09. Covers the gate run in
[docs/manual-runs/2026-09-09-phase1-gate.md](../manual-runs/2026-09-09-phase1-gate.md)
and the six things it found.

The plan's Phase 1 gate is five criteria. Four are met on macOS; the fifth is
two weeks of the developer's own use, which no run can produce. **The gate is
not passed**, and this record says exactly what stands between here and
passing it.

## The scenarios were run against the installed build, and it mattered

Every earlier work package was checked with `tauri dev`. This one used
`pnpm tauri build`, `/Applications`, and a double-click, because three of the
six findings only exist there: the updater is wired for `import.meta.env.PROD`
alone, `LaunchServices` only sees bundles, and the file association is a
property of the installed application.

It cost an hour to discover that `/Applications/MD Reader.app` was a build
from 2026-09-07 — the WP 0.1 skeleton, still showing "Open / Save (debug)" —
and that a second, equally stale debug bundle in `target/` was what
`LaunchServices` actually preferred for `.md`. Two bundles with one identifier
is a state a developer machine falls into and never notices.

## The three fixes

### A scroller with no `tabindex` cannot be scrolled by keyboard

Read mode and Settings are both `overflow-y: auto` on a plain `<main>`. The
wheel scrolled them; Page Down, Space and the arrows did nothing, because a
scrolling element answers those keys only when it has focus and an element
with no `tabindex` can never take it. S1 asks the reader to scroll, so this
failed a gate scenario outright, and it had been shipped since WP 1.4.

`tabindex="-1"` on both panes keeps them out of the tab order and lets
`focusScroller` give them the keyboard on mount. Every shortcut is bound on
the window, so nothing else wants that focus — except a field the reader is
typing in, which is the one case `focusScroller` declines.

### The annotation marks never got WP 1.10's trimming

Selecting a paragraph by dragging over it ends the selection after the last
line break. Wrapping *that* in `==` puts the closing marker alone on the line
below a paragraph, which is a Setext heading underline: the paragraph rendered
at heading size and appeared in the outline as a heading. The file said
something the reader never asked for and the renderer was right to obey it.

`markEdit` in `format.ts` has had the guard since WP 1.10, with a comment
describing this exact failure for `**`. The annotation commands in
`annotate.ts` are older — WP 1.6 — and the fix never came back to them. All
three had it missing: `toggleWrapEdit` (highlight and strikethrough),
`colorEdit`, and `commentEdit`, where an untrimmed range put the note at the
head of the *next* block, anchored to text it was not about.

The trimming is now `trimmed` in `edit.ts` and the seven marks share it. One
existing expectation changed: a comment on a selection that took the trailing
space used to land as `-->two three.`, glued to the next word, and now sits
between the words with a space either side. The old output was worse and the
test had encoded it.

Adding a corpus action for this would not have caught it: the corpus picks
words through `pickWord`, which never selects to a line end. What caught it
was dragging over a paragraph, which is what a reader does first.

### S4's last clause was not implemented

"The human presses a key to step through the changes, then mark reviewed."
The marks were drawn and Mark Reviewed worked. Nothing walked them, and the
palette answered "Nothing matches" to the word "change".

`nextChange` and `previousChange` read the runs back off the marks rather
than keeping a list beside them. The marks are already mapped through every
edit the reader makes, so they are the only description of where the changes
are that stays true while the reader types and the next diff catches up.
Consecutive marked lines are one change. Stepping wraps, as find does.

`⌥⌘G` and `⌥⇧⌘G`, because these are the siblings of Find Next and Find
Previous: the same gesture over a different list. From Read mode the step
switches to Edit first and waits in `pendingStep` for the editor to mount,
which is the pattern `find` already uses for the same reason.

## The fourth fix is about the repository, not the product

`bindings_path()` is baked in at compile time from `CARGO_MANIFEST_DIR`, so a
debug bundle left in `target/` keeps a live path into the checkout and
rewrites `packages/ipc/src/bindings.ts` when it is launched — with whatever
command set *it* was built from. The stale bundle above did exactly that,
took two work packages of commands back out of the generated file, and broke
`pnpm check` in a way that pointed at `packages/ipc` rather than at the
launch that caused it.

A bundle has no business writing into a source tree. The export now runs only
from a loose binary, which is what `tauri dev` produces.

## What was left, and why

**A new file is created with mode 600.** `atomic::replace` copies an existing
target's permissions onto the temporary file, but a new file has no target to
copy from and keeps `tempfile`'s own 0600. Files this app creates are private
where every other tool's are 644. Doing it properly means honouring the
umask, which needs a `libc` dependency and a read that is not thread-safe;
that is a decision to take deliberately, not inside a gate run.

> **Fixed, 2026-09-09.** The premise was wrong: nothing has to read the
> umask. `tempfile` passes a requested mode to `open`, so asking for 0666
> has the *kernel* apply the umask, exactly as it does for every other
> program that creates a file. No `libc`, no `umask(umask(0))`, no window
> in which another thread's files come out wrong.
>
> It did surface a second question the finding had not. `atomic::replace`
> is the one write path for documents *and* for the snapshot store and
> session state, so honouring the umask everywhere would have opened files
> holding the reader's text to anyone else on the machine — 0755 data
> directories on Linux, where 0600 had been protecting them by accident.
> The call now takes an `atomic::Create`, and each of the five sites says
> which it means.
>
> Verifying that found the one file that does not go through the call at
> all. SQLite creates `history.db` itself, so the index arrived at 0644
> while every blob it points at was 0600 -- and its rows are the record of
> which documents the reader has open and when they last touched them.
> `History::open` now narrows the directory, the index, and the `-wal` and
> `-shm` pair. All three, because none covers the others: SQLite gives the
> pair the mode of the database it opened, but an unclean exit leaves a
> pair behind and the next run picks it up as it stands, while the
> directory is what covers whatever else ends up inside it and the file
> modes are what survive a copy or a restore.

**The word count includes comment text.** A `<!-- note: … -->` is markup the
reader hid for a model, not prose they wrote, and one note moved the count
from 212 to 220. Design 4.1 says only "word count", so this is a question to
answer rather than a bug to fix.

> **Answered, 2026-09-09: they do not count.** A note is not something the
> writer wrote, so annotating a paragraph must not make it longer; a count
> that climbs while you mark up the draft is one you stop believing. The
> rule is what the reader is shown, which makes it the parser's question
> rather than a regular expression's — `<!-- -->` inside a fenced block
> *is* shown, and is counted. `commentSpans` walks the same tree the
> outline uses and stops at `-->` rather than at the end of the node,
> because a block comment runs to the end of its line and what follows the
> close mark is still rendered.
>
> Frontmatter is still counted, and the same rule says it should be: the
> reader is shown it, as the properties panel of design 5.1. Whether the
> keys and values of that panel are prose the writer wrote is a different
> question from this one, and is left open.

**Windows.** Not run, and not runnable: there is no Windows machine. The
first and fourth criteria say "on both platforms", so they are half met by
choice. This is the same standing decision recorded since 2026-09-08.

## What stands between here and a passed gate

1. **Two weeks of the developer's own use, with a friction log.** The only
   criterion an agent cannot produce. The installed build is now current, so
   it can start.
2. **Windows**, whenever there is a machine.
3. Not a gate criterion but on the same critical path: **Apple Developer
   Program enrollment** (ADR 0017), and **the licence file** that WP 0.1
   required before the first corpus file was committed and that still does
   not exist.
