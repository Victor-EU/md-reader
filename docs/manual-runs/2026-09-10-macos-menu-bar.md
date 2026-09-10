# The macOS menu bar, by hand

Build plan section 8, macOS: "Menu bar with the standard items and the
app's commands." Run on 2026-09-10 by Claude (agent), macOS 15.5 (Darwin
24.5.0), Apple silicon, against commit `0e3d68e` plus this change.

**The app under test was the installed release build**, `/Applications/MD
Reader.app` 0.1.0, rebuilt from this working tree and launched from
Finder's copy. Not `tauri dev`.

The menu bar is the first surface of this app that is not in the webview,
so it could be read rather than only photographed: every check below asks
System Events for the real `AXMenuItem` tree of the running process —
names, enabled flags, `AXMenuItemCmdChar` and `AXMenuItemCmdModifiers` —
and the behavioural ones drive the real keys. The driver is
`scratchpad/menu/drive.sh`.

## What is there

`get name of every menu bar item of menu bar 1`:

> Apple, MD Reader, File, Edit, View, Go, Window, Help

| Menu | Items, in order |
|---|---|
| MD Reader | About MD Reader · — · Settings · — · Services · — · Hide MD Reader, Hide Others, Show All · — · Quit MD Reader |
| File | New File, Open File…, Save, Open Folder…, Close Folder, New File in Folder, Convert to UTF-8, Export as HTML…, Close Tab, Reopen Closed Tab, New Window, Move Tab to New Window |
| Edit | Undo, Redo · — · Cut, Copy, Paste, Select All · — · the twenty-nine the registry has, from Bold to Rotate the Agent Token · — · AutoFill, Start Dictation…, Emoji & Symbols |
| View | the sixteen the registry has, from Read Mode to Open a Second View · — · Toggle Full Screen |
| Go | Quick Open…, New Tab, Command Palette…, Pin Tab, Next Tab, Previous Tab |
| Window | Minimize, Zoom · — · Bring All to Front |
| Help | Check for Updates…, Install Update, Restart to Update |

The last three in Edit are macOS's, not the app's: the system adds them to
any menu named Edit. Settings is in the application menu and not in File,
which is where the registry has it and where the other platforms want it.

## The shortcuts, as AppKit reports them

Read from `AXMenuItemCmdChar` and `AXMenuItemCmdModifiers` (0 = ⌘,
1 = ⇧⌘, 2 = ⌥⌘, 3 = ⌥⇧⌘, 8 = no key), and each compared with the binding
in `app-commands.ts`.

| Item | Reported | Registered |
|---|---|---|
| Settings | `,` 0 → ⌘, | `Mod+,` |
| Quit MD Reader | `Q` 0 → ⌘Q | the app's own item |
| Hide Others | `H` 2 → ⌥⌘H | AppKit's |
| Save | `S` 0 → ⌘S | `Mod+S` |
| Open Folder… | `O` 1 → ⇧⌘O | `Mod+Shift+O` |
| Undo / Redo | `Z` 0, `Z` 1 | `Mod+Z`, `Mod+Shift+Z` |
| Highlight | `H` 1 → ⇧⌘H | `Mod+Shift+H` |
| Find and Replace… | `F` 2 → ⌥⌘F | `Mod+Alt+F` |
| Previous Change | `G` 3 → ⌥⇧⌘G | `Mod+Alt+Shift+G` |
| Next Tab / Previous Tab | `]` 1, `[` 1 | `Mod+Shift+]`, `Mod+Shift+[` |
| Pin Tab | none | none |

The bracket pair is the one worth naming. The registry stores the physical
key (`BracketRight`) rather than the character, and the accelerator is
built from that, so the menu item and the keymap are the same key on a
layout where `]` is somewhere else.

## What it does

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | Launch with the restored session, Settings tab in front | Edit menu's own commands greyed out | **pass** — Bold…Copy for AI all `false`, Cut/Copy/Paste `true` |
| 2 | Click the `plan.md` tab | the same items enabled | **pass** — Bold, Italic, Link, Code, Highlight, Strikethrough all `true` |
| 3 | Go ▸ Pin Tab | tab pinned, marker in the strip, item becomes Unpin Tab | **pass** — `01-pinned.png`, Go menu reads "Unpin Tab" |
| 4 | Go ▸ Unpin Tab | back, item reads Pin Tab | **pass** |
| 5 | ⌘N, type "The quick brown fox" | text in an untitled document | **pass** — `03-typed.png` |
| 6 | ⌘Z | the typing undone, change bar gone | **pass** — `04-undone.png` |
| 7 | ⇧⌘Z | back | **pass** — `05-redone.png` |
| 8 | ⌘A, ⌘C, →, ⌘V | the line doubled | **pass** — `06-pasted.png`, so the standard clipboard items still reach the webview |
| 9 | ⌘F, type `quick`, ⌘Z | the *field* cleared, the document untouched | **pass** — `08-find-undo.png` |
| 10 | Open `quit.md`, type at the end, ⌘Q within the 800 ms autosave delay | the app quits **and** the typing is on disk | **pass** — process gone, file ends "And this was typed a moment before the quit." |
| 11 | Relaunch | seven tabs, `quit.md` in Edit mode, status "Saved" | **pass** — `12-relaunched.png` |
| 12 | ⇧⌘N, read the Edit menu | the new empty window's state | **pass** — Bold, Italic, Save all `false` |
| 13 | Raise the document window | the document window's state | **pass** — Bold, Italic `true` again |
| 14 | MD Reader ▸ About MD Reader | name, version, copyright from the bundle | **pass** — `13-about.png`, "MD Reader / Version 0.1.0 (0.1.0) / Copyright © 2026 Victor Zhang" |

Step 10 is the one that matters most, because it is the thing the old menu
could not do. Under `NSApplication.terminate:` — Tauri's default Quit, and
what this app had until now — a keystroke inside the autosave window is
lost: the process is gone before any window is asked for anything. The text
being on disk afterwards is `before_exit` having run, which is only
possible if the quit came through `ExitRequested`.

Steps 12 and 13 are the multi-window case. On macOS the bar belongs to the
application, so it has to be the front window's; each window sends its own
description when it is given the keyboard and stays quiet when it is not.

## Afterwards

The session and settings were restored from `scratchpad/menu/appdata-backup`
and `diff` against the backup is empty. The scratch file `quit.md` lives in
the session scratchpad and is not in the repository.

## Not checked

- **Windows and Linux.** Neither gets a menu bar from this change; the
  shell only asks for one on macOS. Windows is parked for want of a
  machine.
- **A menu open while the window's state changes underneath it.** Rust
  avoids rebuilding the native menu unless the shape of the description
  changed, and the shape is fixed by the registry, so what happens is
  `set_enabled` on an item inside an open menu. AppKit is documented to
  handle that; it was not driven here.
