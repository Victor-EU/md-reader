# ADR 0032: the macOS menu bar

Status: accepted, 2026-09-10. Covers the by-hand run in
[docs/manual-runs/2026-09-10-macos-menu-bar.md](../manual-runs/2026-09-10-macos-menu-bar.md).

Build plan section 8 asks macOS for a "menu bar with the standard items and
the app's commands". Until now the app had Tauri's default menu — the one
it installs when an application sets none — which is why `before_exit`
carried a paragraph saying that giving Cmd+Q the same round trip as a
window close "means owning the macOS menu, which is the platform work of
build plan section 8". This is that work.

## The bar is a third view of the command registry, not a third list

Plan WP 1.3 says every action is registered once with an id, a title and a
key, and that the palette, the keymap and the menu bar are derived from it.
The registry is TypeScript and the menu is AppKit, so something has to
cross the bridge; the question was which way.

Rust does not read the registry. The window describes the bar it wants —
sections of entries, each entry a command id with its title, accelerator
and whether it can run right now — and Rust builds `tauri::menu` from that
description and sends the id back when an item is chosen. So a command
added to `app-commands.ts` appears in all three places with nothing else to
remember, and `menu.test.ts` can assert the whole layout without a window:
the last test in it is that every command the palette lists is in the bar.

What Rust adds is only what a registry cannot hold. Copy is `copy:` down
the responder chain, not a function this app wrote; the same for Cut,
Paste, Select All, Hide, Services, Minimize and Zoom. Those are named in
the description by a role and built as `PredefinedMenuItem`s. Where they go
is still the window's decision, which keeps the whole layout in one file
beside the commands.

## Cmd+Q is the app's own item

`PredefinedMenuItem::quit` is `NSApplication.terminate:`. It reaches a
Tauri app as `RunEvent::Exit` — no window close, no exit request — which is
far too late to ask a webview to write anything down. Everything the shell
holds that is not yet on disk is lost at that moment: a pending autosave, a
session whose timer has not fired.

So Quit is an ordinary menu item with an id of its own, and choosing it
calls `AppHandle::exit`, which raises `ExitRequested`. That is the same
round trip `before_close` gives a window: every window is asked to flush,
and the quit waits for the answers. The by-hand run measures it — text
typed a fraction of a second before Cmd+Q, well inside the 800 ms autosave
delay, was on disk after the app had gone.

## Undo is a command, not the standard item

The standard Undo sends `undo:` down the responder chain, which for a
`contenteditable` is WebKit's undo manager. CodeMirror's history is not
that: it applies its own changes and would read WebKit putting the DOM back
as something a person typed. `@codemirror/view` has no handling for a
`historyUndo` input event either, so there is nothing to route it to.

Undo and redo are therefore commands like any other, running the editor's
own `undo`/`redo`. That has a consequence worth naming: a menu item's
accelerator is matched before the webview sees the key at all, so from now
on Cmd+Z belongs to the shell, and the shell has plain text fields of its
own — the find bar, the settings, a rename row — where the browser's undo
is the right one. `Workspace.undo` hands those back to
`document.execCommand`, which is deprecated and is still the only way to
ask. The by-hand run checks that case directly: Cmd+Z in the find field
cleared the field and left the document alone.

This is also the one place the shell claims a key the editor already has.
`commands.test.ts` used to assert the two keymaps never overlap; it now
asserts they overlap in exactly these two places and nowhere else, and that
the two are still there — a rename that quietly ended the overlap would
otherwise pass the old test by making the menu bar's Undo do nothing.

## What is not in it

**Close Window.** `PredefinedMenuItem` has no accelerator setter, and the
standard Close Window comes with Cmd+W built in. In this app Cmd+W closes
the tab in front, so the item would be a second Cmd+W that never fires.
Closing a window is the red light in the corner until there is a command of
the app's own for it, at which point ⇧⌘W is free.

**Windows and Linux.** They draw menus inside the window, and this window's
top edge is a tab strip (WP 2.8) with nowhere to put one. The shell only
asks for a menu on macOS and `menu::install` is compiled to nothing
elsewhere, so a stray call cannot put a menu bar inside the window.

## Two things the bar made visible

Building it turned up commands that had nowhere to be seen.

**Pinning a tab** has been a double-click on it since WP 2.8, with state,
session persistence, ordering and a marker in the strip — and no name
anywhere. It is now `go.pin`, which the palette lists and the Go menu
shows. It is also the first command whose name depends on what it would do:
`CommandSpec.label` makes it Pin Tab or Unpin Tab, and the palette, the
toolbar and the menu all ask through `titleOf` so none of them can drift.

**Undo and redo** were in the editor's keymap and nowhere the reader could
read them. They are in the palette now too.

## Cost

The description is rebuilt whenever anything a command reads has changed,
which is a rune effect over the registry. That is cheap and it is also the
whole mechanism: an item greys itself out because `enabled()` is read
inside the effect. Rust compares the shape of the description with the one
it drew — the section names and the entries in order — and only rebuilds
the native menu when that differs, which it never does in practice; a
change of state writes to the items it changed and nothing else, because
every write is a hop to the main thread.
