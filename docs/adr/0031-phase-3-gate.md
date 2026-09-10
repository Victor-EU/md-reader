# ADR 0031: the Phase 3 gate

Status: accepted, 2026-09-10. Covers the gate run in
[docs/manual-runs/2026-09-10-phase3-gate.md](../manual-runs/2026-09-10-phase3-gate.md).

The plan's Phase 3 gate is three criteria: S7 by hand with a real agent
client, all eight scenarios re-run on both platforms, and a v1 release
candidate.

The first is met, and the second on the one platform there is. **The gate
is not passed**: 1.0 is not this run's to declare, for reasons that are all
older than this phase.

## A real agent client is not a test double

The MCP package already had an in-process client exercising every tool, and
that test is the reason the tools work. It cannot answer this criterion.
What S7 asks is whether *a model on the other end of a socket* can find the
reader's document, understand marks it did not make, and put a version back
that the window will take — and every part of that is about the parts a
harness stands in for: the endpoint file, the stdio bridge, the schema a
model reads, the words in `instructions`, and whether an annotation record
means anything without the syntax around it.

So the client was Claude Code, configured from the app's own palette
command and nothing else. The interesting result is not that it worked; it
is *what it said*. Asked only to do what the notes ask, it came back with
"a **remove** comment on the sentence…, and a **note** on the Risks
paragraph saying too ambitious, cut to two weeks" — the meanings, not the
`<!-- -->`. Design 9's claim is that a highlight becomes something an agent
can query because a mark in a file is a string and an annotation record is
a fact. That is the sentence being true out loud.

## The two defects were both in the seam between two features

Neither finding is in a feature. Both are in what happens when two of them
meet, which is exactly what a scenario is and what a unit test is not.

**A margin on a block widget.** Live preview draws a table, a diagram, a
frontmatter panel and a lone image as widgets, and the theme spaced them
with `margin`, which is what one writes without thinking. The editor
measures the element it was handed, and a margin is outside that element,
so the height map lost 14 px at the table and another 8 at the diagram and
every click below them landed a line low. Neither the preview tests nor the
theme could see it: the widget renders correctly, the margin is real, and
the only thing that is wrong is a number the editor keeps somewhere else.
It took a by-hand click to notice and a measurement of the height map
against the DOM to explain. The rule that comes out of it is one line long
— **space a block widget with padding, because that is the part of it the
editor can see** — and it is now written where the four blocks are styled.

**A note inside a mark.** `Cmd+Shift+H` then `Cmd+Shift+M` is one gesture
in two presses, and the second is handed the selection the first one
wrapped. Each command is right on its own; composed, they bury the note
between the marks, where the extractor's adjacency rule cannot see it. The
editor still drew it in the margin, so the app showed the reader an
annotation it would not report — to Copy for AI or to an agent. The fix is
in the writer rather than the reader: a note about a span the selection
exactly fills steps out of the marks first. A note on *part* of a mark
stays where it was typed, and is still not listed; that is the same rule as
before and is now the known limit rather than a surprise.

## Why there is no release candidate

The plan says "1.0 at Phase 3 gate", and the three things standing in front
of it are all things this run cannot do: two weeks of the developer's own
use (Phase 1's last criterion), a beta in front of outside users (Phase 2's
last criterion), and an Apple Developer Program enrolment without which
every `.dmg` is refused by Gatekeeper on any machine but the one that built
it.

Cutting a 1.0 anyway would be a version number that says two gates were
passed when they were not. The repository is otherwise ready: one version
number across three manifests with a test that keeps them agreeing, a
tag-driven workflow, and a signed updater manifest as soon as there is a
key in CI to sign it with.

## What was left

- **Windows.** Third gate in a row. The `--mcp-stdio` bridge is the piece
  of this phase most likely to differ there and the piece with no machine
  to try it on (ADR 0028).
- **A comment inside a mark it only partly covers** is still dropped by the
  extractor rather than listed with an empty anchor, which is what the file
  says it does with a comment anchored to nothing. Fixing it means deciding
  what the anchor text of a mark that contains a note should be, and that
  is a design question, not a gate fix.
- **The save panel opens beside the first open document inside the folder**,
  which was two levels down from the root the sidebar was showing.
  `saveFolder` says why it does that, and it is defensible; it still read as
  wrong in the run.
