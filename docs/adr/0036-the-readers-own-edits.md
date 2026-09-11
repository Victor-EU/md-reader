# ADR 0036: What the reader types is not a change

Status: accepted, 2026-09-11. Covers what the change marks and the
Changes badge count while the reader edits (design 4.4, scenario S4).

Three words typed into a new document came back with a green bar beside
them and `Changes 1` in the toolbar. The verdict on it: people know they
are editing. The marks exist to answer "what did the AI change since I
looked" (design 4.4), and until now they answered something wider —
what differs from the last version the reader saved by hand or marked
reviewed — which is everything they had typed since, too. The Phase 2
gate wrote that down as expected ("Change bar in the gutter" after
typing in section 3), and the WP 2.2 run noted the reader's sentence
keeping "its own amber mark". Scenario S4 never asked for it: the
human's unsaved edit in section 3 is untouched, and sections 1 and 5
are what get marked.

## The reviewed pointer moves with the reader

`Doc.reviewed` is still what the marks are measured against. What moves
it now includes every edit the reader makes, as they make it. With
nothing waiting to be reviewed — nearly always — `reviewed` and the
buffer stay the same text, and a scan stops at the identity check
without flattening or diffing anything.

## What arrived is kept as edits

With something waiting, the reader's next edit is in the buffer's
positions and `reviewed` has its own. So the document keeps `arrived`, a
`ChangeSet` from `reviewed` to the buffer made only of what came from
outside: transactions with the `external` user event, which is every
merged write. A write is composed onto it. An edit of the reader's is
mapped back through the inverse of `arrived` and applied to `reviewed`;
the inverse, mapped forward past the edit and turned round again, is the
new `arrived`. That is the pair of mappings CodeMirror's collaborative
editing rests on, and it is what makes the two sides land on one text.

Working this out from the two texts would be a diff per keystroke. The
change set answers the one question typing asks — where is the text
that arrived — by walking its ranges.

## Touching what arrived is part of it

An edit that overlaps text that arrived, or meets it at either end,
stays with it: a word typed into the agent's new paragraph is more of
that paragraph, and Revert should take the word with it. The exception
is an edit starting where a stretch that arrived ends a line. `merge3`
brings whole lines (`crates/core/src/diff.rs`), so that edit is at the
start of the next line, which is the reader's. Without the exception, a
sentence begun at the head of the paragraph after an agent's new one
marked that paragraph as well.

## Pared down before every scan

Composing does not cancel: an undone write leaves `arrived` replacing
text with the same text. Before each scan, and straight after an undo,
a redo or a Revert, every change in it is trimmed to where the two sides
differ, and dropped where they do not. That keeps it to what differs,
which is also what the reader's next edit is measured against. It makes
the fake IPC's character-level merge and Rust's line-level one behave
alike from then on, too.

## Revert keeps the reader's words

A record's revert comes from the baseline, which now holds the reader's
own edits. Reverting an agent's rewrite of a paragraph the reader has
since added a word to puts the agent's words back and keeps theirs.
Before, the paragraph went back whole, their word with it.

## The baseline parses incrementally

With something waiting, each pause in the reader's typing makes a new
baseline, and the scan parses it headlessly. From nothing, a megabyte
takes 150 to 200 ms (plan WP 3.3). The document keeps the last
baseline's tree as fragments, carries them through each edit made to
`reviewed`, and hands them to the next parse.

## What was left

**A document moved to another window with something waiting.** Only the
text of `reviewed` crosses (plan WP 2.5), so the window it lands in
cannot tell the reader's typing from what arrived, and marks both until
the reader next marks it reviewed or saves by hand. One with nothing
waiting crosses as before.

**A save the reader types through.** Cmd+S counts as looking only when
the buffer is still the text it wrote. Typing while the bytes are in
flight leaves what arrived marked until the next Cmd+S or Mark Reviewed,
rather than risk clearing a write that landed mid-save.

**A comparison is unchanged.** A version picked in the history panel is
still measured against the whole buffer, typing included: that is the
question the reader asked.

**Take theirs is the reader's edit.** They saw both versions in the
widget and chose, so the result is not marked unless it meets something
else that arrived.
