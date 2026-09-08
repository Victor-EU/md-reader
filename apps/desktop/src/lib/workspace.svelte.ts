import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, Text, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  type AnnotationEdit,
  colorEdit,
  commentEdit,
  type EditorMode,
  highlightEdit,
  lineChanges,
  setChanges,
  setModeEffect,
  strikethroughEdit,
} from '@mdreader/editor-core';
import type {
  Commands,
  DocumentMeta,
  DocumentState,
  ExternalChange,
  FileFormat,
  FileRemoved,
  FileRenamed,
  PositionEdit,
  Settings,
  WindowContent,
} from '@mdreader/ipc';
import {
  type AnnotationKind,
  copyForAi,
  extractAnnotations,
  headings,
  type ImageResolver,
  type OutlineEntry,
  type PaletteMeaning,
  parser,
  renderDocument,
  toHtml,
} from '@mdreader/markdown';
import { type ClipboardWriter, copyRich, copyText } from './clipboard.ts';
import { Doc, nextId } from './document.svelte.ts';
import { imageResolver } from './images.ts';
import { basename, dirname, shortenDir, tabLabels } from './paths.ts';
import type { Enhancer } from './read/enhance.ts';
import { ReadView } from './read/view.ts';
import { count, countWords, describeError, describeFormat } from './text.ts';

/** The three projections of one buffer (design 4.2). */
export type ViewMode = EditorMode | 'read';

/**
 * Where the next mount should put the document: the source offset to show,
 * and how far down the pane to put it. A mode switch keeps the reader in
 * the same place even though the two views measure in different units.
 */
export interface Anchor {
  offset: number;
  y: number;
}

/** One tab: a view onto a document, with the state that is per view. */
export interface Tab {
  id: string;
  docId: string;
  mode: ViewMode;
  pinned: boolean;
  selection: EditorSelection;
  scrollTop: number;
  anchor: Anchor | null;
  /** Heading ids folded in Read mode, kept while the tab is open. */
  folded: string[];
}

interface ClosedTab {
  tab: Tab;
  doc: Doc;
  index: number;
}

export type PaletteKind = 'files' | 'commands';

export interface FileChoice {
  label: string;
  detail: string;
  /** Set when the file is already open: choosing it focuses that tab. */
  tabId: string | null;
  path: string | null;
}

export interface WorkspaceOptions {
  commands: Commands;
  /** The OS open panel — one of the two dialogs design 4.5 allows. */
  pickFiles?: () => Promise<string[]>;
  /** The OS save panel, for the first save of an untitled document. */
  pickSaveTarget?: (suggested: string) => Promise<string | null>;
  /** Opens a link in the system browser; the webview never navigates. */
  openExternal?: (url: string) => void;
  /** Shiki, KaTeX and Mermaid. Left out in tests, which do not need them. */
  enhancer?: Enhancer;
  /**
   * Turns a local file path into a URL the webview may load, which under
   * Tauri is the asset protocol. Without it no local image loads, which
   * is what a browser build and the tests want.
   */
  assetUrl?: (path: string) => string;
  /** Where copies go. The system clipboard unless a test says otherwise. */
  clipboard?: ClipboardWriter;
}

/** What a file we create ourselves looks like until the user says otherwise. */
const NEW_FILE_FORMAT: FileFormat = {
  eol: 'lf',
  mixed_eol: false,
  bom: false,
  trailing_newline: false,
  encoding: 'utf-8',
};

const CLOSED_LIMIT = 20;
const RECENTS_LIMIT = 50;
/** Long enough that a fast typist counts once per pause, not once per key. */
const WORD_COUNT_DELAY = 250;
/**
 * The same idea for the change gutter. The markers are mapped through
 * every edit as it happens, so what waits here is only the diff that
 * decides which runs there are.
 */
const CHANGE_SCAN_DELAY = 300;
/** How long the outline may wait for the parser before showing what there is. */
const OUTLINE_TIMEOUT = 30;
/**
 * How long the session waits when what changed was typing into an
 * untitled document, whose whole text it has to carry. Long enough that
 * a sentence is one push rather than forty.
 *
 * Everything else — a tab, a mode, a pin — is pushed at the end of the
 * turn instead, because on macOS a Cmd+Q reaches the app only as
 * `RunEvent::Exit`, far too late to ask the window for anything. What
 * the window has already said is all that survives that, so it should be
 * as close to the truth as it can cheaply be.
 */
const SESSION_DELAY = 500;

/** What the app starts with until a launch says otherwise (design 6.6). */
const DEFAULT_SETTINGS: Settings = { autosave: true };

/** `Untitled 3` -> 3, so a new document does not reuse a restored name. */
function untitledNumber(name: string): number {
  const digits = /(\d+)$/.exec(name);
  return digits === null ? 0 : Number(digits[1]);
}

/**
 * The window's state: which documents are open, which tabs show them,
 * which tab is in front, and the one editor view that is mounted for it.
 * Everything the shell can do to a document goes through here, so the
 * command registry, the palette, and the components all share one path.
 */
export class Workspace {
  tabs = $state<Tab[]>([]);
  activeId = $state<string | null>(null);
  recents = $state<string[]>([]);
  /** Message line in the status bar. There are no dialogs (build plan rule 5). */
  status = $state('');
  words = $state(0);
  saving = $state(false);
  sidebar = $state(false);
  /** Whether Read mode shows the comments it folds away (design 4.3). */
  comments = $state(false);
  /**
   * The reader's preferences, as the launch found them (WP 1.8).
   *
   * Nothing acts on them yet: `autosave` is the one the design names and
   * WP 1.11 is what reads it, WP 1.9 is what fills in theme and
   * typography. What this work package owes them is the file, the round
   * trip, and somewhere current to live.
   */
  settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  outline = $state<OutlineEntry[]>([]);
  /** False while a long document is still being parsed in the background. */
  outlineComplete = $state(true);
  palette = $state<{ open: boolean; kind: PaletteKind; query: string; index: number }>({
    open: false,
    kind: 'files',
    query: '',
    index: 0,
  });

  private readonly docs = new Map<string, Doc>();
  private closed = $state<ClosedTab[]>([]);
  private mounted: { view: EditorView; tab: Tab } | null = null;
  private reading: { view: ReadView; tab: Tab } | null = null;
  private untitledCount = 0;
  private epoch = $state(0);
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionDelay = 0;

  constructor(readonly options: WorkspaceOptions) {}

  activeTab: Tab | null = $derived(this.tabs.find((tab) => tab.id === this.activeId) ?? null);
  activeDoc: Doc | null = $derived(this.activeTab ? this.doc(this.activeTab) : null);
  /** What the Changes badge counts: runs the reader has not marked seen. */
  unreviewed: number = $derived(this.activeDoc?.changes.length ?? 0);
  /** Tab labels, disambiguated against each other. */
  labels: string[] = $derived(
    tabLabels(
      this.tabs.map((tab) => this.doc(tab).path),
      this.tabs.map((tab) => this.doc(tab).untitledName),
    ),
  );
  canReopen: boolean = $derived(this.closed.length > 0);
  /**
   * What the mounted view is built from. It changes when another tab comes
   * to the front, and when a document's buffer is replaced under one.
   */
  mountKey: string | null = $derived(
    this.activeId === null ? null : `${this.activeId}:${this.epoch}`,
  );
  /** Read mode is a different view, so it is a different mount. */
  readMode: boolean = $derived(this.activeTab?.mode === 'read');

  doc(tab: Tab): Doc {
    const doc = this.docs.get(tab.docId);
    if (!doc) throw new Error(`tab ${tab.id} has no document`);
    return doc;
  }

  // --- opening ------------------------------------------------------------

  /** Cmd+O, drag and drop, and the OS open events of WP 1.8 all land here. */
  async openPaths(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.openPath(path);
  }

  async openPath(path: string): Promise<boolean> {
    const open = this.tabs.find((tab) => this.doc(tab).path === path);
    if (open) {
      this.activate(open.id);
      return true;
    }
    const opened = await this.load(path);
    if (opened === null) return false;
    this.addTab(opened.doc);
    this.remember(path);
    const { meta } = opened;
    this.status = meta.read_only
      ? `${basename(path)} is ${meta.format.encoding}; convert to UTF-8 to edit`
      : `${basename(path)} · ${describeFormat(meta.format)}`;
    return true;
  }

  /**
   * Read a file and take charge of it: images from its folder, a watch
   * on it, and a snapshot of what it held when we found it, which is the
   * version a restore goes back to (design 4.4). Opening a file and
   * putting one back at launch both start here.
   */
  private async load(path: string): Promise<{ doc: Doc; meta: DocumentMeta } | null> {
    const result = await this.options.commands.openDocument(path);
    if (result.status === 'error') {
      this.status = describeError(result.error);
      return null;
    }
    const { content, meta } = result.data;
    const doc = this.newDoc(content, { path, meta });
    // Images in this document resolve against its folder, so Rust is told
    // to let the webview read that folder and below (design 8).
    void this.options.commands.allowDocumentImages(path);
    void this.options.commands.watch(path);
    void this.options.commands.snapshot(path, content, 'user');
    return { doc, meta };
  }

  async pickAndOpen(): Promise<void> {
    const picked = (await this.options.pickFiles?.()) ?? [];
    await this.openPaths(picked);
  }

  newUntitled(): void {
    this.untitledCount += 1;
    const doc = this.newDoc('', { untitledName: `Untitled ${this.untitledCount}` });
    // A file opens in Read (design 4.2), but an empty one has nothing to read.
    this.addTab(doc, 'edit');
  }

  /**
   * A document with this window's rendering rules attached. Every widget
   * and every rendered image asks the document itself, so a toggle takes
   * effect on the next draw without rebuilding any editor state.
   */
  private newDoc(
    text: string,
    options: { path?: string; meta?: DocumentMeta; untitledName?: string },
  ): Doc {
    const doc = new Doc(text, {
      ...options,
      preview: (owner) => ({
        enhance: this.options.enhancer,
        image: this.imageRules(owner),
      }),
    });
    this.docs.set(doc.id, doc);
    return doc;
  }

  /** Design 8's rules for one document, read afresh on every image. */
  private imageRules(doc: Doc): ImageResolver {
    return imageResolver(() => ({
      path: doc.path,
      remote: doc.remoteImages,
      assetUrl: this.options.assetUrl,
    }));
  }

  /**
   * Let this document load images from the network, or stop it (design 8).
   * The views are remounted rather than patched: an image that was blocked
   * has no element to fill in.
   */
  toggleRemoteImages(): void {
    const tab = this.activeTab;
    if (!tab) return;
    const doc = this.doc(tab);
    doc.remoteImages = !doc.remoteImages;
    this.syncMounted();
    this.unmount();
    this.unmountRead();
    this.epoch += 1;
    this.status = doc.remoteImages
      ? `Loading remote images in ${doc.label}`
      : `Remote images blocked in ${doc.label}`;
  }

  /** A second view onto the same document; undo is shared through its state. */
  duplicateView(): void {
    const tab = this.activeTab;
    if (!tab) return;
    // The live cursor lives in the view until the tab gives it up.
    this.syncMounted();
    const copy = this.addTab(this.doc(tab), tab.mode);
    copy.selection = tab.selection;
  }

  private addTab(doc: Doc, mode: ViewMode = 'read', at?: number): Tab {
    const tab: Tab = {
      id: nextId('tab'),
      docId: doc.id,
      mode,
      pinned: false,
      selection: EditorSelection.single(0),
      scrollTop: 0,
      anchor: null,
      folded: [],
    };
    const pinned = this.pinnedCount();
    const index = Math.min(Math.max(at ?? this.tabs.length, pinned), this.tabs.length);
    this.tabs.splice(index, 0, tab);
    this.activate(tab.id);
    this.touch();
    return this.tabs[index] as Tab;
  }

  private remember(path: string): void {
    this.recents = [path, ...this.recents.filter((p) => p !== path)].slice(0, RECENTS_LIMIT);
    this.touch();
  }

  // --- tabs ---------------------------------------------------------------

  activate(id: string | null): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.countNow();
    this.touch();
  }

  /** Cmd+1..8 jump to that tab, Cmd+9 to the last one, as browsers do. */
  activateIndex(n: number): void {
    const tab = n >= 9 ? this.tabs.at(-1) : this.tabs[n - 1];
    if (tab) this.activate(tab.id);
  }

  cycle(delta: number): void {
    if (this.tabs.length === 0) return;
    const at = this.tabs.findIndex((tab) => tab.id === this.activeId);
    const next = (at + delta + this.tabs.length) % this.tabs.length;
    this.activate((this.tabs[next] as Tab).id);
  }

  close(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const tab = this.tabs[index] as Tab;
    const doc = this.doc(tab);
    const wasActive = this.activeId === tab.id;
    if (wasActive) {
      this.unmount();
      this.unmountRead();
    }
    this.tabs.splice(index, 1);
    this.closed = [{ tab: { ...tab }, doc, index }, ...this.closed].slice(0, CLOSED_LIMIT);
    if (!this.tabs.some((other) => other.docId === doc.id)) {
      this.docs.delete(doc.id);
      if (doc.path !== null) void this.options.commands.unwatch(doc.path);
    }
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.countNow();
    }
    this.touch();
    // No dialog asks about unsaved work; the buffer is kept and can be reopened.
    this.status = doc.dirty
      ? `Closed ${doc.label} with unsaved changes · reopen the tab to get them back`
      : `Closed ${doc.label}`;
  }

  closeActive(): void {
    if (this.activeId) this.close(this.activeId);
  }

  reopenClosed(): void {
    const [record, ...rest] = this.closed;
    if (!record) return;
    this.closed = rest;
    this.docs.set(record.doc.id, record.doc);
    // Closing the last tab on a document stopped the watch; reopening it
    // starts one again.
    if (record.doc.path !== null) void this.options.commands.watch(record.doc.path);
    const tab: Tab = { ...record.tab, id: nextId('tab') };
    this.tabs.splice(Math.min(record.index, this.tabs.length), 0, tab);
    this.activate(tab.id);
    this.touch();
    this.status = `Reopened ${record.doc.label}`;
  }

  /** Drag to reorder. Pinned tabs keep their block at the front of the strip. */
  move(from: number, to: number): void {
    const tab = this.tabs[from];
    if (!tab || to === from) return;
    const pinned = this.pinnedCount();
    const [low, high] = tab.pinned ? [0, pinned - 1] : [pinned, this.tabs.length - 1];
    const target = Math.min(Math.max(to, low), high);
    this.tabs.splice(from, 1);
    this.tabs.splice(target, 0, tab);
    this.touch();
  }

  togglePin(id: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;
    const tab = this.tabs[index] as Tab;
    tab.pinned = !tab.pinned;
    this.tabs.splice(index, 1);
    // Pinning moves the tab to the end of the pinned block; unpinning to
    // the start of the rest. Both are the same index.
    this.tabs.splice(this.pinnedCount(), 0, tab);
    this.touch();
  }

  private pinnedCount(): number {
    return this.tabs.filter((tab) => tab.pinned).length;
  }

  // --- modes and the editor view ------------------------------------------

  setMode(mode: ViewMode): void {
    const tab = this.activeTab;
    if (!tab || tab.mode === mode) return;
    // Read is a different view; Edit and Source are the same view
    // reconfigured, which is what keeps switching between them instant.
    if (tab.mode === 'read') this.unmountRead();
    else if (mode === 'read') this.syncMounted();
    tab.mode = mode;
    if (mode !== 'read') this.mounted?.view.dispatch({ effects: setModeEffect(mode) });
    if (mode !== 'read' && this.sidebar) this.refreshOutline();
    this.touch();
  }

  get view(): EditorView | null {
    return this.mounted?.view ?? null;
  }

  get readView(): ReadView | null {
    return this.reading?.view ?? null;
  }

  /** Give the keyboard back to whichever view is in front. */
  focusEditor(): void {
    if (this.reading) this.reading.view.focus();
    else this.mounted?.view.focus();
  }

  /** Mount the active tab's view. The component calls this from an effect. */
  mount(parent: HTMLElement): void {
    const tab = this.activeTab;
    if (!tab || this.mounted || tab.mode === 'read') return;
    const doc = this.doc(tab);
    const view: EditorView = new EditorView({
      state: doc.state,
      parent,
      dispatchTransactions: (trs) => this.applyTransactions(view, trs),
    });
    this.mounted = { view, tab };
    view.dispatch({
      selection: tab.selection,
      effects: [setModeEffect(tab.mode), setChanges.of(doc.changes)],
    });
    const anchor = tab.anchor;
    if (anchor) {
      // Put the same source offset where the reader last saw it, rather
      // than at a scroll position measured in another view's pixels.
      view.dispatch({
        effects: EditorView.scrollIntoView(Math.min(anchor.offset, view.state.doc.length), {
          y: 'start',
          yMargin: anchor.y,
        }),
      });
      tab.anchor = null;
    } else {
      view.scrollDOM.scrollTop = tab.scrollTop;
    }
    view.focus();
  }

  /** Mount Read mode for the active tab. */
  mountRead(parent: HTMLElement): void {
    const tab = this.activeTab;
    if (!tab || this.reading || tab.mode !== 'read') return;
    const doc = this.doc(tab);
    const view = new ReadView({
      parent,
      state: doc.state,
      folded: tab.folded,
      enhance: this.options.enhancer,
      onEdit: (offset, y) => this.editAt(offset, y),
      onOutline: (entries, complete) => {
        this.outline = entries;
        this.outlineComplete = complete;
      },
      onFolded: (ids) => {
        tab.folded = ids;
      },
      onLink: (href, external) => this.openLink(href, external),
      comments: this.comments,
      render: { image: this.imageRules(doc) },
    });
    this.reading = { view, tab };
    view.scrollToOffset(tab.anchor?.offset ?? tab.selection.main.head);
    tab.anchor = null;
  }

  /** Save what Read mode knows onto its tab and drop it. */
  unmountRead(): void {
    const reading = this.reading;
    if (!reading) return;
    const tab = this.tabs.find((other) => other.id === reading.tab.id);
    if (tab) {
      tab.anchor = { offset: reading.view.topOffset(), y: 0 };
      tab.folded = reading.view.foldedIds;
    }
    this.reading = null;
    reading.view.destroy();
    this.touch();
  }

  /** A click in Read mode: the same buffer, at the character clicked. */
  editAt(offset: number, y = 0): void {
    const tab = this.activeTab;
    if (!tab) return;
    const doc = this.doc(tab);
    const at = Math.max(0, Math.min(offset, doc.state.doc.length));
    this.unmountRead();
    tab.selection = EditorSelection.single(at);
    tab.anchor = { offset: at, y };
    tab.mode = 'edit';
    this.touch();
  }

  /** Copy what the live view knows back onto the tab that owns it. */
  private syncMounted(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    const tab = this.tabs.find((other) => other.id === mounted.tab.id);
    if (tab) {
      tab.selection = mounted.view.state.selection;
      tab.scrollTop = mounted.view.scrollDOM.scrollTop;
      tab.anchor = { offset: this.topOfView(mounted.view), y: 0 };
    }
    const doc = this.docs.get(mounted.tab.docId);
    if (doc) doc.state = mounted.view.state;
  }

  /** The source offset at the top of a mounted editor's viewport. */
  private topOfView(view: EditorView): number {
    const rect = view.scrollDOM.getBoundingClientRect();
    return (
      view.posAtCoords({ x: rect.left + 4, y: rect.top + 4 }) ?? view.state.selection.main.head
    );
  }

  /** Save the view state back onto its tab and drop the view. */
  unmount(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    this.syncMounted();
    this.mounted = null;
    mounted.view.destroy();
    // The cursor and the scroll position have just come back off the
    // view, so this is where the session learns about them.
    this.touch();
  }

  private applyTransactions(view: EditorView, trs: readonly Transaction[]): void {
    view.update(trs);
    const mounted = this.mounted;
    if (!mounted) return;
    const doc = this.docs.get(mounted.tab.docId);
    if (!doc) return;
    doc.state = view.state;
    let changed = false;
    for (const tr of trs) {
      if (!tr.docChanged) continue;
      changed = true;
      // Tabs that are not mounted keep their own cursor; map it through.
      for (const other of this.tabs) {
        if (other.id !== mounted.tab.id && other.docId === doc.id) {
          other.selection = other.selection.map(tr.changes);
        }
      }
    }
    if (changed) {
      this.scheduleWordCount();
      this.scheduleChangeScan();
      // Only a document with no file has text the session has to carry.
      if (doc.path === null) this.touchSoon();
    }
  }

  // --- saving -------------------------------------------------------------

  get canSave(): boolean {
    const doc = this.activeDoc;
    return doc !== null && !doc.meta?.read_only;
  }

  async save(retrying = false): Promise<boolean> {
    const doc = this.activeDoc;
    if (!doc) return false;
    if (doc.meta?.read_only) {
      this.status = `${doc.label} is ${doc.meta.format.encoding}; convert to UTF-8 to edit`;
      return false;
    }
    let path = doc.path;
    if (path === null) {
      path = (await this.options.pickSaveTarget?.(`${doc.untitledName}.md`)) ?? null;
      if (path === null) return false;
    }
    const written = doc.state.doc;
    const format = doc.meta?.format ?? NEW_FILE_FORMAT;
    // An untitled document has never been watched; one that just got its
    // name has to be, from this save on.
    const wasWatched = doc.path !== null;
    this.saving = true;
    const result = await this.options.commands.saveDocument(
      path,
      written.toString(),
      doc.meta?.hash ?? null,
      format,
    );
    this.saving = false;
    if (result.status === 'error') {
      // Somebody wrote to the file between our last look and this save.
      // The design says the reader never sees that (7.2): their write is
      // merged in and the save is tried once more.
      if (result.error.kind === 'hash_mismatch' && !retrying) {
        const fresh = await this.options.commands.openDocument(path);
        if (fresh.status === 'ok') {
          await this.externalChange({
            path,
            content: fresh.data.content,
            hash: fresh.data.meta.hash,
            changes: [],
          });
          const merged = this.status;
          if (await this.save(true)) {
            this.status = `${this.status} · ${merged}`;
            return true;
          }
          return false;
        }
      }
      this.status = describeError(result.error);
      return false;
    }
    doc.path = path;
    doc.meta = {
      path,
      byte_len: result.data.byte_len,
      modified_ms: result.data.modified_ms,
      hash: result.data.hash,
      read_only: false,
      format,
    };
    doc.markSaved(written);
    this.pushChanges(doc);
    this.remember(path);
    // A save is a version too, and the one a later restore compares with.
    void this.options.commands.snapshot(path, written.toString(), 'user');
    if (!wasWatched) void this.options.commands.watch(path);
    this.status = `Saved ${basename(path)}`;
    return true;
  }

  /** A non-UTF-8 file opens read-only; this rewrites it and reopens it. */
  async convertToUtf8(): Promise<boolean> {
    const doc = this.activeDoc;
    const tab = this.activeTab;
    if (!doc?.path || !tab) return false;
    const result = await this.options.commands.convertDocumentToUtf8(doc.path);
    if (result.status === 'error') {
      this.status = describeError(result.error);
      return false;
    }
    this.unmount();
    this.unmountRead();
    doc.replace(result.data.content, tab.mode === 'read' ? 'edit' : tab.mode);
    doc.meta = result.data.meta;
    tab.selection = EditorSelection.single(0);
    this.epoch += 1;
    this.status = `Converted ${basename(doc.path)} to UTF-8`;
    return true;
  }

  // --- writes by other people ---------------------------------------------

  private docFor(path: string): Doc | null {
    for (const doc of this.docs.values()) if (doc.path === path) return doc;
    return null;
  }

  /**
   * Somebody else wrote to a file that is open here (design 7.2).
   *
   * A clean buffer takes the whole write. A dirty one keeps the reader's
   * edit and takes the hunks only they touched, as one transaction, so
   * the cursor, the scroll position, the folds and the undo history all
   * map through. A hunk both sides changed keeps the version in the
   * buffer and is set aside with a snapshot of theirs, so nothing is
   * lost while Phase 1 has no way to show both (WP 2.1).
   *
   * There is no dialog anywhere in this, which is the point of it.
   *
   * The merge always runs, and always against this side's own base. The
   * watcher sends the edits it worked out from the file it last read,
   * but the buffer is not always that file: saving restores the stored
   * form, so a document the reader stripped the last newline from sits
   * on disk with one. A clean buffer merged against its own base is the
   * whole write, which is how case 1 of design 7.2 falls out of case 2
   * instead of being written a second time.
   */
  async externalChange(change: ExternalChange): Promise<void> {
    const doc = this.docFor(change.path);
    if (!doc) return;
    const merged = await this.options.commands.merge3(
      doc.base.toString(),
      doc.text,
      change.content,
    );
    const edits = merged.changes;
    const conflicts = merged.conflicts.length;
    // What arrived is kept whatever we do with it, so a hunk set aside is
    // in the history rather than gone (design 4.4).
    void this.options.commands.snapshot(change.path, change.content, 'external');
    this.applyExternal(doc, edits);
    // Their version is the file now, so it is what the next merge and the
    // next save compare against.
    doc.base = Text.of(change.content.split('\n'));
    doc.missing = false;
    if (doc.meta) doc.meta = { ...doc.meta, hash: change.hash };
    this.pushChanges(doc);
    const name = basename(change.path);
    this.status =
      conflicts > 0
        ? `${name} changed on disk · ${count(conflicts, 'conflicting change')} set aside, your version kept`
        : edits.length === 0
          ? `${name} changed on disk`
          : `${name} changed on disk · ${count(edits.length, 'change')} merged in`;
  }

  /** Apply an external write to a document, wherever it is being shown. */
  private applyExternal(doc: Doc, edits: readonly PositionEdit[]): void {
    if (edits.length === 0) return;
    const changes = edits.map((edit) => ({
      from: edit.from,
      to: edit.to,
      insert: edit.insert,
    }));
    const mounted = this.mounted;
    if (mounted && mounted.tab.docId === doc.id) {
      // Through the view, which is what maps the cursor and the folds.
      mounted.view.dispatch({ changes, userEvent: 'external.change' });
      return;
    }
    // Read mode has no editor to dispatch to, so the buffer is updated
    // and the page is rendered again from it.
    const reading = this.reading?.tab.docId === doc.id;
    if (reading) this.unmountRead();
    const transaction = doc.state.update({ changes, userEvent: 'external.change' });
    doc.state = transaction.state;
    for (const tab of this.tabs) {
      if (tab.docId !== doc.id) continue;
      tab.selection = tab.selection.map(transaction.changes);
      if (tab.anchor) {
        tab.anchor = { ...tab.anchor, offset: transaction.changes.mapPos(tab.anchor.offset) };
      }
    }
    if (reading) this.epoch += 1;
  }

  /**
   * The file is gone. The buffer is the only copy now, so it stays; the
   * next save writes the file again (design 8).
   */
  fileRemoved(event: FileRemoved): void {
    const doc = this.docFor(event.path);
    if (!doc) return;
    doc.missing = true;
    this.status = `${basename(event.path)} is no longer on disk · saving writes it again`;
  }

  /** The same document under another name: the tab follows it. */
  fileRenamed(event: FileRenamed): void {
    const doc = this.docFor(event.from);
    if (!doc) return;
    doc.path = event.to;
    if (doc.meta) doc.meta = { ...doc.meta, path: event.to };
    this.remember(event.to);
    // The watcher follows the file itself when it can see where it went.
    // Asking again costs a read and covers the case where it could not.
    void this.options.commands.watch(event.to);
    this.status = `${basename(event.from)} is now ${basename(event.to)}`;
  }

  // --- what the reader has seen -------------------------------------------

  /** Everything in the buffer has been looked at (design 4.4). */
  markReviewed(): void {
    const doc = this.activeDoc;
    if (!doc) return;
    doc.markReviewed();
    this.pushChanges(doc);
    this.status = 'Marked as reviewed';
  }

  /**
   * Work out the change runs and hand them to the gutter.
   *
   * The line diff of Phase 1 is replaced by the semantic engine of WP 2.2
   * behind this call: what the gutter is given is a list of runs either
   * way, and in Phase 2 it arrives from Rust a moment later instead of
   * from here at once.
   */
  private pushChanges(doc: Doc): void {
    doc.changes = lineChanges(doc.reviewed, doc.state.doc);
    const mounted = this.mounted;
    if (mounted && mounted.tab.docId === doc.id) {
      mounted.view.dispatch({ effects: setChanges.of(doc.changes) });
    }
  }

  private scheduleChangeScan(): void {
    if (this.changeTimer !== null) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const doc = this.activeDoc;
      if (doc) this.pushChanges(doc);
    }, CHANGE_SCAN_DELAY);
  }

  // --- annotations --------------------------------------------------------

  /** Show or fold away the comments in Read mode. A reading preference, not a document one. */
  toggleComments(): void {
    this.comments = !this.comments;
    this.reading?.view.setComments(this.comments);
    this.touch();
    this.status = this.comments ? 'Showing comments' : 'Comments folded away';
  }

  /**
   * Apply one annotation command (design 4.3) to the document in front,
   * from whichever view is showing it.
   *
   * In Edit and Source the editor has the selection and dispatches. In
   * Read there is no editor, so the reader's selection in the page is
   * turned into a source range and the plan is applied to the document's
   * own state; the buffer, and its undo history, are the same either way.
   *
   * `type` says the command leaves the reader with something to write —
   * a comment, or the reason behind a colour — which is the one case
   * worth taking them out of Read mode for.
   */
  private annotate(plan: (state: EditorState) => AnnotationEdit | null, type: boolean): boolean {
    const tab = this.activeTab;
    if (!tab) return false;
    const doc = this.doc(tab);
    if (doc.meta?.read_only) {
      this.status = `${doc.label} is read-only`;
      return false;
    }
    const view = this.mounted?.view;
    if (view) {
      const edit = plan(view.state);
      if (!edit) return false;
      view.dispatch(view.state.update({ ...edit, userEvent: 'input.annotate' }));
      view.focus();
      return true;
    }
    const reading = this.reading?.view;
    const range = reading?.sourceSelection();
    if (!reading || !range) {
      this.status = 'Select the text to annotate';
      return false;
    }
    const based = doc.state.update({
      selection: EditorSelection.range(range.from, range.to),
    }).state;
    const edit = plan(based);
    if (!edit) return false;
    doc.state = based.update({ ...edit, userEvent: 'input.annotate' }).state;
    const at = doc.state.selection.main.head;
    this.unmountRead();
    if (type) {
      tab.mode = 'edit';
      tab.selection = EditorSelection.single(at);
      tab.anchor = { offset: at, y: 0 };
    }
    this.epoch += 1;
    return true;
  }

  highlight(): boolean {
    return this.annotate(highlightEdit, false);
  }

  strikethrough(): boolean {
    return this.annotate(strikethroughEdit, false);
  }

  color(meaning: PaletteMeaning): boolean {
    return this.annotate((state) => colorEdit(state, meaning), true);
  }

  comment(kind: AnnotationKind): boolean {
    return this.annotate((state) => commentEdit(state, kind), true);
  }

  // --- the clipboard ------------------------------------------------------

  /** The selected source, or the whole document when nothing is selected. */
  private selectedSource(): string {
    const doc = this.activeDoc;
    if (!doc) return '';
    const range = this.mounted?.view.state.selection.main ?? this.reading?.view.sourceSelection();
    if (!range || range.from >= range.to) return doc.text;
    return doc.state.doc.sliceString(range.from, range.to);
  }

  async copyMarkdown(): Promise<boolean> {
    const source = this.selectedSource();
    if (source === '') return false;
    const ok = await copyText(source, this.options.clipboard ?? navigator.clipboard);
    this.status = ok ? 'Copied as markdown' : 'Could not reach the clipboard';
    return ok;
  }

  /** The same renderer Read mode uses, so what is pasted is what was on screen. */
  async copyRichText(): Promise<boolean> {
    const source = this.selectedSource();
    if (source === '') return false;
    const html = toHtml(renderDocument(parser.parse(source), source), { ranges: false });
    const ok = await copyRich(html, source, this.options.clipboard ?? navigator.clipboard);
    this.status = ok ? 'Copied as rich text' : 'Could not reach the clipboard';
    return ok;
  }

  /**
   * Copy for AI (design 4.3): the whole document, then the generated list
   * of what the reader marked. The list is about the document, so this one
   * ignores the selection.
   */
  async copyForAi(): Promise<boolean> {
    const doc = this.activeDoc;
    if (!doc) return false;
    const source = doc.text;
    const found = extractAnnotations(parser.parse(source), source);
    const ok = await copyText(
      copyForAi(source, found),
      this.options.clipboard ?? navigator.clipboard,
    );
    this.status = ok
      ? found.length === 0
        ? 'Copied for AI · no annotations'
        : `Copied for AI · ${count(found.length, 'annotation')}`
      : 'Could not reach the clipboard';
    return ok;
  }

  // --- the palette --------------------------------------------------------

  openPalette(kind: PaletteKind): void {
    this.palette = { open: true, kind, query: '', index: 0 };
  }

  closePalette(): void {
    if (!this.palette.open) return;
    this.palette = { ...this.palette, open: false };
    this.focusEditor();
  }

  /** Open tabs first, then the recents that are not open (build plan, WP 1.3). */
  fileChoices(): FileChoice[] {
    const choices: FileChoice[] = this.tabs.map((tab, i) => {
      const doc = this.doc(tab);
      return {
        label: this.labels[i] ?? doc.label,
        detail: doc.path === null ? 'not saved yet' : shortenDir(dirname(doc.path)),
        tabId: tab.id,
        path: doc.path,
      };
    });
    const open = new Set(choices.map((choice) => choice.path));
    for (const path of this.recents) {
      if (open.has(path)) continue;
      choices.push({
        label: basename(path),
        detail: shortenDir(dirname(path)),
        tabId: null,
        path,
      });
    }
    return choices;
  }

  async chooseFile(choice: FileChoice): Promise<void> {
    this.closePalette();
    if (choice.tabId) this.activate(choice.tabId);
    else if (choice.path) await this.openPath(choice.path);
  }

  // --- the outline and the sidebar ----------------------------------------

  toggleSidebar(): void {
    this.sidebar = !this.sidebar;
    if (this.sidebar) this.refreshOutline();
    this.touch();
  }

  /**
   * The outline of the active document. Read mode reports it as it renders;
   * in the other two modes it is a walk of the same parse, which for a long
   * document may not have reached the end yet — hence `outlineComplete`.
   */
  refreshOutline(): void {
    if (this.reading) return;
    const doc = this.activeDoc;
    if (!doc) {
      this.outline = [];
      this.outlineComplete = true;
      return;
    }
    const length = doc.state.doc.length;
    const tree = ensureSyntaxTree(doc.state, length, OUTLINE_TIMEOUT) ?? syntaxTree(doc.state);
    this.outline = headings(tree, doc.text);
    this.outlineComplete = tree.length >= length;
  }

  /** Click an outline entry: scroll in Read, move the cursor in the others. */
  goToHeading(entry: OutlineEntry): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.reading) {
      this.reading.view.scrollToId(entry.id);
      return;
    }
    const view = this.mounted?.view;
    if (!view) return;
    view.dispatch({
      selection: EditorSelection.single(Math.min(entry.from, view.state.doc.length)),
      effects: EditorView.scrollIntoView(Math.min(entry.from, view.state.doc.length), {
        y: 'start',
        yMargin: 8,
      }),
    });
    view.focus();
  }

  /** A link in Read mode. The webview never navigates (design 6.2). */
  openLink(href: string, external: boolean): void {
    if (external) {
      if (this.options.openExternal) this.options.openExternal(href);
      else this.status = `Cannot open ${href} here`;
      return;
    }
    this.status = `${href} opens with the folder workspace, which is WP 2.4`;
  }

  // --- the session --------------------------------------------------------

  /**
   * What this window would come back as (design 4.1).
   *
   * The mounted view is asked for its cursor and its scroll position
   * first: a tab's own copy of those is only as fresh as the last time
   * something took them back off the view.
   */
  sessionState(): WindowContent {
    this.syncMounted();
    const documents: DocumentState[] = [];
    const at = new Map<string, number>();
    for (const tab of this.tabs) {
      const doc = this.doc(tab);
      if (at.has(doc.id)) continue;
      at.set(doc.id, documents.length);
      documents.push(
        doc.path === null
          ? // A document with no file is carried whole: the session is
            // the only place it has ever been.
            { path: null, untitled: { name: doc.untitledName, text: doc.text } }
          : { path: doc.path, untitled: null },
      );
    }
    return {
      documents,
      tabs: this.tabs.map((tab) => ({
        document: at.get(tab.docId) ?? 0,
        mode: tab.mode,
        pinned: tab.pinned,
        active: tab.id === this.activeId,
        selection: { anchor: tab.selection.main.anchor, head: tab.selection.main.head },
        anchor: tab.anchor?.offset ?? 0,
        folded: [...tab.folded],
      })),
      sidebar: this.sidebar,
      comments: this.comments,
    };
  }

  /**
   * Put the window back the way it was left.
   *
   * A file that is no longer on disk is left out rather than restored
   * empty, because a tab that looks like the document but holds nothing
   * is a lie about it. An untitled document comes back out of the
   * session file, which is the only copy of it there has ever been.
   */
  async restore(content: WindowContent, recents: readonly string[] = []): Promise<void> {
    this.recents = [...recents];
    this.sidebar = content.sidebar ?? false;
    this.comments = content.comments ?? false;
    const docs: (Doc | null)[] = [];
    const gone: string[] = [];
    for (const entry of content.documents ?? []) {
      const doc = await this.restoreDoc(entry);
      if (doc === null && entry.path) gone.push(basename(entry.path));
      docs.push(doc);
    }
    let active: string | null = null;
    for (const saved of content.tabs ?? []) {
      const doc = docs[saved.document ?? 0];
      if (!doc) continue;
      const tab = this.addTab(doc, saved.mode ?? 'read');
      tab.pinned = saved.pinned ?? false;
      // The file may have changed since; a position past its end is not
      // a reason to lose the tab.
      const grip = (n: number) => Math.max(0, Math.min(n, doc.state.doc.length));
      tab.selection = EditorSelection.single(
        grip(saved.selection?.anchor ?? 0),
        grip(saved.selection?.head ?? 0),
      );
      tab.anchor = { offset: grip(saved.anchor ?? 0), y: 0 };
      tab.folded = [...(saved.folded ?? [])];
      if (saved.active ?? false) active = tab.id;
    }
    this.activate(active ?? this.tabs[0]?.id ?? null);
    const said: string[] = [];
    if (this.tabs.length > 0)
      said.push(`Picked up where you left off · ${count(this.tabs.length, 'tab')}`);
    if (gone.length > 0) said.push(`${gone.join(', ')} no longer there`);
    this.status = said.join(' · ');
  }

  private async restoreDoc(entry: DocumentState): Promise<Doc | null> {
    if (entry.untitled) {
      const { name, text } = entry.untitled;
      this.untitledCount = Math.max(this.untitledCount, untitledNumber(name));
      const doc = this.newDoc(text, { untitledName: name });
      // This text has never been to a file, so the dirty dot belongs on
      // it exactly as it did before the restart. `reviewed` stays where
      // the document is, because the reader has already read all of it.
      doc.base = Text.empty;
      return doc;
    }
    if (!entry.path) return null;
    return (await this.load(entry.path))?.doc ?? null;
  }

  /** The preferences, changed and written down (WP 1.9, WP 1.11). */
  updateSettings(change: Partial<Settings>): void {
    this.settings = { ...this.settings, ...change };
    void this.options.commands.saveSettings(this.settings);
  }

  /**
   * Record the window at the end of this turn: a tab opened, a mode
   * changed, the sidebar came out.
   */
  private touch(): void {
    this.schedule(0);
  }

  /**
   * Record it after a pause, for the one change that is expensive to
   * serialize: the text of a document that has no file.
   *
   * There are two throttles on this path, each with its own job. These
   * keep the shell from serializing an untitled buffer on every
   * keystroke; the store in Rust keeps the disk to one write a second
   * while holding the newest value, which is what the router of files
   * the OS hands us reads and what a close writes.
   */
  private touchSoon(): void {
    this.schedule(SESSION_DELAY);
  }

  private schedule(delay: number): void {
    if (this.sessionTimer !== null) {
      if (delay >= this.sessionDelay) return;
      clearTimeout(this.sessionTimer);
    }
    this.sessionDelay = delay;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      void this.pushSession();
    }, delay);
  }

  private pushSession(): Promise<unknown> {
    return this.options.commands.saveWindow(this.sessionState(), [...this.recents]);
  }

  /**
   * Everything not on disk yet, now, because the window is closing.
   *
   * Autosave joins this in WP 1.11. Until then the session is all there
   * is to write: the buffer of a named file that was never saved is lost
   * on close, exactly as it is when its tab is closed.
   */
  async flushPending(): Promise<void> {
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    await this.pushSession();
    await this.options.commands.flushState();
  }

  // --- word count ---------------------------------------------------------

  countNow(): void {
    if (this.countTimer !== null) {
      clearTimeout(this.countTimer);
      this.countTimer = null;
    }
    this.words = countWords(this.activeDoc?.text ?? '');
    if (this.sidebar) this.refreshOutline();
  }

  private scheduleWordCount(): void {
    if (this.countTimer !== null) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.words = countWords(this.activeDoc?.text ?? '');
      if (this.sidebar) this.refreshOutline();
    }, WORD_COUNT_DELAY);
  }

  destroy(): void {
    // Dropping the views first, because putting one away is itself a
    // reason to write the session down and would set the timer again.
    this.unmount();
    this.unmountRead();
    for (const timer of [this.countTimer, this.changeTimer, this.sessionTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.countTimer = null;
    this.changeTimer = null;
    this.sessionTimer = null;
  }
}
