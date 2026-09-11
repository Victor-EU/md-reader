# ADR 0037: The name in the toolbar is where it is changed

Status: accepted, 2026-09-11. Covers renaming the document in front from
the name at the end of the toolbar's path, and what a name is for a
document that has no file yet.

The name at the end of the path looks like the document's title, and
clicking it selected the words and did nothing else. A title is where
people reach to rename a document, in the Mac's own document apps and
in most web apps that show one, so it is where this app renames one
too.

## Clicking the name makes it a field

Only the name. The folders before it say where the file is, and moving
it between folders is a different promise (see what was left). The
field is drawn in the name's place and at its size, and grows with what
is typed, so nothing moves as the name becomes editable.

Enter keeps the new name and Escape the old one. Clicking anywhere else
keeps the new one, as it does in Finder, and so does a tab switched from
the keyboard. Going to another app is not clicking away: the field is
still open, with the keyboard, when the reader comes back. The Enter
that picks a word in an input method belongs to the input method, and
WebKit reports it as key 229 rather than as composing, so both are
checked.

`Rename…` in the File menu and the palette opens the same field. It is
the keyboard's way to it, and where a Mac reader looks for one.

## A file is renamed where it is

By the same `rename_path` as the sidebar's rename: within its folder,
refused when the name is taken, and followed by the tab, the reading
override, the watch and the recents, exactly as a rename from anywhere
else is.

The field opens with the name chosen and the extension not, which is
Finder's convention: typing renames the document without changing what
kind of file it is. A name typed with no extension keeps the file's
own, so `strategy` over `plan.md` is `strategy.md`, and one that ends
in an extension the app opens is taken as typed. A dot inside a name is
not an extension: `Q3.2026` is `Q3.2026.md`.

Nothing is said when it works, because the reader is looking at the new
name. A refusal is said, in the sidebar's words. The sidebar's own
rename still says `plan.md is now strategy.md`, which this leaves as it
was.

## A document with no file is only called something else

Naming is not saving. ADR 0015 made the first save the reader's, through
the panel, because that is where they say where the file goes, and a
name typed in the toolbar says nothing about where. So it writes
nothing. The document is called what was typed, in its tab, in the
toolbar and in the Window menu, and the session carries the name with
the text, as a move to another window does. The first save proposes
that name ahead of the first heading: the heading is the app's guess at
a name, and this one is the reader's.

`Untitled 3` is what the app hands out, and a restored document's
number keeps a new one from repeating it. A name the reader chose is
not one of those numbers, however it ends, so `Plan 2026` no longer
makes the next new document `Untitled 2027`. Which names are the app's
is read from the name itself, so the session stores nothing new: a
reader who types `Untitled 5` has chosen a name the app might have
handed out, and the heading is proposed as though they had not.

## What was left

- **The history stays under the old name.** Versions are kept by path,
  so a renamed file starts a new list, and what went before is under
  the name it had. That was already so for a rename from the sidebar or
  from outside the app; the toolbar makes it easier to get to.
- **No moving between folders.** A name with a slash in it is refused as
  a path, as it is in the sidebar.
- **A PDF is not renamed here.** The toolbar has no name for one.
