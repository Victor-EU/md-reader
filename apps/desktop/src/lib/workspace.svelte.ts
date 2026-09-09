import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  type EditorState,
  type Extension,
  Text,
  type Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  type AnnotationEdit,
  applyLink,
  boldEdit,
  codeEdit,
  colorEdit,
  commentEdit,
  countMatches,
  type EditorMode,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightEdit,
  italicEdit,
  lineChanges,
  linkEdit,
  type MatchCount,
  nextChange,
  previousChange,
  replaceAll,
  replaceNext,
  SearchQuery,
  setChanges,
  setDarkEffect,
  setFindOpen,
  setModeEffect,
  setSearchQuery,
  strikethroughEdit,
  toggleTaskAt,
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
  TabKind,
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
import {
  DEFAULT_SETTINGS,
  DEFAULT_SIZE,
  pageIsDark,
  type Reading,
  readingSettings,
  zoomed,
} from './appearance.ts';
import { type ClipboardWriter, copyRich, copyText } from './clipboard.ts';
import { Doc, nextId } from './document.svelte.ts';
import { imageResolver } from './images.ts';
import { proposeFileName } from './naming.ts';
import { imageLink, isImagePath, pastePlan, toBase64 } from './paste.ts';
import { basename, dirname, resolvePath, shortenDir, tabLabels } from './paths.ts';
import type { Enhancer } from './read/enhance.ts';
import { ReadView } from './read/view.ts';
import { count, countWords, describeError, describeFormat } from './text.ts';
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  IDLE,
  reason,
  reportCheck,
  type Updater,
  type UpdateState,
} from './update.ts';

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
  /**
   * What this tab shows. Settings open as a tab rather than a modal
   * (plan WP 1.9), so `docId` is empty for one of those and every
   * document command asks `activeDoc` rather than `activeTab`.
   */
  kind: TabKind;
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
  /** Null for a tab that was not a document, which is Settings today. */
  doc: Doc | null;
  index: number;
}

/** How one write of a document differs from another. */
interface WriteOptions {
  /**
   * Whether a document with no file may open the save panel. Only the
   * reader's own Save does; autosave has nowhere to put it and waits.
   */
  ask?: boolean;
  /**
   * Set when the timer asked rather than the reader. It says nothing
   * when it works, and the version it records is one the history may
   * fold into the run it belongs to.
   */
  auto?: boolean;
  /** Set on the retry after a merge, so a second refusal is reported. */
  retrying?: boolean;
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
  /**
   * The updater (plan WP 1.12). Absent outside a bundled app, which is
   * every browser build and every test that does not ask for one, and
   * then the update commands report that there is nothing to check.
   */
  updater?: Updater;
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
/**
 * How long after the last keystroke autosave writes the file (design
 * 6.6). Short, because the file on disk is the channel to the AI and an
 * unsaved buffer is a state it cannot see; long enough that a sentence
 * is one write rather than forty.
 */
/** What the find bar holds (design 4.5). */
export interface FindState {
  open: boolean;
  /** Whether the replace row is showing. Sticky once asked for. */
  replace: boolean;
  query: string;
  replacement: string;
  regexp: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

const AUTOSAVE_DELAY = 800;
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
   * The reader's preferences, as the launch found them (WP 1.8, WP 1.9).
   *
   * Always complete and always in range: what comes off the IPC has every
   * field optional, and a settings file can be edited by hand, so it goes
   * through `readingSettings` on the way in.
   */
  settings = $state<Reading>({ ...DEFAULT_SETTINGS });
  /**
   * What the OS says about light and dark. `main.ts` keeps it current; a
   * window with nobody listening reads as light, which is what a browser
   * build and the tests both want.
   */
  systemDark = $state(false);
  outline = $state<OutlineEntry[]>([]);
  /** False while a long document is still being parsed in the background. */
  outlineComplete = $state(true);
  palette = $state<{ open: boolean; kind: PaletteKind; query: string; index: number }>({
    open: false,
    kind: 'files',
    query: '',
    index: 0,
  });

  /**
   * What every view of every document carries. A paste or a drop is the
   * one edit the editor cannot plan alone: it may have to write a file
   * first, which only the workspace can do (design 4.5).
   */
  private readonly editorExtras: Extension[] = [
    EditorView.domEventHandlers({
      paste: (event, view) => this.onPaste(event, view),
      drop: (event, view) => this.onDrop(event, view),
    }),
  ];
  /** Where the updater has got to (plan WP 1.12). */
  update = $state<UpdateState>(IDLE);
  /** The running app's own version, which only Tauri knows. */
  version = $state('');
  /** The find bar, and the query behind it (design 4.5). */
  find = $state<FindState>({
    open: false,
    replace: false,
    query: '',
    replacement: '',
    regexp: false,
    caseSensitive: false,
    wholeWord: false,
  });

  private readonly docs = new Map<string, Doc>();
  private closed = $state<ClosedTab[]>([]);
  private mounted: { view: EditorView; tab: Tab } | null = null;
  /** A change step asked for from Read mode, waiting for the editor. */
  private pendingStep: boolean | null = null;
  private reading: { view: ReadView; tab: Tab } | null = null;
  private untitledCount = 0;
  private epoch = $state(0);
  /** Writes in flight, per document, so two of them cannot race. */
  private readonly writing = new Map<string, Promise<boolean>>();
  private readonly autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private sessionDelay = 0;

  constructor(readonly options: WorkspaceOptions) {}

  activeTab: Tab | null = $derived(this.tabs.find((tab) => tab.id === this.activeId) ?? null);
  activeDoc: Doc | null = $derived(this.activeTab ? this.docOf(this.activeTab) : null);
  /** What the Changes badge counts: runs the reader has not marked seen. */
  unreviewed: number = $derived(this.activeDoc?.changes.length ?? 0);
  /**
   * What the find bar counts. Read from the document's own state rather
   * than the view's, because that is the one both the editor and this
   * derivation already watch.
   */
  matches: MatchCount = $derived.by(() => {
    const doc = this.activeDoc;
    if (!doc || !this.find.open) return { current: 0, total: 0, capped: false };
    return countMatches(doc.state, getSearchQuery(doc.state));
  });
  /** Tab labels, disambiguated against each other. */
  labels: string[] = $derived(
    tabLabels(
      this.tabs.map((tab) => this.docOf(tab)?.path ?? null),
      this.tabs.map((tab) => this.docOf(tab)?.untitledName ?? 'Settings'),
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
  /** The settings tab, when this window has one open (plan WP 1.9). */
  settingsTab: Tab | null = $derived(this.tabs.find((tab) => tab.kind === 'settings') ?? null);
  /**
   * Whether the page is a dark one — not the same question as whether the
   * window is. The high-contrast paper is dark inside a light window, and
   * what the reader is reading on decides how the code on it is coloured.
   */
  darkPage: boolean = $derived(pageIsDark(this.settings, this.systemDark));

  /** The document a tab shows, or null for a tab that is not one. */
  docOf(tab: Tab): Doc | null {
    return this.docs.get(tab.docId) ?? null;
  }

  doc(tab: Tab): Doc {
    const doc = this.docOf(tab);
    if (!doc) throw new Error(`tab ${tab.id} has no document`);
    return doc;
  }

  // --- opening ------------------------------------------------------------

  /** Cmd+O, drag and drop, and the OS open events of WP 1.8 all land here. */
  /**
   * Files handed to the window: by the OS at launch, by a drop, or by the
   * open panel. An image is not a document — it goes beside the one in
   * front as an asset (design 4.5) — and everything else is opened.
   */
  async openPaths(paths: readonly string[]): Promise<void> {
    const images = paths.filter(isImagePath);
    for (const path of paths) if (!isImagePath(path)) await this.openPath(path);
    if (images.length > 0) await this.importImages(images);
  }

  async openPath(path: string): Promise<boolean> {
    const open = this.tabs.find((tab) => this.docOf(tab)?.path === path);
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
      extra: this.editorExtras,
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
    return this.insert(Workspace.blankTab('document', doc.id, mode), at);
  }

  /**
   * The preferences, as a tab (plan WP 1.9). There are no modals in this
   * app (build plan rule 5), and a settings page is a place the reader
   * goes rather than something that happens to them: it takes a tab, it
   * can be pinned, and it comes back with the session.
   */
  openSettings(): Tab {
    const open = this.settingsTab;
    if (open) {
      this.activate(open.id);
      return open;
    }
    return this.insert(Workspace.blankTab('settings', '', 'read'));
  }

  private static blankTab(kind: TabKind, docId: string, mode: ViewMode): Tab {
    return {
      id: nextId('tab'),
      kind,
      docId,
      mode,
      pinned: false,
      selection: EditorSelection.single(0),
      scrollTop: 0,
      anchor: null,
      folded: [],
    };
  }

  /** Put a tab in the strip, after the pinned block, and go to it. */
  private insert(tab: Tab, at?: number): Tab {
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
    const leaving = this.activeTab ? this.docOf(this.activeTab) : null;
    this.activeId = id;
    this.countNow();
    this.touch();
    // Switching tabs is one of the moments autosave writes (design 6.6).
    // Two tabs on the same document are not leaving it.
    if (leaving && leaving.id !== this.activeDoc?.id) this.autosaveOnLeave(leaving);
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
    const doc = this.docOf(tab);
    const wasActive = this.activeId === tab.id;
    if (wasActive) {
      this.unmount();
      this.unmountRead();
    }
    this.tabs.splice(index, 1);
    this.closed = [{ tab: { ...tab }, doc, index }, ...this.closed].slice(0, CLOSED_LIMIT);
    const alone = doc !== null && !this.tabs.some((other) => other.docId === doc.id);
    // Closing the last tab on a document is the strongest form of
    // leaving it, so autosave writes it (design 6.6) before it goes.
    const saved = alone && this.autosaveOnLeave(doc);
    if (doc && alone) {
      this.docs.delete(doc.id);
      if (doc.path !== null) void this.options.commands.unwatch(doc.path);
    }
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.countNow();
    }
    this.touch();
    if (!doc) {
      this.status = 'Closed Settings';
      return;
    }
    // No dialog asks about unsaved work; the buffer is kept and can be
    // reopened, and with autosave on it is already on disk.
    this.status =
      doc.dirty && !saved
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
    if (record.doc) {
      this.docs.set(record.doc.id, record.doc);
      // Closing the last tab on a document stopped the watch; reopening
      // it starts one again.
      if (record.doc.path !== null) void this.options.commands.watch(record.doc.path);
    }
    const tab: Tab = { ...record.tab, id: nextId('tab') };
    this.tabs.splice(Math.min(record.index, this.tabs.length), 0, tab);
    this.activate(tab.id);
    this.touch();
    this.status = `Reopened ${record.doc?.label ?? 'Settings'}`;
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
    if (tab?.kind !== 'document' || tab.mode === mode) return;
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
    if (tab?.kind !== 'document' || this.mounted || tab.mode === 'read') return;
    const doc = this.doc(tab);
    const view: EditorView = new EditorView({
      state: doc.state,
      parent,
      dispatchTransactions: (trs) => this.applyTransactions(view, trs),
    });
    this.mounted = { view, tab };
    view.dispatch({
      selection: tab.selection,
      effects: [
        setModeEffect(tab.mode),
        // The paper a document state was built under may not be the one
        // it is being shown on, so every mount says which it is.
        setDarkEffect(this.darkPage),
        setChanges.of(doc.changes),
      ],
    });
    // Cmd+F in Read mode switches modes first, so the editor arrives
    // after the query does; this is where it catches up.
    if (this.find.open) this.pushQuery();
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
    // A change step asked for from Read mode has been waiting for this
    // view. It runs after the place the reader left, because it is a
    // request to go somewhere else and would otherwise be scrolled over.
    if (this.pendingStep !== null) {
      const forward = this.pendingStep;
      this.pendingStep = null;
      this.runStep(forward);
    }
    view.focus();
  }

  /** Mount Read mode for the active tab. */
  mountRead(parent: HTMLElement): void {
    const tab = this.activeTab;
    if (tab?.kind !== 'document' || this.reading || tab.mode !== 'read') return;
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
      onCopyCode: (text) => void this.copyCode(text),
      onToggleTask: (offset) => this.toggleTask(offset),
      comments: this.comments,
      render: { image: this.imageRules(doc), interactiveTasks: true },
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
    if (tab?.kind !== 'document') return;
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
      this.scheduleAutosave(doc);
      // Only a document with no file has text the session has to carry.
      if (doc.path === null) this.touchSoon();
    }
  }

  // --- saving -------------------------------------------------------------

  get canSave(): boolean {
    const doc = this.activeDoc;
    return doc !== null && !doc.meta?.read_only;
  }

  /** Cmd+S: the one save that may ask where a new file should go. */
  save(): Promise<boolean> {
    const doc = this.activeDoc;
    return doc ? this.write(doc, { ask: true }) : Promise.resolve(false);
  }

  /**
   * Write one document, and never two writes of it at once.
   *
   * Overlapping writes would race: the second reads its expected hash
   * before the first has changed it, and arrives to find a file it does
   * not recognise — our own save, reported back to us as somebody
   * else's. So a write that finds one already running waits for it.
   */
  private write(doc: Doc, options: WriteOptions = {}): Promise<boolean> {
    const queued = (this.writing.get(doc.id) ?? Promise.resolve(false)).then(() =>
      this.writeNow(doc, options),
    );
    this.writing.set(doc.id, queued);
    this.saving = true;
    const settled = () => {
      if (this.writing.get(doc.id) !== queued) return;
      this.writing.delete(doc.id);
      this.saving = this.writing.size > 0;
    };
    queued.then(settled, settled);
    return queued;
  }

  private async writeNow(doc: Doc, options: WriteOptions): Promise<boolean> {
    if (doc.meta?.read_only) {
      this.status = `${doc.label} is ${doc.meta.format.encoding}; convert to UTF-8 to edit`;
      return false;
    }
    let path = doc.path;
    if (path === null) {
      // Autosave has nowhere to put a document nobody has named. The
      // session carries the text until somebody says where it goes,
      // which is the same promise by another route.
      if (!options.ask) return false;
      path = (await this.options.pickSaveTarget?.(this.saveTarget(doc))) ?? null;
      if (path === null) return false;
    }
    const written = doc.state.doc;
    // Once, not twice: on a megabyte of markdown saved every pause in
    // typing, flattening the rope is the expensive part of a save.
    const text = written.toString();
    const format = doc.meta?.format ?? NEW_FILE_FORMAT;
    // An untitled document has never been watched; one that just got its
    // name has to be, from this save on.
    const wasWatched = doc.path !== null;
    const result = await this.options.commands.saveDocument(
      path,
      text,
      doc.meta?.hash ?? null,
      format,
    );
    if (result.status === 'error') {
      if (result.error.kind === 'hash_mismatch' && options.retrying !== true) {
        return this.mergeAndRetry(doc, path, options);
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
    doc.markSaved(written, options.auto !== true);
    this.pushChanges(doc);
    this.remember(path);
    // A save is a version too, and the one a later restore compares
    // with. An autosave says which it is, because the history keeps a
    // run of those as one version rather than one per pause in typing.
    void this.options.commands.snapshot(path, text, options.auto === true ? 'autosave' : 'user');
    if (!wasWatched) {
      void this.options.commands.watch(path);
      // A document that has just been given a folder can show images
      // from it, including any it is about to be given (design 8).
      void this.options.commands.allowDocumentImages(path);
    }
    if (options.auto !== true) this.status = `Saved ${basename(path)}`;
    return true;
  }

  /**
   * Somebody wrote to the file between our last look at it and this save
   * (design 7.2). Their write is merged into the buffer and the save is
   * tried once more. What the reader is told is what changed on disk,
   * never that a save failed, because none of it did.
   */
  private async mergeAndRetry(doc: Doc, path: string, options: WriteOptions): Promise<boolean> {
    const fresh = await this.options.commands.openDocument(path);
    if (fresh.status !== 'ok') {
      this.status = describeError(fresh.error);
      return false;
    }
    await this.externalChange({
      path,
      content: fresh.data.content,
      hash: fresh.data.meta.hash,
      changes: [],
    });
    const merged = this.status;
    if (!(await this.writeNow(doc, { ...options, retrying: true }))) return false;
    if (options.auto !== true) this.status = `${this.status} · ${merged}`;
    return true;
  }

  /**
   * What the save panel opens on for a document with no file yet
   * (design 4.5, scenario S8): a name from its first heading, in a
   * folder this window is already working in. There is no folder
   * workspace until WP 2.4, so that is the nearest open document's.
   */
  private saveTarget(doc: Doc): string {
    const name = proposeFileName(this.firstHeading(doc), doc.untitledName);
    const folder = this.saveFolder();
    return folder === '' ? name : resolvePath(folder, name);
  }

  private firstHeading(doc: Doc): string | null {
    const length = doc.state.doc.length;
    const tree = ensureSyntaxTree(doc.state, length, OUTLINE_TIMEOUT) ?? syntaxTree(doc.state);
    return headings(tree, doc.text)[0]?.text ?? null;
  }

  private saveFolder(): string {
    for (const tab of this.tabs) {
      const path = this.docOf(tab)?.path;
      if (path) return dirname(path);
    }
    const recent = this.recents[0];
    return recent === undefined ? '' : dirname(recent);
  }

  // --- autosave -----------------------------------------------------------

  /**
   * Whether the timer writes this document (design 6.6).
   *
   * Not one nobody has named: the first save is where the reader says
   * where it goes. Not one the app cannot write either, which is the
   * read-only encodings of WP 1.1.
   */
  private autosaves(doc: Doc): boolean {
    return this.settings.autosave && doc.path !== null && doc.meta?.read_only !== true;
  }

  /** The buffer moved ahead of the file; put it back in `AUTOSAVE_DELAY`. */
  private scheduleAutosave(doc: Doc): void {
    if (!this.autosaves(doc)) return;
    this.cancelAutosave(doc);
    this.autosaveTimers.set(
      doc.id,
      setTimeout(() => {
        this.autosaveTimers.delete(doc.id);
        // An undo can have taken the buffer back to the file by now.
        if (doc.dirty) void this.write(doc, { auto: true });
      }, AUTOSAVE_DELAY),
    );
  }

  private cancelAutosave(doc: Doc): void {
    const timer = this.autosaveTimers.get(doc.id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.autosaveTimers.delete(doc.id);
  }

  /**
   * The reader is leaving this document: another tab came to the front,
   * or this one is closing. Design 6.6 writes then as well, because the
   * pause the timer is waiting for may never come.
   *
   * Says whether it started a write, which is what tells the tab it just
   * closed whether it had unsaved work.
   */
  private autosaveOnLeave(doc: Doc | null): boolean {
    if (!doc) return false;
    this.cancelAutosave(doc);
    if (!this.autosaves(doc) || !doc.dirty) return false;
    void this.write(doc, { auto: true });
    return true;
  }

  /**
   * Everything the disk is owed, now: the window lost focus, or it is
   * closing. The one call that waits for the writes to land.
   */
  async flushAutosave(): Promise<void> {
    const writes: Promise<unknown>[] = [];
    for (const doc of this.docs.values()) {
      this.cancelAutosave(doc);
      if (this.autosaves(doc) && doc.dirty) writes.push(this.write(doc, { auto: true }));
    }
    await Promise.all(writes);
  }

  /**
   * Autosave on or off (design 6.6). Off is the dirty dot and Cmd+S,
   * for a reader who would rather decide themselves when a version of
   * their file exists. On writes what is dirty already, because turning
   * it on is that decision made once.
   */
  setAutosave(on: boolean): void {
    if (on === this.settings.autosave) return;
    this.updateSettings({ autosave: on });
    if (on) {
      void this.flushAutosave();
      this.status = 'Autosave on';
      return;
    }
    for (const doc of this.docs.values()) this.cancelAutosave(doc);
    this.status = 'Autosave off · saving is by hand from here';
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

  /**
   * Walk the external changes, one run at a time (design scenario S4).
   *
   * Read mode has no cursor to put on a change, so the step happens in
   * Edit — the same reasoning as find, whose bar also switches modes
   * before it opens (ADR 0016). The editor arrives from its own effect a
   * moment later, so the step waits in `pendingStep` and `mount` runs it.
   */
  stepChange(forward: boolean): boolean {
    const tab = this.activeTab;
    if (tab?.kind !== 'document') return false;
    if (tab.mode === 'read') {
      this.pendingStep = forward;
      this.setMode('edit');
      return true;
    }
    return this.runStep(forward);
  }

  private runStep(forward: boolean): boolean {
    const view = this.mounted?.view;
    if (!view) return false;
    const moved = (forward ? nextChange : previousChange)(view);
    if (!moved) this.status = 'Nothing has changed under you';
    return moved;
  }

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
  private annotate(
    plan: (state: EditorState) => AnnotationEdit | null,
    type: boolean,
    userEvent = 'input.annotate',
  ): boolean {
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
      view.dispatch(view.state.update({ ...edit, userEvent }));
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
    doc.state = based.update({ ...edit, userEvent }).state;
    // The editor is not mounted here, so this is the one edit that does
    // not pass through `applyTransactions` on its way to the buffer.
    this.scheduleAutosave(doc);
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

  /**
   * The four inline marks of design 4.5, through the same path as the
   * annotations: the editor when it is mounted, the document's own state
   * when the reader is in Read mode.
   *
   * A link is the one that leaves something to type — the destination —
   * so it takes the reader into Edit mode with the cursor already in it.
   */
  bold(): boolean {
    return this.annotate(boldEdit, false, 'input.format.bold');
  }

  italic(): boolean {
    return this.annotate(italicEdit, false, 'input.format.italic');
  }

  code(): boolean {
    return this.annotate(codeEdit, false, 'input.format.code');
  }

  link(): boolean {
    return this.annotate((state) => linkEdit(state), true, 'input.format.link');
  }

  /**
   * A task checkbox clicked in Read mode (design 4.5).
   *
   * Edit mode has its own widget and dispatches through the editor; here
   * there is none, so the one-byte change goes onto the document's own
   * state and the page is rendered again. The page comes back where it
   * was rather than at the cursor, because the reader is looking at the
   * item they just ticked.
   */
  toggleTask(offset: number): boolean {
    const tab = this.activeTab;
    const doc = this.activeDoc;
    const reading = this.reading?.view;
    if (!doc || !reading || tab?.kind !== 'document') return false;
    if (doc.meta?.read_only) {
      this.status = `${doc.label} is read-only`;
      return false;
    }
    const target = {
      state: doc.state,
      dispatch: (tr: Transaction) => {
        doc.state = tr.state;
      },
    };
    if (!toggleTaskAt(target, offset)) return false;
    tab.anchor = { offset: reading.topOffset(), y: 0 };
    this.scheduleAutosave(doc);
    this.scheduleChangeScan();
    this.unmountRead();
    this.epoch += 1;
    return true;
  }

  // --- find and replace ---------------------------------------------------

  /**
   * Open the find bar (design 4.5).
   *
   * Replace needs an editor, and so does find: matches are drawn by an
   * editor extension. So opening it in Read mode takes the reader into
   * Edit mode first, where the text they are about to search is the text
   * they can change.
   */
  openFind(replace: boolean): void {
    const tab = this.activeTab;
    if (tab?.kind !== 'document') return;
    if (tab.mode === 'read') this.setMode('edit');
    const selected = this.selectedWithin();
    this.find = {
      ...this.find,
      open: true,
      replace: replace || this.find.replace,
      query: selected ?? this.find.query,
    };
    this.pushQuery();
  }

  closeFind(): void {
    if (!this.find.open) return;
    this.find = { ...this.find, open: false };
    this.pushQuery();
    this.focusEditor();
  }

  /** Change the query or a flag, and tell the editor about it. */
  updateFind(patch: Partial<FindState>): void {
    this.find = { ...this.find, ...patch };
    this.pushQuery();
  }

  /** The selection, when it is one line of it: what Cmd+F starts with. */
  private selectedWithin(): string | null {
    const view = this.mounted?.view;
    const range = view?.state.selection.main;
    if (!view || !range || range.empty) return null;
    const text = view.state.doc.sliceString(range.from, range.to);
    return text.includes('\n') ? null : text;
  }

  private searchQuery(): SearchQuery {
    return new SearchQuery({
      search: this.find.query,
      replace: this.find.replacement,
      regexp: this.find.regexp,
      caseSensitive: this.find.caseSensitive,
      wholeWord: this.find.wholeWord,
      // A backslash the writer typed is a backslash, not an escape. With
      // the regular expression box ticked it is the engine's again.
      literal: true,
    });
  }

  private pushQuery(): void {
    const view = this.mounted?.view;
    if (!view) return;
    view.dispatch({
      effects: [setSearchQuery.of(this.searchQuery()), setFindOpen.of(this.find.open)],
    });
  }

  /** Step to the next match, or the previous one. Wraps, as every editor does. */
  findStep(forward: boolean): boolean {
    const view = this.mounted?.view;
    if (!view || this.find.query === '') return false;
    const moved = forward ? findNext(view) : findPrevious(view);
    if (!moved) this.status = `No match for ${this.find.query}`;
    return moved;
  }

  replaceOne(): boolean {
    const view = this.mounted?.view;
    if (!view || !this.editable()) return false;
    return replaceNext(view);
  }

  replaceEvery(): boolean {
    const view = this.mounted?.view;
    if (!view || !this.editable()) return false;
    const before = this.matches.total;
    const done = replaceAll(view);
    if (done) this.status = `Replaced ${before} ${before === 1 ? 'match' : 'matches'}`;
    return done;
  }

  /** A read-only document says so rather than quietly doing nothing. */
  private editable(): boolean {
    const doc = this.activeDoc;
    if (doc?.meta?.read_only !== true) return true;
    this.status = `${doc.label} is read-only`;
    return false;
  }

  // --- paste and drop -----------------------------------------------------

  /**
   * A paste into the editor (design 4.5). Returning true is how a
   * CodeMirror DOM handler says the default is not wanted; returning
   * false leaves the exact plain-text paste alone, which is the right
   * answer for most of them.
   */
  private onPaste(event: ClipboardEvent, view: EditorView): boolean {
    return this.transfer(event.clipboardData, view, null);
  }

  /**
   * A drop into the editor. Under Tauri the webview takes the drop before
   * the DOM sees it and reports real paths, which `openPaths` routes; this
   * is the same gesture in a plain browser, where the files arrive here.
   */
  private onDrop(event: DragEvent, view: EditorView): boolean {
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY });
    return this.transfer(event.dataTransfer, view, at);
  }

  private transfer(data: DataTransfer | null, view: EditorView, at: number | null): boolean {
    const plan = pastePlan(
      data && { files: [...data.files], getData: (type) => data.getData(type) },
      !view.state.selection.main.empty,
    );
    if (plan.kind === 'text') return false;
    if (at !== null) view.dispatch({ selection: EditorSelection.cursor(at) });
    switch (plan.kind) {
      case 'images':
        void this.pasteFiles(plan.files);
        return true;
      case 'link':
        return applyLink(plan.url)(view);
      default:
        view.dispatch({
          ...view.state.replaceSelection(plan.text),
          userEvent: 'input.paste',
          scrollIntoView: true,
        });
        return true;
    }
  }

  /**
   * Write pasted images beside the document and link to them.
   *
   * The bytes go to Rust, which decides the name and refuses anything
   * that is not an image; what comes back is a path relative to the
   * document, which is what the file gets to say.
   */
  async pasteFiles(files: readonly File[]): Promise<void> {
    const doc = this.activeDoc;
    const view = this.mounted?.view;
    if (!doc || !view) return;
    const path = doc.path;
    if (path === null) {
      this.status = 'Save the document before adding an image to it';
      return;
    }
    const links: string[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await this.options.commands.writeAsset(path, file.name, toBase64(bytes));
      if (result.status === 'error') {
        this.status = describeError(result.error);
        return;
      }
      links.push(imageLink(file.name, result.data.relative));
    }
    this.insertText(view, links.join('\n'));
    this.status = `${count(links.length, 'image')} added beside the document`;
  }

  /**
   * Copy dropped image files beside the document and link to them. The
   * dropped half of the same gesture: Rust already has the path, so the
   * bytes never cross the bridge.
   */
  private async importImages(paths: readonly string[]): Promise<void> {
    const doc = this.activeDoc;
    const view = this.mounted?.view;
    if (!doc || !view) {
      this.status = 'Open a document to drop an image into';
      return;
    }
    const path = doc.path;
    if (path === null) {
      this.status = 'Save the document before adding an image to it';
      return;
    }
    const links: string[] = [];
    for (const source of paths) {
      const result = await this.options.commands.importAsset(path, source);
      if (result.status === 'error') {
        this.status = describeError(result.error);
        return;
      }
      links.push(imageLink(basename(source), result.data.relative));
    }
    this.insertText(view, links.join('\n'));
    this.status = `${count(links.length, 'image')} added beside the document`;
  }

  private insertText(view: EditorView, text: string): void {
    view.dispatch({
      ...view.state.replaceSelection(text),
      userEvent: 'input.paste',
      scrollIntoView: true,
    });
    view.focus();
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

  /** The copy button on a fence in Read mode (design 11). */
  private async copyCode(text: string): Promise<void> {
    // The button says so itself when this works; the status line is only
    // needed for the case it cannot.
    const ok = await copyText(text, this.options.clipboard ?? navigator.clipboard);
    if (!ok) this.status = 'Could not reach the clipboard';
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
    const choices: FileChoice[] = this.tabs.flatMap((tab, i) => {
      const doc = this.docOf(tab);
      if (!doc) return [];
      return [
        {
          label: this.labels[i] ?? doc.label,
          detail: doc.path === null ? 'not saved yet' : shortenDir(dirname(doc.path)),
          tabId: tab.id,
          path: doc.path,
        },
      ];
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
      const doc = this.docOf(tab);
      if (!doc || at.has(doc.id)) continue;
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
        kind: tab.kind,
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
      let tab: Tab;
      if (saved.kind === 'settings') {
        tab = this.openSettings();
      } else {
        const doc = docs[saved.document ?? 0];
        if (!doc) continue;
        tab = this.addTab(doc, saved.mode ?? 'read');
        // The file may have changed since; a position past its end is
        // not a reason to lose the tab.
        const grip = (n: number) => Math.max(0, Math.min(n, doc.state.doc.length));
        tab.selection = EditorSelection.single(
          grip(saved.selection?.anchor ?? 0),
          grip(saved.selection?.head ?? 0),
        );
        tab.anchor = { offset: grip(saved.anchor ?? 0), y: 0 };
        tab.folded = [...(saved.folded ?? [])];
      }
      tab.pinned = saved.pinned ?? false;
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

  /**
   * The preferences as a launch found them. Nothing is written back:
   * this is the file being read, not the reader changing anything.
   */
  applySettings(settings: Settings | null | undefined): void {
    this.settings = readingSettings(settings);
    this.repaint();
  }

  /** The preferences, changed and written down (design 11, design 6.6). */
  updateSettings(change: Partial<Settings>): void {
    this.settings = readingSettings({ ...this.settings, ...change });
    this.repaint();
    void this.options.commands.saveSettings(this.settings);
  }

  /**
   * Tell the live editor which paper it is on. Only the mounted view
   * needs telling: every other document state is told at its mount, and
   * Read mode takes its colours from the stylesheet.
   */
  private repaint(): void {
    this.mounted?.view.dispatch({ effects: setDarkEffect(this.darkPage) });
  }

  /**
   * Cmd+= and Cmd+- (design 4.5). Zoom is the reading size and not a
   * second number beside it: one thing to set, one thing to remember,
   * and the type scale is drawn for the sizes it steps through.
   */
  zoom(steps: number): void {
    const size = zoomed(this.settings.size, steps);
    if (size === this.settings.size) {
      this.status = `Text size ${size}px · that is as ${steps > 0 ? 'large' : 'small'} as it goes`;
      return;
    }
    this.updateSettings({ size });
    this.status = `Text size ${size}px`;
  }

  resetZoom(): void {
    if (this.settings.size !== DEFAULT_SIZE) this.updateSettings({ size: DEFAULT_SIZE });
    this.status = `Text size ${DEFAULT_SIZE}px`;
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
   * The files first, because a file is where the work belongs; then the
   * session, which by that point records a window whose documents are
   * already written. Rust holds the close open until this answers
   * (WP 1.8), which is what makes Cmd+Q with a half-typed sentence in
   * front of you safe.
   */
  async flushPending(): Promise<void> {
    await this.flushAutosave();
    if (this.sessionTimer !== null) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    await this.pushSession();
    await this.options.commands.flushState();
  }

  // --- the updater --------------------------------------------------------

  /**
   * Start looking for updates: once shortly after launch, then every few
   * hours for as long as the window is open (plan WP 1.12).
   *
   * Both of those are automatic and both are silent unless they find
   * something. Only `checkForUpdates(true)` — the command in the palette
   * — reports back when there is nothing to report.
   */
  watchForUpdates(): void {
    if (!this.options.updater || this.updateTimer !== null) return;
    setTimeout(() => void this.checkForUpdates(), FIRST_CHECK_DELAY_MS);
    this.updateTimer = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
  }

  stopWatchingForUpdates(): void {
    if (this.updateTimer === null) return;
    clearInterval(this.updateTimer);
    this.updateTimer = null;
  }

  /**
   * Ask the endpoint whether there is a newer build.
   *
   * A check while one is already downloading is dropped: the answer
   * cannot change what is happening, and letting it through would take
   * the progress off the status bar.
   */
  async checkForUpdates(manual = false): Promise<void> {
    const updater = this.options.updater;
    if (!updater) {
      if (manual) this.status = 'Updates are only checked in the installed app';
      return;
    }
    if (this.update.phase === 'checking' || this.update.phase === 'installing') {
      // Somebody pressed the command while an automatic check was in
      // flight. Saying what is already happening beats saying nothing.
      const already = reportCheck(this.update);
      if (manual && already !== '') this.status = already;
      return;
    }
    this.update = { phase: 'checking' };
    if (manual) this.status = reportCheck(this.update);
    try {
      const found = await updater.check();
      this.update = found ? { phase: 'available', update: found } : { phase: 'none' };
    } catch (error) {
      this.update = { phase: 'failed', message: reason(error) };
    }
    if (manual) this.status = reportCheck(this.update);
  }

  /** Download the update that was found and put it in place. */
  async installUpdate(): Promise<void> {
    const updater = this.options.updater;
    if (!updater || this.update.phase !== 'available') return;
    const update = this.update.update;
    this.update = { phase: 'installing', update, fraction: null };
    try {
      await updater.install((fraction) => {
        // A late progress callback must not resurrect a state the
        // failure below has already moved on from.
        if (this.update.phase === 'installing')
          this.update = { phase: 'installing', update, fraction };
      });
      this.update = { phase: 'ready', update };
    } catch (error) {
      this.update = { phase: 'failed', message: reason(error) };
      this.status = `Could not install the update — ${reason(error)}`;
    }
  }

  /**
   * Restart into the new build.
   *
   * The pending writes go out first. A relaunch is a close that the
   * window never gets told about, so without this an autosave still on
   * its 800 ms timer would be lost — which is exactly the sentence the
   * reader would blame the update for.
   */
  async restartForUpdate(): Promise<void> {
    const updater = this.options.updater;
    if (!updater || this.update.phase !== 'ready') return;
    await this.flushPending();
    await updater.relaunch();
  }

  /** What the status bar's update cell does when it is pressed. */
  async applyUpdate(): Promise<void> {
    if (this.update.phase === 'available') return this.installUpdate();
    if (this.update.phase === 'ready') return this.restartForUpdate();
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
    for (const timer of this.autosaveTimers.values()) clearTimeout(timer);
    this.autosaveTimers.clear();
    this.countTimer = null;
    this.changeTimer = null;
    this.sessionTimer = null;
  }
}
