# ADR 0035: PDF viewing

Status: accepted and built, 2026-09-10. pdf.js behind an engine port, a
PDF as its own kind of tab, and no line of `pdfjs-dist` visible from the
shell. What building it changed is at the end, under "As built".

The design's section 12 lists PDF among the things that wait, and ADR
0029 kept it waiting once already: "Export to PDF or DOCX. HTML export is
cheap and included; the others wait." That sentence is about export. This
is the other half — *reading* one — and it is a different question, because
nothing in the app can show a PDF at all today.

The engine comparison is in [the research
note](https://claude.ai/code/artifact/ab602ac4-b3a9-4fb8-97b8-f460d0a34fad);
the short version is that pdf.js is Apache-2.0 and has no runtime
dependencies at all. The size argument is thinner than the research
note's headline suggests: 2.15 MB is the code, and what this plan ships
is 4.66 MiB — code 1.75, cmaps 1.11, the standard fonts 0.76, 1.02 of
WebAssembly and its JS understudies, and a hundredth of a megabyte of
colour profile — against PDFium's 5.13 MB, which carries its font and
cmap data inside the binary. Half a megabyte of daylight, not three; the
estimate here was 3.96, and the difference is two deliberate additions
made while building it — the JS decoders that let an engine which
refuses WebAssembly degrade rather than fail, and the transpiled build
that WKWebView needs at all. Both are under "As built". The licence
and the dependency count are what decide this; the bytes are close enough
to be a tiebreak. This ADR is about how it goes in.

## The one decision that matters is the seam, not the engine

PDFium renders more faithfully than pdf.js on a narrow class of
documents, and if PDF viewing ever stops being incidental, that class
stops being narrow. So the engine is chosen but not settled, and the
architecture has to make a later swap a matter of writing one file rather
than unpicking the shell.

The app already has the pattern. `Enhancer` is an interface with two
methods that Read mode is handed and never asks about: Shiki, KaTeX and
Mermaid live behind it, tests leave it out, and nothing outside
`read/enhance.ts` knows those three libraries exist. `Updater` is the same
shape, and `assetUrl` and `clipboard` after it. A PDF engine is one more
port on `WorkspaceOptions`, and it earns its place there for exactly the
reason the others did: the shell should not be able to tell which library
is behind it.

## A PDF is not a `Doc`

`Doc` is an `EditorState` with a Lezer tree over it — a buffer, an undo
history, an outline computed from headings, a word count. A PDF has none
of those. It has no source text the reader edits, nothing to autosave,
nothing to hand an agent, and no merge to perform when the file changes
underneath. Making one into a `Doc` would mean a `Doc` whose every field
is a lie.

The app has already met this problem and solved it. Settings open as a
tab rather than a modal (WP 1.9), and the way that was made to work is
`TabKind`: a tab says what it is showing, `docId` is empty for one that
has no document, and every command that acts on text asks `activeDoc`
rather than `activeTab`. `app-commands.ts` says so in a comment at the
top of the list, and `mountRead` guards on `tab?.kind !== 'document'`
before it touches anything.

So a PDF is a third `TabKind`, and the discipline that already protects
the shell from Settings protects it from this too. This is the cheapest
correct answer available, and it is cheap only because the earlier work
paid for it.

## The port

A new directory, `apps/desktop/src/lib/pdf/`, holding the interface and
one implementation of it.

```ts
// pdf/engine.ts — the port. No pdf.js type may appear in this file.

/** A page's intrinsic size, in PDF points (1/72 inch). */
export interface PageSize {
  width: number;
  height: number;
}

/** One bookmark in a document's own table of contents. */
export interface PdfOutlineEntry {
  level: number;
  text: string;
  page: number;
}

export interface RenderRequest {
  /** One-based, the way a PDF numbers its own pages. */
  page: number;
  /** CSS pixels per point, so the caller owns zoom and device ratio. */
  scale: number;
  canvas: HTMLCanvasElement;
  /** A page scrolled out of the window cancels rather than finishing. */
  signal?: AbortSignal;
}

/** A run of text and where it sits, for the selection layer. */
export interface TextRun {
  text: string;
  /** Left, top, width, height, in points from the page's top-left. */
  rect: readonly [number, number, number, number];
}

export interface PdfDocument {
  readonly pages: number;
  size(page: number): Promise<PageSize>;
  render(request: RenderRequest): Promise<void>;
  text(page: number): Promise<TextRun[]>;
  outline(): Promise<PdfOutlineEntry[]>;
  destroy(): void;
}

export interface PdfEngine {
  /** The URL is the asset protocol's; the engine fetches it itself. */
  open(url: string): Promise<PdfDocument>;
  destroy(): void;
}
```

Three properties of that interface are deliberate.

It renders into a canvas the *caller* owns, because the caller is what
knows about virtualization and device pixel ratio, and because both
candidate engines rasterize to a bitmap. It measures in points rather
than pixels, because points are what a PDF is written in and pixels are
what a zoom level makes of them — putting the conversion on one side of
the line keeps the other side honest. And `text()` returns runs with
geometry rather than a rendered DOM layer, because pdf.js's
`TextLayerBuilder` and PDFium's text extraction agree on that shape and
disagree on everything above it.

What the port deliberately does not carry: annotations, forms, editing,
printing, or anything that would make the interface a description of
pdf.js rather than of PDF viewing. A port wide enough to express one
library's whole surface is not a port.

## Only one file may import `pdfjs-dist`

`pdf/pdfjs.ts` implements `PdfEngine` and is the only module in the
repository allowed to name the package. A second implementation would be
`pdf/pdfium.ts` and would touch nothing else.

This is worth enforcing rather than intending, and it is cheap to
enforce: a node test in the `desktop` project that reads the source tree
and asserts `pdfjs-dist` appears in exactly one file. The rule is easy to
break by accident — a type import for convenience, a constant borrowed
from the library — and each break costs nothing until the day the swap is
attempted, when it costs everything.

## How the bytes get there, and the two CSP changes

Most of this is built. `load` widens the asset protocol's scope to the
open file's folder (`allowImagesIn`, one call per folder rather than per
document) and `assetUrl` turns a path into a URL the webview may load.
Reading the bytes across the IPC bridge as base64 is the obvious wrong
answer and the codebase already rejected it for images.

Two things do not survive contact, and both are cheaper to find here than
by running the app.

**The scope call sits inside `load`, which a PDF must not enter.** `load`
is what calls `commands.openDocument` and reads the file as text, so
routing `.pdf` away from it also routes it away from the one call that
makes the asset URL work — and the protocol answers 403, and the pane
stays blank. The PDF path has to widen the scope itself. `openPath`'s
already-open check has the same shape of problem: it compares
`docOf(tab)?.path`, and a PDF tab has no `Doc` to answer with.

**Range requests do not engage, on any platform.** `getNetworkStream`
picks the `fetch`-based stream only for `http(s)`, so `asset://localhost/…`
on macOS and Linux falls to the XHR stream, whose `isHttp` is false — no
`Range` header is ever sent and range support is reported absent. Windows
gets `http://asset.localhost` and does take the fetch path, but Tauri's
asset protocol sends `Accept-Ranges: bytes` only in reply to a request
that already carried a `Range`, and pdf.js decides from the *first*
response, which has none. So the file arrives whole. That is fine at the
sizes a markdown reader meets and not worth fighting; it is worth writing
down, because "a large file pages in" is what everyone assumes. Cap the
size on the way in, the way `read_document` already caps a text file's.
(For whoever revisits it: Tauri caps a single range response at
1000 KiB and truncates the range silently.)

Then the CSP. The current policy is:

```
default-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: asset: http://asset.localhost
```

`asset:` is admitted for `img-src` only. The document is fetched by XHR
or by `fetch` depending on the platform, and both are governed by
`connect-src`, which is not set and therefore falls back to `default-src
'self'` — so the asset protocol is allowed for images and **blocked for
the PDF itself**:

```
+ connect-src 'self' asset: http://asset.localhost;
```

The second change is the one I had wrong first time, so here is the
working:

```
+ script-src 'self' 'wasm-unsafe-eval';
```

pdf.js 6 has four WebAssembly modules — JBIG2, OpenJPEG, qcms and the
QuickJS sandbox — and one API option, `useWasm`, which turns off all of
them together: the worker hands the same `evaluatorOptions` to
`WasmImage`, `IccColorSpace` and `CmykICCBasedCS`. Two of the four ship a
pure-JS fallback. **qcms does not**, and qcms is colour management —
with `useWasm: false`, `IccColorSpace.isUsable` is false, ICCBased
colour spaces drop to their alternates, and DeviceCMYK falls back to the
naive formula. Colour management is one of the two reasons pdf.js 6
renders as well as it does. Turning WebAssembly off to keep the policy
tidy would be trading away the thing we came for.

It is not even cheaper. The two JS fallbacks are 597,293 bytes against
the 453,473 of WebAssembly that then goes unshipped — and they replace
only two of the three, since qcms has no substitute — so the no-WASM
build is 140 KiB *larger* and renders worse. That is the whole
argument.

So: take the WebAssembly and pay for it in one directive. Naming
`script-src` means it governs scripts instead of `default-src`, which is
why `'self'` is in it; nothing else changes, because `default-src 'self'`
was already governing them on the same terms. Tauri only rewrites that
directive when a page has inline scripts to nonce, and Vite's output has
none.

The conclusion holds and half the reasoning does not; see "The colour
management this does not buy" under "As built".

The QuickJS module is a separate matter, and is simply never shipped.

## The view

`PdfPane.svelte` mirrors `ReadPane.svelte` exactly: a host element, a
mount on the active tab, an unmount that saves the reader's place back
onto the tab. Read mode's place is a source offset; a PDF's is a page
number and a fraction down it.

Virtualization follows WP 2.7, and is *easier* here than it was for
markdown. `Heights` — the Fenwick tree in `read/heights.ts` — exists
because a markdown block's height is unknown until it is measured, so the
totals are estimated and then corrected block by block. A PDF page's
height is known exactly from `size(page)` before anything is rendered, so
the same structure is filled once and never corrected. The scroll height
is exact from the first frame, which is a nicer property than Read mode
has ever had.

Rendering is per visible page into a canvas, with the canvas released
when the page leaves the window. `RenderRequest.signal` exists so a fast
scroll abandons work rather than queueing it.

## What the shell shares, and what it must not

Shares: the tab strip, the status bar, the window title, session
restore, and Find — though Find over a PDF searches extracted text and
cannot be the same code path as a CodeMirror search, so it is a later
work package rather than a free one.

Does not share: everything that assumes a buffer. Save, autosave,
history, the diff and merge machinery, the agent round-trip, export, word
count, and every editing command. The `activeDoc` discipline already
turns all of these off for a tab with no document; the work is confirming
that, not building it.

The sidebar's Outline panel is the one genuine integration question. A
PDF has bookmarks, and they are the same idea as headings — but
`OutlineEntry` carries `from` and `to` as *source offsets*, which a PDF
does not have. Overloading `from` as a page number would work and would
be the kind of shortcut that is still being explained two years later.
The honest fix is a discriminated union at the panel's boundary, so the
panel renders a level, a label and a destination, and the destination is
either an offset or a page. That is a small change to a small component
and it is worth making properly.

## Session, and one forward-compatibility repair

`TabKind` lives in `crates/core/src/state.rs` and reaches TypeScript
through specta, so the new variant is a Rust change first:

```rust
pub enum TabKind {
    #[default]
    Document,
    Settings,
    Pdf,
}
```

A PDF tab restores from its path, which `DocumentState` already carries,
and there is no untitled case because a PDF is never created here. But
`TabState.document` is an *index into* `documents`, so a PDF needs an
entry there — and `restore` walks every entry through `restoreDoc`, which
calls `load`, which reads the file as text. `restoreDoc` is therefore the
second place, after `openPaths`, that has to know a PDF when it sees one.
The tab itself is cheap: `Workspace.blankTab(kind, docId, mode)` already
exists and already takes a kind, which is what `openSettings` uses.

Where the reader's place goes needs saying, because `TabState.anchor` is
documented as a source offset and `Tab.anchor` is `{ offset, y }`. A page
number and a fraction down it is not an offset, and writing one into that
field would be the same shortcut this ADR refuses two sections up for
`OutlineEntry.from`. Add a field — `page: Option<u32>` beside `anchor`,
unset for every tab that is not a PDF. `TabState` is `#[serde(default)]`
at the struct level, so a new optional field costs nothing in either
direction.

There is a downgrade hazard worth noticing, though not necessarily worth
fixing now. Session reading moves a file aside and starts fresh when it
will not parse (`state.rs:707`). That is right for corruption, but it
also means an *older* build reading a newer session throws the whole
session away because one tab says `"pdf"` — every other tab with it.

The obvious repair does not work: `#[serde(other)]` is "only allowed on a
unit variant inside of an internally tagged or adjacently tagged enum",
and `TabKind` is a fieldless enum deserialized from a plain string, so it
will not compile. What does work is a lenient field:

```rust
#[serde(deserialize_with = "tab_kind")]
pub kind: TabKind,
```

reading a `String` and matching it, with anything unrecognised falling to
a chosen default. Note that the default cannot be `Document` without
being wrong in a new way — an old build would try to read the PDF as
text. The semantically correct behaviour is to drop the tab, which is a
filter over `Vec<TabState>` after deserialization rather than an
attribute on the field.

Since the updater only moves people forward, this is a nice-to-have
rather than a blocker. It is recorded here so that whoever adds the
*fourth* `TabKind` finds the analysis already done.

## Deliberately not doing

**No file association.** `bundle.fileAssociations` stays as it is. Adding
`pdf` would have the app claim every PDF on the machine and fight Preview
and Acrobat for them, which is not a thing a markdown reader should do to
someone who installed a markdown reader. PDFs open by drag, by Cmd+O, and
by following a link from a document.

**No annotations, forms, or signing.** `enableXfa: false` on
`getDocument` — already the default, set anyway so that it reads as a
decision rather than an oversight. `enableScripting` is *not* a
`getDocument` option, which is worth knowing before someone goes looking
for it: it is a parameter of `AnnotationLayer`, and a PDF's JavaScript
runs in `pdf.sandbox.mjs`, which only the bundled viewer loads. This plan
builds its own pane on the core API with no annotation layer, so there is
no scripting path to disable and `quickjs-eval.wasm` — 469 KB — is never
shipped. That is the durable answer to CVE-2026-16633 (arbitrary
JavaScript from a crafted PDF, High, August 2026, patched in 6.2.108): a
document whose JavaScript is never run cannot exploit it. Make the
single-import test assert the narrower rule while it is there — that the
adapter imports from `pdfjs-dist/build/` only — since importing the
viewer is exactly how this would come back.

**No export.** Still waiting, still for the reasons ADR 0029 gave. A
viewer will make people ask; the answer does not change.

## The work

Beyond the build plan, which ends at Phase 3. The Phase 3 gate is not
passed (ADR 0031), and this should land after it rather than in front of
it — reading a PDF is new capability, and the gate is about the
capability already shipped.

**WP 4.1 — the port and the adapter (4 days).** `pdf/engine.ts`,
`pdf/pdfjs.ts`, and the self-hosted assets — `cmaps/`,
`standard_fonts/`, `iccs/`, `wasm/` — with every URL option pointed at
them. There is no `apps/desktop/public/` yet, so this creates it; a build
step copying from `node_modules` beats committing four megabytes. Both
CSP changes and the single-import test. First, though, before any of it:
WebAssembly running in WKWebView at the macOS 12.0 floor, because the
answer changes the plan. Ends with a headless test that opens a PDF
fixture and asserts page count, page size and extracted text. No UI. This
is the part that can fail for reasons outside the codebase, so it goes
first.

**WP 4.2 — the tab kind (3 days).** The Rust enum, the lenient `kind`
field, the `page` field, the regenerated bindings, `openPaths` routing
`.pdf` the way it already routes images, the asset-scope call the PDF
path now has to make for itself, `openPath`'s already-open check taught
about tabs with no `Doc`, a `PdfDoc` record held beside `Doc`, and save
and restore including `restoreDoc`. Ends with the shell able to open a
PDF tab that renders nothing, and every markdown command correctly
unavailable while it is in front.

**WP 4.3 — the view (4 days).** `PdfPane.svelte`, the page list on
`Heights`, canvas rendering with cancellation, zoom, page number in the
status bar, and the text layer for selection and copy.

**WP 4.4 — the shell (2 days).** Outline from bookmarks with the union at
the panel boundary, Find over extracted text, and
`THIRD-PARTY-NOTICES.md` gaining pdf.js and its bundled decoders — the
project already maintains and ships that file, and Apache-2.0 requires
it.

Thirteen days, and the first four carry nearly all the risk.

## Tests

The existing shape covers this without new infrastructure. `desktop`
(node) takes the path routing, the tab arithmetic, the command guards and
the single-import rule. `desktop-browser` takes the pane, in both
Chromium and WebKit, which is where the CSP and the worker actually get
exercised — and WebKit is the engine that matters, because it is what
ships on macOS. `pdfjs-dist` joins `optimizeDeps.include` in
`vitest.browser.config.ts` beside katex and mermaid, for the same reason
they are there.

A fake `PdfEngine` is a dozen lines and lets every test above run without
the real library, exactly as the tests already run without an `Enhancer`.
Two or three small PDFs are needed for the adapter test — one with
embedded fonts, one with a non-embedded base font, one with CJK text —
and they do not go in `corpus/`. That directory is the markdown
round-trip corpus: `corpus.ts` is "the one list of what the corpus is"
and globs `*.md`, and the README is written throughout about byte-exact
text fixtures. Binary PDFs belong beside the adapter, in
`apps/desktop/src/lib/pdf/fixtures/`.

## As built

Everything above is the plan. This is what building it changed, and it
is kept as a separate section rather than edited in above, because the
difference between what was reasoned and what was measured is the part
worth reading twice.

**The macOS 12 question is answered, and the answer is that it degrades
by itself.** Measured in Playwright's WebKit and Chromium against the
three policies that matter: under the CSP shipping before this, both
engines refuse `WebAssembly.compile`, in the document and in a module
worker. Under the one this adds, both allow it in both. Under the same
policy with the keyword removed — which is what an engine that has never
heard of `'wasm-unsafe-eval'` sees, since CSP ignores a source
expression it does not know — both refuse it again. So the risk was
real: an old WebKit blocks WebAssembly rather than quietly allowing it.

What defuses it costs no code at all. `WasmImage.#instantiateWasm`
catches its own failure and calls `#getJsModule`, which dynamically
imports `jbig2_nowasm_fallback.js` or `openjpeg_nowasm_fallback.js` from
the same directory. Shipping those two beside the `.wasm` files — 0.58
MiB, the difference between the estimate above and what is actually
built — turns "blank pane on an old Mac" into "scanned faxes decode more
slowly on an old Mac", with no build flag, no product decision, and
nothing for anyone to remember. The three escape hatches under Risks are
not needed.

**The modern build does not run on the WebKit that ships.** The first
thing a real Mac said was `_classPrivateFieldGet2(_methodPromises,
this).getOrInsertComputed is not a function`, once per page, with the
paper drawn and nothing on it. `Map.prototype.getOrInsertComputed` is a
2025 addition and macOS's WKWebView does not have it. `build.target:
safari15` cannot help — it rewrites syntax and not missing methods — and
the worker is copied rather than bundled, so nothing in this repository
touches it at all.

So: `pdfjs-dist/legacy/build/`, which carries the core-js polyfills for
exactly this, aliased in `vite.config.ts` for the main thread and named
directly in `pdfjs-assets.ts` for the worker. It costs the 109 KiB the
risk section already priced, and it is not an escape hatch for an old
Mac — it is what this app needs on a current one.

**And the transpiled build is not the end of it.** With the polyfills in,
pages drew and Find found nothing: `getTextContent()` reads its stream
with `for await`, and `ReadableStream` is not async-iterable in that
WebKit, so every page came back with no text and no error the reader
could see. The adapter drains `streamTextContent()` with a reader
instead, which is what the bundled viewer's own text layer does.

**Both of those passed every test in this repository.** Playwright's
WebKit is built from trunk and has `getOrInsertComputed` and an
async-iterable `ReadableStream`; the WebKit macOS ships has neither. The
browser suite is still worth what it was worth — it caught real things
here — but it cannot be the last word on the engine this app actually
runs in, and neither can `build.target`. What found both was opening a
PDF in a bundled build on a real Mac, which took two minutes and should
be the last step of any work package that touches a library this size.

**The colour management this does not buy.** The argument for taking the
WebAssembly was qcms. On the platform this ships to, qcms was never
available. `useWorkerFetch` is computed from
`isValidFetchUrl(cMapUrl, document.baseURI)`, and a bundled Tauri app on
macOS and Linux is served from `tauri://localhost`, which is not
`http(s)`; `QCMS.setOptions` opens with `if (!useWorkerFetch) {
this.#useWasm = false; return; }`, because the only way it has to read
its own module is a synchronous `XMLHttpRequest` that the worker can
only make over `http(s)`. So `IccColorSpace.isUsable` is false there
whatever the CSP says, and `CmykICCBasedCS` with it. Windows gets
`http://tauri.localhost`, and dev and the test runner get plain `http`,
so all three of those keep it.

Forcing `useWorkerFetch: true` would be the obvious answer and is the
wrong one: it moves the cmaps and the standard fonts onto a worker-side
`fetch` of a custom scheme, where the main thread has an
`XMLHttpRequest` fallback and the worker has none. Losing colour
management on one platform beats losing the fonts on it. The option is
deliberately not passed, and pdf.js decides per origin.

The directive is still needed and still right: JBIG2 and OpenJPEG use
the WebAssembly on every platform.

**The worker needs a port rather than a `workerSrc`.**
`PDFWorker._isSameOrigin` returns false when `URL.origin` is the string
`"null"`, which is what a non-special scheme gives — `tauri://localhost`
included. pdf.js reads that as cross-origin, wraps the worker in a
`blob:` URL that `script-src 'self'` then refuses, and falls back to
running the entire worker on the main thread, where every page render
blocks the window. Building the `Worker` ourselves and handing it over
as `PDFWorker.create({ port })` skips the check. It is also what makes
the engine own the worker's lifetime: `getDocument` only destroys a
worker it made itself.

**Three API details the plan named that do not exist.**
`enableScripting` is not a `getDocument` option — already established
above, and confirmed: it is not in `pdf.worker.mjs` either.
`isEvalSupported` is gone from pdf.js 6 entirely, so `enableXfa: false`
is the only flag left that reads as a decision. And `PDFDocumentProxy`
has no `destroy`; teardown is `doc.loadingTask.destroy()`.

**The lenient tab list moved out of the type.** `#[serde(other)]` will
not compile, as the plan says; `#[serde(deserialize_with)]` on
`WindowContent.tabs` compiles and is worse. specta reads it as the wire
type and the Rust type differing and splits every type above it into a
`_Serialize` half and a `_Deserialize` half — `WindowContent`, `Restore`,
and the two commands that carry them — so the generated bindings double
the whole session shape to pay for a repair the frontend never sees.
Annotating it with `#[specta(type = Vec<TabState>)]` does not help. So
the repair sits in `state.rs`'s `read` instead, where the damage is: a
file that will not parse is parsed once more with unrecognised tab kinds
filtered out, and only a file that fails *that* is moved aside. Real
corruption keeps the behaviour it had, which is its own test.

**A PDF is opened when a pane asks for it, not when the tab is made.**
The plan did not say either way. Restoring a session opens none of them:
a session of two hundred tabs ends with the reader in one, and a PDF
that is not being looked at would otherwise be parsed and held whole in
memory for nothing — the same reason `insert` does not focus the tabs it
builds. Opening one by hand still opens it at once, because that is the
reader's own gesture and the page count belongs in the status bar.

**Page sizes are seeded, not all measured.** The plan says the Fenwick
tree is "filled once and never corrected", which is true of the file and
not of the cost: every page's size is a round trip to the worker, so a
thousand-page document would trade a blank window for a scrollbar that
was right from the first frame. Page one is measured on open and stands
in for the rest; each page corrects itself as the view reaches it. For a
document whose pages are all one size — which is most of them — the
first correction is the last.

**The size cap has a command of its own.** `open_pdf` does the two
things a webview cannot: it refuses a file over `PDF_BYTES` (64 MB,
lower than a text document's 100 because a PDF arrives whole and the
renderer's structures sit on top of it), and it widens the asset
protocol's scope to the folder. One round trip, and it is the call the
plan identified as the one `load` would otherwise have made.

**Find over a PDF, as it turned out.** A page is a list of runs, so a
match can begin in one run and end three later. `pdf/find.ts` joins a
page, searches it, and maps the match back to the runs it covers; the
pane marks those in the text layer it already builds for selection. The
walk is one page at a time and every keystroke abandons the one before
it, so the count fills in as it goes and the bar shows `n+` while it is
still going — `capped` doing a second job it turns out to fit. Replace
is not offered, because a PDF is read here and never written.

**What zoom means over a PDF.** Cmd+= and Cmd+- keep their keys and
change what they act on: over a document the reading size, over a PDF
the page. A PDF has no reading size to change — the type in it was set
when the file was made — and two zoom commands for one gesture would be
the shell knowing about `TabKind` in a second place. The percentage in
the status bar is state on the workspace and not a read of the view,
which is a difference of one word and the difference between a cell that
follows the zoom and one that says 100% for the life of the tab.

**Cmd+O had to be told.** "PDFs open by drag, by Cmd+O, and by following
a link from a document" — and the open panel filtered to markdown, so
Cmd+O offered a greyed-out file. A second filter entry rather than four
more extensions on the first: the panel's pop-up is where a reader
narrows the list, and "Markdown" that also means PDF is a lie in a menu.
The save panels are untouched, because a PDF is read here and never
written.

**A PDF tab moves between windows.** The plan said nothing about it and
the first build refused, because `moveTab` has always refused anything
that is not a document — it serializes a buffer, and a PDF has none. It
turns out to be the easy half of that job rather than a missing one:
what travels is the path and the page, the document fields go over
empty, and the window taking it in opens the file itself, which is also
what keeps two windows from holding one copy of it. `TabMove` gains a
`page` beside its `anchor`, for the same reason `TabState` did.

The one thing that needed care is the door. `openPdf` asks the registry
whether another window has the file (design 6.5), and a tab arriving
from another window must not: the window that sent it has not written
its session down yet, so the registry would still say the file is over
there and the tab would be turned away. `takePdf` is `openPdf` without
that question, and the arriving path uses it — which is exactly the
division `adoptTab` already had for documents, since it never asked
either.

**Find marks characters, not runs.** A run is often a whole line, and the
first build marked the line — a paragraph of yellow because five letters
matched. The matched characters are wrapped in a `mark` inside the run's
own span, which costs no layout and so does not disturb the scale the
span was measured at, and the mark blends with `multiply` rather than
sitting on top: the word the reader was looking for is painted on the
canvas underneath, and an opaque highlight hides exactly it.

## Risks

**macOS 12.0 — settled, and not where the trouble was.** An engine that
does not know `'wasm-unsafe-eval'` does block WebAssembly rather than
allow it, which was the bad half of the two possibilities; it costs a
slower JBIG2 and OpenJPEG on that machine and nothing else, because
pdf.js drops to the JS decoders shipped beside the modules by itself.

The floor turned out to matter for something else entirely. pdf.js 6's
modern build needs JavaScript newer than *any* WKWebView macOS has
shipped, so the `legacy` build is not a fallback for old Macs — it is
the only build that runs here. That closes the question the floor was
asking: whatever version of WebKit a reader has, they get the same
transpiled code. See "As built".

**The scope question underneath.** A PDF that is merely viewable is a
fortnight. A PDF that is a first-class document — searched across the
folder, opened by the agent, remembered in history — is a different
project, because every one of those subsystems is written against a text
buffer. This ADR builds the first and is careful not to foreclose the
second; it should not be read as having started it.

**One flaky browser test per full run.** Already true at any commit, and
adding a canvas-rendering pane to that suite will make it harder to tell
a new flake from the old one. Worth pinning down before WP 4.3 rather
than after.
