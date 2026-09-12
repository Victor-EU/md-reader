# ADR 0039: An agent opens a file by showing it to the reader

Status: accepted, 2026-09-12. Adds `open_document` to the MCP server of
ADR 0028: a tab on a file, in a window that comes forward, answered once
the tab is there.

The five tools of ADR 0028 reach only what the app has open. That was
the right scope for reading and writing, and it left one thing out that
an agent doing real work needs on the first turn: a file it has just
written, which the reader has not opened, is invisible to every tool.
The way round it was `open -a Markdown path.md` from a shell, which
works on a Mac, is not the MCP server, and tells the agent nothing about
whether it worked.

## Opening is the scope growing, and it is allowed to

The module docs of `mcp` say why the scope is small: a markdown app's
server has no business being a general file reader. `open_document`
does not make it one. The file it names becomes readable only by
becoming a tab in front of the reader, in a window that takes focus.
That is the same thing a double-clicked file does, and the reader
opening a file is what authorises the other tools on it (ADR 0028, on
the tab half of `writable`). An agent that wants a file it cannot see
has to show it to the reader to get it, which is the right price.

It takes an absolute path to a file that exists. Relative paths are
refused because there is no directory to take them from — the bridge
runs in the client's working directory and the server in the app's, and
neither is the one the agent meant. A path with no file is refused with
"write it first", because the agent that wants a new document has
`write_document` for that and the answer says so.

## It is answered when the tab is there

The routine that opens a double-clicked file, `deliver`, emits an event
and returns. That is right for the operating system, which is not going
to ask a question afterwards, and wrong for an agent, whose next call is
`read_document` on the path it just opened. So the open goes through the
ask-and-answer round trip the other tools use (`AgentRequest::Open`),
and the window answers `Opened` from its own `openPath` once the tab
exists — or `Failed` with the reason the status bar would have shown,
which a model can act on. The five-second timeout of ADR 0028 covers a
window that does not answer at all.

Focus is Rust's to give, after the answer: a tab that opened somewhere
behind the agent's terminal is not in front of anybody.

## Which window

Without a `window`, the routing is `deliver`'s: the window that already
has the file, else the one in front, and a file that is already open
becomes its tab coming forward rather than a second copy. With one, it
is that window unless the file is open elsewhere — a document lives in
one window (design 6.5), so it comes forward where it is and the answer
names that window rather than the one asked for. A label no window
answers to is refused with the labels there are. The labels are not otherwise offered to an agent —
`list_documents` does not say which window a document is in — so the
only way to hold one is to have been given it by an earlier
`open_document`, which is enough for the case it is for: putting the
next file beside the last one.

## What was left

- **Nothing here moves a tab.** A file open in one window and asked
  for in another comes forward where it is. Moving it would be tearing,
  and an agent has no business tearing tabs.
- **Nothing here opens a folder.** A folder workspace is a decision the
  reader makes about what the sidebar shows, and is not on the same
  footing as a file put in front of them.
- **Images** go through `openPath` and fail there, because a lone image
  is imported into a document rather than opened as one. The answer
  says what the status bar would have.
