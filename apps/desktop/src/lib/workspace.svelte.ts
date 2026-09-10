import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type Extension,
  type StateEffect,
  Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  type AnnotationEdit,
  addConflicts,
  applyLink,
  boldEdit,
  type ChangeRecord,
  type ConflictRegion,
  codeEdit,
  colorEdit,
  commentEdit,
  conflictRegion,
  conflicts,
  conflictsChanged,
  countMatches,
  type EditorMode,
  findNext,
  findPrevious,
  getSearchQuery,
  hasConflicts,
  highlightEdit,
  italicEdit,
  keepMineHere,
  linkEdit,
  type MatchCount,
  nextChange,
  nextConflict,
  previousChange,
  redo,
  replaceAll,
  replaceNext,
  revertChangeAtCursor,
  SearchQuery,
  serializeEditorState,
  setChanges,
  setDarkEffect,
  setFindOpen,
  setModeEffect,
  setReviewEffect,
  setSearchQuery,
  strikethroughEdit,
  takeTheirsHere,
  toggleTaskAt,
  undo,
} from '@markdown/editor-core';
import type {
  AgentAnswer,
  AgentAsk,
  AgentDocument,
  AgentRequest,
  AgentStatus,
  Commands,
  Conflict,
  DocumentMeta,
  DocumentState,
  ExternalChange,
  FileFormat,
  FileMatches,
  FileRemoved,
  FileRenamed,
  FolderChange,
  MergeResult,
  Override,
  SearchDone,
  SearchHit,
  SearchProgress,
  Settings,
  SidebarPanel,
  SnapshotInfo,
  TabKind,
  TabMove,
  WindowContent,
} from '@markdown/ipc';
import {
  type AnnotationKind,
  commonBlocks,
  copyForAi,
  type DocBlock,
  extractAnnotations,
  flattenBlocks,
  type ImageResolver,
  type OutlineEntry,
  type PaletteMeaning,
  parser,
  renderDocument,
  toHtml,
} from '@markdown/markdown';
import { agentAnnotation, agentDocument } from './agent.ts';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SIZE,
  overrideOf,
  pageIsDark,
  type Reading,
  readingSettings,
  resolveAppearance,
  withOverride,
  zoomed,
} from './appearance.ts';
import { blockChanges } from './changes.ts';
import { type ClipboardWriter, copyRich, copyText } from './clipboard.ts';
import { Doc, nextId } from './document.svelte.ts';
import { describeExport, exportPage } from './export.ts';
import { Folder } from './folder.svelte.ts';
import { snapshotTime } from './history.ts';
import { imageResolver } from './images.ts';
import { proposeFileName } from './naming.ts';
import { bookmarkRow, headingRow, type OutlineRow, type OutlineTarget } from './outline.ts';
import { imageLink, isImagePath, pastePlan, toBase64 } from './paste.ts';
import {
  basename,
  dirname,
  inside,
  isPdfPath,
  resolvePath,
  shortenDir,
  tabLabels,
} from './paths.ts';
import { PdfDoc } from './pdf/document.svelte.ts';
import { describePdfError, type PdfEngine, PdfError } from './pdf/engine.ts';
import { stepHit } from './pdf/find.ts';
import { PdfSearch } from './pdf/search.svelte.ts';
import { PdfView, stepZoom } from './pdf/view.ts';
import type { Enhancer } from './read/enhance.ts';
import { ReadView } from './read/view.ts';
import { FolderSearch } from './search.svelte.ts';
import { count, describeError, describeFormat, describeReadOnly } from './text.ts';
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

/**
 * Where a PDF tab is scrolled, and how big it is drawn (ADR 0035).
 *
 * Read mode's place is a source offset, which survives a change of
 * window width because a character does. A PDF's page does not move when
 * the window does, so its place is the page in front and how far down it
 * the top of the window sits.
 */
export interface PdfPlace {
  /** One-based, the way a PDF numbers its own pages. */
  page: number;
  /** How far down that page the top of the window is, from 0 to 1. */
  fraction: number;
  /** CSS pixels per point, before the device pixel ratio. */
  zoom: number;
}

export const PDF_START: PdfPlace = { page: 1, fraction: 0, zoom: 1 };

/** One tab: a view onto a document, with the state that is per view. */
export interface Tab {
  id: string;
  /**
   * What this tab shows. Settings open as a tab rather than a modal
   * (plan WP 1.9), so `docId` is empty for one of those and every
   * document command asks `activeDoc` rather than `activeTab`. A PDF
   * has a `docId` but no `Doc` behind it (ADR 0035), and the same
   * discipline is what keeps every editing command off it.
   */
  kind: TabKind;
  docId: string;
  mode: ViewMode;
  pinned: boolean;
  selection: EditorSelection;
  scrollTop: number;
  anchor: Anchor | null;
  /** Where a PDF is scrolled. Null for every tab that is not one. */
  pdf: PdfPlace | null;
  /** Heading ids folded in Read mode, kept while the tab is open. */
  folded: string[];
}

interface ClosedTab {
  tab: Tab;
  /** Null for a tab that was not a document: Settings, and a PDF. */
  doc: Doc | null;
  /** The open PDF, for a tab that was one. Reopening it re-uses it. */
  pdf: PdfDoc | null;
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
  /** The same panel, asking for a folder to work in (design 4.1). */
  pickFolder?: () => Promise<string | null>;
  /** The OS save panel, for the first save of an untitled document. */
  pickSaveTarget?: (suggested: string) => Promise<string | null>;
  /** The same panel, asking where an exported page goes (plan WP 3.2). */
  pickExportTarget?: (suggested: string) => Promise<string | null>;
  /** Opens a link in the system browser; the webview never navigates. */
  openExternal?: (url: string) => void;
  /** Shiki, KaTeX and Mermaid. Left out in tests, which do not need them. */
  enhancer?: Enhancer;
  /**
   * pdf.js, behind the engine port (ADR 0035). One more port on the
   * same terms as `Enhancer`: the shell must not be able to tell which
   * library is behind it, and a test hands in a dozen-line fake. Absent
   * in a browser build and in every test that does not open a PDF, and
   * then a PDF says so rather than opening a blank pane.
   */
  pdfEngine?: PdfEngine;
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
  /**
   * Names the window for the OS (plan WP 2.8). Only Tauri has one to
   * name; a browser tab is named by its document title, which is not
   * this app's to set.
   */
  setTitle?: (title: string) => void;
}

/** What a file we create ourselves looks like until the user says otherwise. */
const NEW_FILE_FORMAT: FileFormat = {
  eol: 'lf',
  mixed_eol: false,
  bom: false,
  trailing_newline: false,
  encoding: 'utf-8',
};

/** The sidebar's panels, for reading one back out of a session file. */
const PANELS: readonly SidebarPanel[] = ['files', 'outline', 'history'];
const CLOSED_LIMIT = 20;
const RECENTS_LIMIT = 50;
/** How many folder matches Cmd+P asks for. More than a list anyone reads. */
const PALETTE_FILES = 50;
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

/**
 * How many times a merge is asked again after the buffer moved under it.
 *
 * Each attempt costs one round trip to Rust and only happens when a
 * keystroke landed inside that trip. Three is generous for a reader
 * pausing between words; somebody who never pauses gets the message
 * instead, and their file is merged on the next save.
 */
const MERGE_ATTEMPTS = 3;
/** Long enough that a fast typist counts once per pause, not once per key. */
const WORD_COUNT_DELAY = 250;
/**
 * How much of the time the word count may have on a document long enough
 * for the counting to be felt (plan WP 3.3).
 *
 * A word count is a walk of the whole document, so on a ten megabyte one
 * it costs about as long as two frames however it is written. A fifth is
 * the share it gets: the pause after each count is the last one's cost
 * times this, so an ordinary document is counted a quarter of a second
 * after the last keystroke as before, and a very long one is counted
 * less often rather than the window stopping for it every quarter second.
 */
const COUNT_SHARE = 5;
/**
 * And never longer than this, so one slow count — a machine that
 * hiccuped, a document briefly enormous — does not leave the number in
 * the status bar stale for ten seconds afterwards.
 */
const COUNT_DELAY_MAX = 2_000;
/**
 * The same idea for the change gutter. The markers are mapped through
 * every edit as it happens, so what waits here is only the diff that
 * decides which runs there are.
 */
const CHANGE_SCAN_DELAY = 300;
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

/**
 * Whether the keyboard is in one of the shell's own text fields rather
 * than in the document: the find bar, a settings box, the rename row.
 *
 * The frontmatter panel's fields are inputs too, and they are not one of
 * these: they are inside the editor and what they change is the
 * document, so undoing there is the document's undo and not the field's.
 */
function inPlainField(view: EditorView | null): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return false;
  return !view?.dom.contains(active);
}

/** `Untitled 3` -> 3, so a new document does not reuse a restored name. */
function untitledNumber(name: string): number {
  const digits = /(\d+)$/.exec(name);
  return digits === null ? 0 : Number(digits[1]);
}

/**
 * A hunk the merge could not decide, as a region of the buffer after the
 * hunks it could decide have been applied to it.
 */
function raise(changes: ChangeSet, hunk: Conflict): ConflictRegion {
  return conflictRegion(changes.mapPos(hunk.from, -1), changes.mapPos(hunk.to, -1), hunk.theirs);
}

/**
 * What the status bar says about a write that arrived (design 7.2): what
 * came in on its own, and what is waiting on the reader.
 *
 * An agent that came in over MCP gave its name, so the line names it
 * (design 9). That is the whole difference between the two channels:
 * a program that writes a file is anonymous, and one that says who it is
 * can be told apart from the reader's own tools.
 */
function describeWrite(name: string, merged: MergeResult, agent: string | null): string {
  const said = [agent === null ? `${name} changed on disk` : `${agent} wrote ${name}`];
  if (merged.changes.length > 0) said.push(`${count(merged.changes.length, 'change')} merged in`);
  if (merged.conflicts.length > 0) {
    said.push(`${count(merged.conflicts.length, 'conflict')} to settle`);
  }
  return said.join(' · ');
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
  /** Which of the sidebar's panels is showing (design 4.1, 4.4). */
  panel = $state<SidebarPanel>('outline');
  /**
   * Whether the change panels are drawn over the editor (design 4.4).
   *
   * A window preference rather than a document one, like the comments
   * toggle: it says how the reader wants to be shown changes, and they
   * do not want it answered again for every tab.
   */
  review = $state(false);
  /** The versions of the active document, newest first (design 4.4). */
  snapshots = $state<SnapshotInfo[]>([]);
  /**
   * The agent server, as the status bar draws it (design 9, plan WP 3.1).
   *
   * Port zero is the app that could not open one, which is the state a
   * browser build is permanently in and the one a machine with no
   * loopback address would be. Everything else is a running server, with
   * or without anybody connected to it.
   */
  agent = $state<AgentStatus>({ port: 0, endpoint: null, clients: 0 });
  /** The folder tree, and the folder itself (design 4.1, plan WP 2.4). */
  readonly folder: Folder;
  /** Cmd+Shift+F: the content search over that folder. */
  readonly search: FolderSearch;
  /**
   * What Cmd+P found in the folder, matched in Rust. Null until a query
   * has been answered, so an empty list can mean "nothing matches".
   */
  folderMatches = $state<FileMatches | null>(null);
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
  /**
   * Whether the tab strip is the window's title bar (plan WP 2.8).
   *
   * True on macOS under Tauri, where the window has no bar of its own
   * and the strip is drawn where one would be. False in a browser, and
   * on the platforms whose decorations are still the system's.
   */
  titleBar = $state(false);
  /**
   * Whether the window is full screen. macOS takes its three buttons
   * back for the duration and draws them over the top of the screen
   * itself, so the room kept for them goes back to the tabs.
   */
  fullScreen = $state(false);
  /** Whether the strip has to keep room for the window's own buttons. */
  lights: boolean = $derived(this.titleBar && !this.fullScreen);
  /** The page of the PDF in front, one-based. Zero when there is none. */
  pdfPage = $state(0);
  /**
   * What the PDF in front is drawn at, in CSS pixels per point.
   *
   * State rather than a read of the view, because the view is a plain
   * object the status bar cannot watch: a cell that asked `pdfView`
   * would draw 100% for the life of the tab however far the reader
   * zoomed.
   */
  pdfZoom = $state(1);
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
  /**
   * The open PDFs, keyed the way documents are (ADR 0035). A tab names
   * one of these or one of those, and `kind` says which.
   */
  private readonly pdfs = new Map<string, PdfDoc>();
  /**
   * Find over a PDF, which cannot be the editor's search: there is no
   * buffer, only a list of runs per page (ADR 0035).
   */
  readonly pdfSearch = new PdfSearch();
  private closed = $state<ClosedTab[]>([]);
  private mounted: { view: EditorView; tab: Tab } | null = null;
  /** A change step asked for from Read mode, waiting for the editor. */
  private pendingStep: boolean | null = null;
  /** The same, for a conflict: the widget only exists in the editor. */
  private pendingConflict = false;
  private reading: { view: ReadView; tab: Tab } | null = null;
  private viewing: { view: PdfView; tab: Tab } | null = null;
  private untitledCount = 0;
  private epoch = $state(0);
  /** Writes in flight, per document, so two of them cannot race. */
  private readonly writing = new Map<string, Promise<boolean>>();
  private readonly autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One external write at a time per path; see `externalChange`. */
  private readonly externalWrites = new Map<string, Promise<void>>();
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private sessionDelay = 0;
  /** What the last word count cost, which is what the next one waits on. */
  private countCost = 0;
  /** Folders this window has already had the asset scope widened to. */
  private readonly allowed = new Set<string>();
  /** Which Cmd+P keystroke is waiting on Rust, so stale answers are dropped. */
  private paletteQuery = 0;
  /** The file "New file" just made, which opens once it has its name. */
  private justMade: string | null = null;

  constructor(readonly options: WorkspaceOptions) {
    const say = (message: string) => {
      this.status = message;
    };
    this.folder = new Folder(options.commands, say);
    this.search = new FolderSearch(options.commands, say, () => this.folder.root);
  }

  /** Tell the OS what this window is called; `App.svelte` keeps it current. */
  nameWindow(): void {
    this.options.setTitle?.(this.windowTitle);
  }

  activeTab: Tab | null = $derived(this.tabs.find((tab) => tab.id === this.activeId) ?? null);
  activeDoc: Doc | null = $derived(this.activeTab ? this.docOf(this.activeTab) : null);
  /** The PDF in front, or null when the tab in front is not one. */
  activePdf: PdfDoc | null = $derived(this.activeTab ? this.pdfOf(this.activeTab) : null);
  /** What the Changes badge counts: changes the reader has not marked seen. */
  unreviewed: number = $derived(this.activeDoc?.changes.length ?? 0);
  /**
   * Whether the marks are answering a question other than the usual one
   * (design 4.4). It belongs in the status bar because the sidebar can
   * be shut, and a reader looking at marks should never have to wonder
   * what they are marks of.
   */
  comparing: boolean = $derived(this.activeDoc?.against !== null && this.activeDoc !== null);
  /**
   * Hunks this document has open questions about, which is what holds
   * its save (design 7.2). Read off the buffer's own state, because that
   * is where the regions live and where they are mapped through every
   * edit the reader makes.
   */
  unsettled: number = $derived(this.activeDoc ? conflicts(this.activeDoc.state).length : 0);
  /**
   * What the find bar counts. Read from the document's own state rather
   * than the view's, because that is the one both the editor and this
   * derivation already watch.
   */
  matches: MatchCount = $derived.by(() => {
    if (this.activePdf) {
      // `capped` is doing a second job here: the walk over the pages is
      // still going, so the total is a floor and the bar shows `n+`.
      return {
        current: this.pdfSearch.at + 1,
        total: this.pdfSearch.hits.length,
        capped: this.pdfSearch.running,
      };
    }
    const doc = this.activeDoc;
    if (!doc || !this.find.open) return { current: 0, total: 0, capped: false };
    return countMatches(doc.state, getSearchQuery(doc.state));
  });
  /** Tab labels, disambiguated against each other. */
  labels: string[] = $derived(
    tabLabels(
      this.tabs.map((tab) => this.pathOf(tab)),
      // Only reached by a tab with no path at all, which is Settings and
      // an untitled document. A PDF always has a file behind it.
      this.tabs.map((tab) => this.docOf(tab)?.untitledName ?? 'Settings'),
    ),
  );
  canReopen: boolean = $derived(this.closed.length > 0);
  /**
   * What the window is called (plan WP 2.8).
   *
   * Nothing draws it any more — the title bar is the tab strip — but
   * macOS still lists windows by it in the Window menu and under Mission
   * Control, and two windows both answering to "Markdown" are no help
   * there. The tab in front is the answer, as it is in a browser.
   */
  windowTitle: string = $derived.by(() => {
    const at = this.tabs.findIndex((tab) => tab.id === this.activeId);
    return this.labels[at] ?? 'Markdown';
  });
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
   * What the window is actually dressed in: the app's settings, with the
   * settings of the document in front on top of them (design 11, plan
   * WP 2.6).
   *
   * A tab that is not a document has no say, so the settings tab shows
   * the app in the app's own settings, which is the only honest thing
   * for the page that edits them to do.
   */
  applied: Reading = $derived(withOverride(this.settings, this.activeDoc?.reading));
  /** Whether the document in front was given reading settings of its own. */
  overridden: boolean = $derived(this.activeDoc?.reading != null);
  /**
   * Whether the page is a dark one — not the same question as whether the
   * window is. The high-contrast paper is dark inside a light window, and
   * what the reader is reading on decides how the code on it is coloured.
   */
  darkPage: boolean = $derived(pageIsDark(this.applied, this.systemDark));

  /** The document a tab shows, or null for a tab that is not one. */
  docOf(tab: Tab): Doc | null {
    return this.docs.get(tab.docId) ?? null;
  }

  /** The PDF a tab shows, or null for a tab that is not one. */
  pdfOf(tab: Tab): PdfDoc | null {
    return this.pdfs.get(tab.docId) ?? null;
  }

  /**
   * The file a tab shows, whichever kind of thing is showing it.
   *
   * Everything that asks "is this file already open here" has to go
   * through this rather than through `docOf`, because a PDF tab has no
   * `Doc` to answer with and would report every PDF as not open (ADR
   * 0035).
   */
  pathOf(tab: Tab): string | null {
    return this.docOf(tab)?.path ?? this.pdfOf(tab)?.path ?? null;
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
    for (const path of paths) {
      if (isImagePath(path)) continue;
      // A PDF is read by another engine entirely and must not go near
      // `load`, which reads the file as text (ADR 0035).
      if (isPdfPath(path)) await this.openPdf(path);
      else await this.openPath(path);
    }
    if (images.length > 0) await this.importImages(images);
  }

  async openPath(path: string): Promise<boolean> {
    if (isPdfPath(path)) return this.openPdf(path);
    const open = this.tabs.find((tab) => this.pathOf(tab) === path);
    if (open) {
      this.activate(open.id);
      return true;
    }
    // A document belongs to one window (design 6.5). If another window
    // has this file, that window comes forward with the file in front,
    // rather than a second copy of it opening here.
    if (await this.options.commands.revealPath(path)) {
      this.status = `${basename(path)} is open in another window`;
      return true;
    }
    const opened = await this.load(path);
    if (opened === null) return false;
    this.addTab(opened.doc);
    this.remember(path);
    const { meta } = opened;
    this.status = meta.read_only
      ? describeReadOnly(meta.read_only, basename(path), meta)
      : `${basename(path)} · ${describeFormat(meta.format)}`;
    return true;
  }

  /**
   * Read a file and take charge of it. Opening a file and putting one
   * back at launch both start here.
   *
   * The watch on it and the snapshot of what it held when we found it —
   * the version a restore goes back to (design 4.4) — are taken by
   * `open_document` itself, where the bytes already are. Asking for them
   * from here meant every document crossing the bridge again to say what
   * that side had just read, and every file being read twice (plan WP
   * 3.3).
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
    // to let the webview read that folder and below (design 8). One call
    // per folder, not per document: a session of two hundred tabs is
    // usually a handful of folders.
    this.allowImagesIn(path);
    return { doc, meta };
  }

  /**
   * Widen the asset scope to a document's folder, unless this window has
   * already asked for that folder.
   */
  private allowImagesIn(path: string): void {
    const dir = dirname(path);
    if (dir === '' || this.allowed.has(dir)) return;
    this.allowed.add(dir);
    void this.options.commands.allowDocumentImages(path);
  }

  /**
   * Open a PDF (ADR 0035).
   *
   * The road a document takes — `load`, `openDocument`, a `Doc` — is
   * exactly the one this must not: `openDocument` reads the file as
   * text, and a PDF read as text is mojibake with a progress bar. What
   * `open_pdf` does instead is the two things a webview cannot ask for
   * itself. It refuses a file too large to hold whole, which a PDF
   * always is because range requests never engage over the asset
   * protocol. And it widens that protocol's scope to the folder — the
   * call `load` makes on the way past, and the one nothing else would
   * make for a file that never goes through it. Without it the protocol
   * answers 403 and the pane stays blank.
   */
  async openPdf(path: string): Promise<boolean> {
    const open = this.tabs.find((tab) => this.pathOf(tab) === path);
    if (open) {
      this.activate(open.id);
      return true;
    }
    // A file belongs to one window (design 6.5), PDFs included.
    if (await this.options.commands.revealPath(path)) {
      this.status = `${basename(path)} is open in another window`;
      return true;
    }
    return (await this.takePdf(path)) !== null;
  }

  /**
   * Take charge of a PDF and put it in a tab, without asking whether
   * another window has it.
   *
   * The asking is what `openPdf` adds, and it is exactly what a tab
   * arriving from another window must not do: the window that sent it
   * has not written its session down yet, so the registry would still
   * say the file is over there and the tab would be turned away at the
   * door (design 6.5).
   */
  private async takePdf(path: string, place: PdfPlace = PDF_START): Promise<Tab | null> {
    const pdf = this.newPdf(path);
    // Opened now rather than when the pane mounts, because this is the
    // reader's own gesture and the answer to it belongs in the status
    // bar: a page count, or the reason there is not one.
    try {
      await pdf.ensure();
    } catch (error) {
      this.pdfs.delete(pdf.id);
      this.status = describePdfError(error, basename(path));
      return null;
    }
    const tab = this.insert(Workspace.blankTab('pdf', pdf.id, 'read'));
    tab.pdf = { ...place };
    this.remember(path);
    this.status = `${pdf.label} · ${count(pdf.pages, 'page')}`;
    return tab;
  }

  /**
   * A PDF this window is taking charge of, not yet opened.
   *
   * The closure is where the IPC lives, so that `PdfDoc` knows about the
   * port and nothing else — the same division `Doc` has, which is handed
   * its preview options rather than reaching for the workspace.
   */
  private newPdf(path: string): PdfDoc {
    const pdf = new PdfDoc({
      path,
      load: async () => {
        const { pdfEngine, assetUrl } = this.options;
        // A browser build has neither, and a test has whichever it
        // asked for. Saying so beats a pane that renders nothing.
        if (!pdfEngine || !assetUrl) {
          throw new PdfError('unavailable', 'no PDF engine in this build');
        }
        const info = await this.options.commands.openPdf(path);
        if (info.status === 'error') {
          throw new PdfError(
            info.error.kind === 'too_large' ? 'too_large' : 'unavailable',
            describeError(info.error),
          );
        }
        // `open_pdf` widened the asset scope itself; recording it here
        // keeps a markdown document in the same folder from asking
        // again.
        const dir = dirname(path);
        if (dir !== '') this.allowed.add(dir);
        return { document: await pdfEngine.open(assetUrl(path)), byteLen: info.data.byte_len };
      },
    });
    this.pdfs.set(pdf.id, pdf);
    return pdf;
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
    options: { path?: string; meta?: DocumentMeta; untitledName?: string; restore?: string },
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
    if (options.path !== undefined) void this.loadOverride(doc, options.path);
    return doc;
  }

  /**
   * What this document is read in, if the reader gave it settings of its
   * own (design 11). Asked of Rust rather than kept in a table here: the
   * overrides are the app's, and a window holds only the documents it
   * has open.
   */
  private async loadOverride(doc: Doc, path: string): Promise<void> {
    const reading = await this.options.commands.documentOverride(path);
    // The document may have been closed, or saved somewhere else, while
    // this was in flight.
    if (doc.path !== path) return;
    doc.reading = overrideOf(reading);
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

  private addTab(doc: Doc, mode: ViewMode = 'read', at?: number, focus = true): Tab {
    return this.insert(Workspace.blankTab('document', doc.id, mode), at, focus);
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
      pdf: kind === 'pdf' ? { ...PDF_START } : null,
      folded: [],
    };
  }

  /**
   * Put a tab in the strip, after the pinned block, and go to it.
   *
   * `focus` is false only where the tab is being built rather than
   * visited: a restore puts two hundred of them up and the reader ends
   * in one, and going to each on the way meant counting the words of
   * every document in the session (plan WP 3.3).
   */
  private insert(tab: Tab, at?: number, focus = true): Tab {
    const pinned = this.pinnedCount();
    const index = Math.min(Math.max(at ?? this.tabs.length, pinned), this.tabs.length);
    this.tabs.splice(index, 0, tab);
    if (focus) this.activate(tab.id);
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
    // A search is about one document, and a PDF's hits are page numbers
    // in *that* PDF (ADR 0035). Carrying them to the next tab would
    // count matches in a file nobody is looking at.
    if (this.pdfSearch.hits.length > 0 || this.pdfSearch.running) {
      this.pdfSearch.clear();
      void this.runPdfSearch();
    }
    // The panel is about the document in front, so it follows it.
    if (this.sidebar && this.panel === 'history') void this.refreshHistory();
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

  /**
   * Take a tab out of the strip, and say whether that was the last view
   * of its document.
   *
   * What is left to the caller is what closing and moving do not share.
   * A closed tab is remembered so that it can be reopened, and its
   * document is written on the way out; a moved one is neither, because
   * it is not gone — it is in another window, and reopening it here
   * would be a second copy of a document that lives there.
   */
  private remove(
    id: string,
  ): { tab: Tab; doc: Doc | null; pdf: PdfDoc | null; index: number; alone: boolean } | null {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return null;
    const tab = this.tabs[index] as Tab;
    const doc = this.docOf(tab);
    const pdf = this.pdfOf(tab);
    const wasActive = this.activeId === tab.id;
    if (wasActive) {
      this.unmount();
      this.unmountRead();
      this.unmountPdf();
    }
    this.tabs.splice(index, 1);
    const held = doc?.id ?? pdf?.id ?? null;
    const alone = held !== null && !this.tabs.some((other) => other.docId === held);
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.countNow();
    }
    this.touch();
    return { tab, doc, pdf, index, alone };
  }

  close(id: string): void {
    const gone = this.remove(id);
    if (gone === null) return;
    const { tab, doc, pdf, index, alone } = gone;
    this.closed = [{ tab: { ...tab }, doc, pdf, index }, ...this.closed].slice(0, CLOSED_LIMIT);
    // Closing the last tab on a document is the strongest form of
    // leaving it, so autosave writes it (design 6.6) before it goes.
    const saved = alone && this.autosaveOnLeave(doc);
    if (doc && alone) {
      this.docs.delete(doc.id);
      if (doc.path !== null) void this.options.commands.unwatch(doc.path);
    }
    if (pdf) {
      // The engine's copy of the file stays reachable while the tab is
      // in the reopen list; only the last tab on it gives it up, and
      // even then the list is what holds it (see `reopenClosed`).
      this.status = `Closed ${pdf.label}`;
      return;
    }
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
    if (record.pdf) this.pdfs.set(record.pdf.id, record.pdf);
    const tab: Tab = { ...record.tab, id: nextId('tab') };
    this.tabs.splice(Math.min(record.index, this.tabs.length), 0, tab);
    this.activate(tab.id);
    this.touch();
    this.status = `Reopened ${record.doc?.label ?? record.pdf?.label ?? 'Settings'}`;
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

  /**
   * The same for the tab in front, which is what the palette, a key and
   * the menu bar reach it by. Double-clicking a tab is the gesture for
   * it; a gesture nothing names is a feature only its author knows about.
   */
  togglePinActive(): void {
    if (this.activeId !== null) this.togglePin(this.activeId);
  }

  /** Whether the tab in front is pinned, for what that command is called. */
  get activePinned(): boolean {
    return this.activeTab?.pinned ?? false;
  }

  private pinnedCount(): number {
    return this.tabs.filter((tab) => tab.pinned).length;
  }

  // --- more than one window (plan WP 2.5) ---------------------------------

  /** Cmd+Shift+N: another window, empty, over this one (design 4.1). */
  async newWindow(): Promise<void> {
    const made = await this.options.commands.newWindow();
    this.status = made.status === 'error' ? describeError(made.error) : 'New window';
  }

  /**
   * Send a tab to another window, or tear it off into one of its own
   * (design 4.1, 6.5).
   *
   * `dropped` says the tab was let go of with the pointer. Rust reads
   * where the pointer is and decides from that: a window under it takes
   * the tab in, nothing under it tears the tab into a new window there.
   * Without it — the command rather than the drag — it is always a new
   * window.
   *
   * The document goes with the tab, because two webviews cannot share
   * one: its buffer, what the file held, what has been read, and its
   * undo history. It leaves this window only once the other one has been
   * given it, so a window that cannot be reached costs nothing.
   */
  async moveTab(id: string, dropped = false): Promise<boolean> {
    const tab = this.tabs.find((open) => open.id === id);
    if (!tab) return false;
    // A PDF moves too, and it moves differently: what travels is the
    // path, because there is no buffer to carry (ADR 0035).
    const pdf = this.pdfOf(tab);
    if (pdf) return this.movePdf(tab, pdf, dropped);
    const doc = this.docOf(tab);
    if (tab.kind !== 'document' || !doc) {
      this.status = 'Only a document or a PDF can be moved to another window';
      return false;
    }
    if (doc.ephemeral) {
      this.status = `${doc.label} is a version out of the history, not a document to move`;
      return false;
    }
    // A serialized state carries the buffer, the selection and the undo
    // history, and nothing else: the conflict regions do not travel. The
    // window taking the tab in would see a dirty buffer with nothing held
    // against it, start an autosave timer, and eight hundred milliseconds
    // later write "mine" over the version the reader was still deciding
    // about. Settling the conflict first is one click and keeps the
    // choice theirs.
    if (hasConflicts(doc.state)) {
      this.status = `${doc.label} has a conflict open · settle it to move the document`;
      return false;
    }
    // A document lives in one window, so it cannot be half moved. The
    // second view is this window's (design 6.5); closing it is what
    // makes the document free to go.
    if (this.tabs.some((other) => other.id !== tab.id && other.docId === doc.id)) {
      this.status = `${doc.label} has another view in this window · close it to move the document`;
      return false;
    }
    // The live cursor and scroll position are in the view until the tab
    // is asked to give them up.
    this.syncMounted();
    const payload: TabMove = {
      path: doc.path,
      untitled_name: doc.path === null ? doc.untitledName : null,
      meta: doc.meta,
      text: doc.text,
      base: doc.base.toString(),
      reviewed: doc.reviewed.toString(),
      state: serializeEditorState(doc.state),
      mode: tab.mode,
      pinned: tab.pinned,
      anchor: tab.anchor?.offset ?? tab.selection.main.head,
      page: null,
      folded: [...tab.folded],
    };
    // The watch is one entry per path in Rust, so it is given up here,
    // before the other window takes it up. The other order would leave
    // the file watched by nobody.
    if (doc.path !== null) await this.options.commands.unwatch(doc.path);
    const moved = await this.options.commands.moveTab(payload, dropped);
    if (moved.status === 'error') {
      if (doc.path !== null) void this.options.commands.watch(doc.path);
      this.status = describeError(moved.error);
      return false;
    }
    // Not written on the way out: what leaves is the buffer as it
    // stands, dirty dot and all, and the window taking it in is the one
    // that saves it from here.
    this.cancelAutosave(doc);
    this.remove(tab.id);
    this.docs.delete(doc.id);
    this.status = `Moved ${doc.label} to ${moved.data.created ? 'a new window' : 'the window under it'}`;
    return true;
  }

  /**
   * Send a PDF tab to another window.
   *
   * Almost none of what a document has to do applies. There is no
   * buffer, so nothing to serialize and nothing that could be dirty; no
   * conflict to settle; no watch to hand over, because a PDF is not
   * watched. What travels is the path and the page the reader was on,
   * and the window taking it in opens the file for itself — which is
   * also what keeps two windows from holding one engine document.
   */
  private async movePdf(tab: Tab, pdf: PdfDoc, dropped: boolean): Promise<boolean> {
    // The live view holds the reader's place until it is asked, exactly
    // as a mounted editor holds a cursor.
    const place = (this.viewing?.tab.id === tab.id ? this.pdfView?.place() : tab.pdf) ?? PDF_START;
    const payload: TabMove = {
      path: pdf.path,
      untitled_name: null,
      meta: null,
      // The fields that carry a buffer travel empty, and the other side
      // never reads them: it sees a `.pdf` path and opens the file.
      text: '',
      base: '',
      reviewed: '',
      state: '',
      mode: tab.mode,
      pinned: tab.pinned,
      anchor: 0,
      page: place.page,
      folded: [],
    };
    const moved = await this.options.commands.moveTab(payload, dropped);
    if (moved.status === 'error') {
      this.status = describeError(moved.error);
      return false;
    }
    this.remove(tab.id);
    // Given up here rather than left to the collector: the file is held
    // whole in memory and its pages as bitmaps, and the window that now
    // has it is opening its own copy.
    this.pdfs.delete(pdf.id);
    pdf.destroy();
    this.status = `Moved ${pdf.label} to ${moved.data.created ? 'a new window' : 'the window under it'}`;
    return true;
  }

  /** The command, for a reader whose hands are on the keyboard. */
  tearOffActive(): Promise<boolean> {
    return this.activeId === null ? Promise.resolve(false) : this.moveTab(this.activeId);
  }

  /**
   * Take in a tab another window has given up (plan WP 2.5).
   *
   * It comes back as it left: the same view, the same undo history, and
   * the same relationship to the file — a document that was dirty over
   * there is dirty here, and this window's autosave is what settles it.
   */
  async adoptTab(move: TabMove): Promise<void> {
    const path = move.path;
    // Two windows cannot hold one document, and `revealPath` is what
    // keeps one from being opened twice. If it turns up anyway, the tab
    // already here is the one that wins.
    const here = path === null ? undefined : this.tabs.find((tab) => this.pathOf(tab) === path);
    if (here) {
      this.activate(here.id);
      this.status = `${basename(path ?? '')} is already open here`;
      return;
    }
    // The path is what says which kind of thing arrived, the same way
    // it does when the OS hands a file over and when a session is put
    // back (ADR 0035). One rule in three places, rather than a second
    // fact on the wire that could disagree with the first.
    if (path !== null && isPdfPath(path)) {
      const arrived = await this.takePdf(path, {
        page: Math.max(1, move.page ?? 1),
        fraction: 0,
        zoom: 1,
      });
      if (!arrived) return;
      if (move.pinned) this.togglePin(arrived.id);
      this.status = `${basename(path)} moved here`;
      this.touch();
      return;
    }
    const name = move.untitled_name ?? 'Untitled';
    if (path === null) this.untitledCount = Math.max(this.untitledCount, untitledNumber(name));
    const doc = this.newDoc(move.text, {
      ...(path === null ? { untitledName: name } : { path }),
      ...(move.meta === null ? {} : { meta: move.meta }),
      restore: move.state,
    });
    doc.base = Text.of(move.base.split('\n'));
    doc.reviewed = Text.of(move.reviewed.split('\n'));
    const tab = this.addTab(doc, move.mode);
    tab.selection = doc.state.selection;
    tab.anchor = { offset: Math.min(move.anchor, doc.state.doc.length), y: 0 };
    tab.folded = [...move.folded];
    // Through the pin command, which is also what puts the tab in the
    // pinned block at the front of the strip.
    if (move.pinned) this.togglePin(tab.id);
    if (path !== null) {
      void this.options.commands.allowDocumentImages(path);
      void this.options.commands.watch(path);
      this.remember(path);
    }
    // Unsaved work that has just changed windows is work this window
    // now owes the disk (design 6.6).
    if (doc.dirty) this.scheduleAutosave(doc);
    // The marks are not carried, they are derived: what came across is
    // the version the reader had last looked at, and this window works
    // out for itself what has happened since (design 4.4).
    if (!doc.baseline.eq(doc.state.doc)) void this.pushChanges(doc);
    this.status = `${doc.label} moved here`;
    this.touch();
  }

  // --- modes and the editor view ------------------------------------------

  /**
   * Whether this document can be put in an editor at all (design 8).
   *
   * Over ten megabytes it cannot. Read mode draws a window onto the
   * document and holds in the page only what is on screen (plan WP 2.7);
   * an editor holds the whole of it in one live view, with decorations
   * over every visible line and an undo history behind it. Saying so is
   * the honest answer, and better than opening it and hanging.
   */
  private editorFits(doc: Doc): boolean {
    const meta = doc.meta;
    if (meta?.read_only !== 'size') return true;
    this.status = describeReadOnly('size', doc.label, meta);
    return false;
  }

  setMode(mode: ViewMode): void {
    const tab = this.activeTab;
    if (tab?.kind !== 'document' || tab.mode === mode) return;
    if (mode !== 'read' && !this.editorFits(this.doc(tab))) return;
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
        setReviewEffect(this.review),
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
    if (this.pendingConflict) {
      this.pendingConflict = false;
      this.runConflictStep();
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

  /**
   * Put the PDF pane up on the tab in front (ADR 0035).
   *
   * The mirror of `mountRead`, and it guards the same way: a tab says
   * what it is showing, and everything that acts on a buffer asks
   * `activeDoc` rather than `activeTab`. The file itself may not be open
   * yet — a restored session opens none of them — so this is also where
   * one gets opened, and where the reason it would not is reported.
   */
  async mountPdf(parent: HTMLElement): Promise<void> {
    const tab = this.activeTab;
    if (tab?.kind !== 'pdf' || this.viewing) return;
    const pdf = this.pdfOf(tab);
    if (!pdf) return;
    if (!pdf.ready) {
      try {
        await pdf.ensure();
      } catch (error) {
        this.status = describePdfError(error, pdf.label);
        return;
      }
      // The reader may have moved on while the file was opening.
      if (this.activeTab?.id !== tab.id || this.viewing) return;
    }
    const view = new PdfView({
      parent,
      pdf,
      place: tab.pdf ?? { ...PDF_START },
      onPlace: (place) => {
        tab.pdf = place;
        this.pdfPage = place.page;
        this.pdfZoom = place.zoom;
      },
      onTrouble: (message) => {
        this.status = message;
      },
    });
    this.viewing = { view, tab };
    this.pdfPage = view.page;
    this.pdfZoom = view.scale;
  }

  /** Save the reader's place onto the tab and take the pane down. */
  unmountPdf(): void {
    const viewing = this.viewing;
    if (!viewing) return;
    const tab = this.tabs.find((other) => other.id === viewing.tab.id);
    if (tab) tab.pdf = viewing.view.place();
    this.viewing = null;
    viewing.view.destroy();
    this.pdfPage = 0;
    this.pdfZoom = 1;
    this.touch();
  }

  get pdfView(): PdfView | null {
    return this.viewing?.view ?? null;
  }

  /** Cmd+= and Cmd+- over a PDF; the ladder is in `pdf/view.ts`. */
  zoomPdf(delta: 1 | -1): void {
    const tab = this.activeTab;
    const view = this.pdfView;
    if (!view || tab?.kind !== 'pdf') return;
    view.setZoom(stepZoom(view.scale, delta));
    tab.pdf = view.place();
    this.pdfZoom = view.scale;
    this.status = `${Math.round(view.scale * 100)}%`;
    this.touch();
  }

  /** Back to a point per pixel, which is the size the file was made at. */
  resetPdfZoom(): void {
    const view = this.pdfView;
    if (!view) return;
    view.setZoom(1);
    const tab = this.activeTab;
    if (tab) tab.pdf = view.place();
    this.pdfZoom = 1;
    this.status = '100%';
    this.touch();
  }

  /** Go to a page, which is what a bookmark and the status bar both do. */
  goToPdfPage(page: number): void {
    this.pdfView?.goTo(page);
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
    if (!this.editorFits(doc)) return;
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
    let conflictsMoved = false;
    for (const tr of trs) {
      if (conflictsChanged(tr)) {
        conflictsMoved = true;
        // Said here rather than where the choice was made, because the
        // choice is made in two places: the buttons in the widget go
        // straight to the editor, and the palette goes through
        // `settleConflict`. Both arrive as a transaction.
        if (tr.isUserEvent('conflict.keep')) this.status = 'Kept your version';
        else if (tr.isUserEvent('conflict.take')) this.status = 'Took their version';
      }
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
    // A question opening or closing is a reason to reconsider the timer
    // as much as an edit is. Keeping mine settles one without writing a
    // byte, so nothing else would tell the timer that the save it was
    // holding could go ahead; a question opening is what calls off a
    // write the last keystroke had already set.
    if (changed || conflictsMoved) this.scheduleAutosave(doc);
  }

  // --- saving -------------------------------------------------------------

  /**
   * Whether Save is offered at all. A document with a conflict open is
   * still offered it: the save is held, but a greyed-out command with no
   * explanation is worse than one that says why when it is pressed.
   */
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
      this.status = describeReadOnly(doc.meta.read_only, doc.label, doc.meta);
      return false;
    }
    // A conflict is a question about what the file should say, and until
    // it is answered the buffer holds one of the two answers rather than
    // the document (design 7.2). Writing it would settle the question in
    // our favour without asking, and lose theirs -- which is the one
    // thing the whole merge exists to prevent.
    const open = conflicts(doc.state).length;
    if (open > 0) {
      // Said when the reader asked for the save, not when a timer did.
      // The bar already reads `Save held` beside the count; a line about
      // it from a write nobody asked for would only push out the one
      // that says what arrived and why.
      if (options.auto !== true) {
        this.status = `${doc.label}: ${count(open, 'conflict')} to settle before it can be saved`;
      }
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
    const named = doc.path !== path;
    doc.path = path;
    // An untitled document that has just been given a file takes on
    // whatever that path was already being read in.
    if (named) void this.loadOverride(doc, path);
    doc.meta = {
      path,
      byte_len: result.data.byte_len,
      modified_ms: result.data.modified_ms,
      hash: result.data.hash,
      // Whatever it was, it is ours now: the app wrote these bytes, in
      // UTF-8, and a document it can write is one it can edit.
      read_only: null,
      format,
    };
    doc.markSaved(written, options.auto !== true);
    this.remember(path);
    // A save is a version too, and the one a later restore compares
    // with. An autosave says which it is, because the history keeps a
    // run of those as one version rather than one per pause in typing.
    void this.options.commands.snapshot(path, text, options.auto === true ? 'autosave' : 'user');
    if (this.sidebar && this.panel === 'history' && this.activeDoc === doc) {
      void this.refreshHistory();
    }
    if (!wasWatched) {
      void this.options.commands.watch(path);
      // A document that has just been given a folder can show images
      // from it, including any it is about to be given (design 8).
      void this.options.commands.allowDocumentImages(path);
    }
    if (options.auto !== true) this.status = `Saved ${basename(path)}`;
    // Last, because what the marks say is not what the save says: the
    // line in the bar is the answer to the key that was pressed, and it
    // has no business waiting on a scan.
    await this.pushChanges(doc);
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
      // Whoever got in first, we do not know: this is the file re-read
      // after a save was refused, not a report from anybody.
      agent: null,
      changes: [],
    });
    const merged = this.status;
    if (!(await this.writeNow(doc, { ...options, retrying: true }))) {
      // The merge's own message says what arrived and what is left to
      // settle, which is the reason this write did not happen.
      if (hasConflicts(doc.state)) this.status = merged;
      return false;
    }
    if (options.auto !== true) this.status = `${this.status} · ${merged}`;
    return true;
  }

  /**
   * What the save panel opens on for a document with no file yet
   * (design 4.5, scenario S8): a name from its first heading, in a
   * folder this window is already working in.
   */
  private saveTarget(doc: Doc): string {
    const name = proposeFileName(this.firstHeading(doc), doc.untitledName);
    const folder = this.saveFolder();
    return folder === '' ? name : resolvePath(folder, name);
  }

  private firstHeading(doc: Doc): string | null {
    return doc.headingList().entries[0]?.text ?? null;
  }

  private saveFolder(): string {
    const root = this.folder.root;
    for (const tab of this.tabs) {
      const path = this.pathOf(tab);
      // Inside the open folder, beside an open document beats the root
      // of it: that is the part of the folder the reader is working in.
      // A document from somewhere else says nothing about where a new
      // file in this workspace belongs.
      if (path !== null && path !== undefined && (root === null || inside(root, path))) {
        return dirname(path);
      }
    }
    if (root !== null) return root;
    const recent = this.recents[0];
    return recent === undefined ? '' : dirname(recent);
  }

  // --- autosave -----------------------------------------------------------

  /**
   * Whether the timer writes this document (design 6.6).
   *
   * Not one nobody has named: the first save is where the reader says
   * where it goes. Not one the app cannot write either, which is the
   * read-only encodings of WP 1.1. And not one with a conflict open: a
   * timer must not answer a question the reader has not (design 7.2).
   */
  private autosaves(doc: Doc): boolean {
    return (
      this.settings.autosave &&
      doc.path !== null &&
      doc.meta?.read_only == null &&
      !hasConflicts(doc.state)
    );
  }

  /**
   * The buffer moved ahead of the file; put it back in `AUTOSAVE_DELAY`.
   *
   * The timer is cleared before the question of whether to set another
   * one, so this is also how a pending write is called off: a conflict
   * that lands between a keystroke and the timer it set would otherwise
   * leave that timer to fire, be refused, and say so.
   */
  private scheduleAutosave(doc: Doc): void {
    this.cancelAutosave(doc);
    if (!this.autosaves(doc)) return;
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
   * Whatever the disk would not take, kept where it can be got back.
   *
   * A document with a conflict open is held out of every write on
   * purpose: a timer must not answer a question the reader has not
   * (design 7.2). But the window is closing, and what is held back has
   * nowhere else to be. The session records a path for a file-backed
   * document and not its buffer, and versions are taken on a save and on
   * an external write, so a reader who worked for twenty minutes under
   * "Save held" and then pressed Cmd+Q lost all of it, with no copy
   * anywhere. The same road runs through any dirty document the disk did
   * not take: autosave off, or an encoding that opens read-only.
   *
   * A version under the reader's own name is not an answer to the
   * conflict. It is the work, kept, so that answering later is still
   * something they can do.
   */
  private async keepWhatTheDiskRefused(): Promise<void> {
    const kept = [];
    for (const doc of this.docs.values()) {
      // An untitled document has no path to file a version under; the
      // session already carries its whole buffer, which is the same
      // promise kept a different way.
      if (doc.path === null || !doc.dirty) continue;
      kept.push(this.options.commands.snapshot(doc.path, doc.text, 'user'));
    }
    if (kept.length === 0) return;
    await Promise.all(kept);
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
    // The meta first: the document reads it to decide whether the state
    // it is about to build takes typing, and the whole point of this
    // command is that the new one does.
    doc.meta = result.data.meta;
    doc.replace(result.data.content, tab.mode === 'read' ? 'edit' : tab.mode);
    tab.selection = EditorSelection.single(0);
    this.epoch += 1;
    this.status = `Converted ${basename(doc.path)} to UTF-8`;
    return true;
  }

  // --- what an agent asks (design 9, plan WP 3.1) -------------------------

  /**
   * Answer one question the MCP server put to this window.
   *
   * Four of its five tools are questions about a buffer, and a buffer is
   * not something Rust has: the text is the editor's, and the marks and
   * the blocks come out of a parse tree that only lives here. So the
   * server asks and this answers, which costs nothing at all until
   * somebody asks.
   *
   * `failed` is a real answer and not a thrown error. A window that has
   * since closed the tab knows something the server needs to hear, and
   * the alternative is the server waiting out its whole timeout for it.
   */
  agentAnswer(request: AgentRequest): AgentAnswer {
    if (request.ask === 'documents') {
      return { answer: 'documents', documents: this.openDocuments() };
    }
    const doc = this.docFor(request.path);
    if (!doc || doc.ephemeral) {
      return {
        answer: 'failed',
        message: `${basename(request.path)} is not open in this window`,
      };
    }
    const source = doc.text;
    if (request.ask === 'read') {
      return { answer: 'text', text: source, dirty: doc.dirty };
    }
    if (request.ask === 'annotations') {
      return {
        answer: 'annotations',
        annotations: extractAnnotations(parser.parse(source), source).map(agentAnnotation),
      };
    }
    // The two sides as blocks. The alignment itself is Rust's, the same
    // one the gutter and Review are drawn from (design 7.3): this side
    // is the one with the parse trees and that is all it is being asked
    // for.
    return {
      answer: 'changes',
      old: flattenBlocks(parser.parse(request.against), request.against),
      new: doc.blocksFor(doc.state.doc, (text) => flattenBlocks(parser.parse(text), text)),
    };
  }

  /**
   * Every document this window has a tab on, once each.
   *
   * A version opened out of the history is left out: it has no file, it
   * is never saved, and an agent offered a path it cannot write to would
   * be being told something untrue about it (plan WP 2.3).
   */
  private openDocuments(): AgentDocument[] {
    const seen = new Set<string>();
    const documents: AgentDocument[] = [];
    for (const tab of this.tabs) {
      const doc = this.docOf(tab);
      if (!doc || doc.ephemeral || seen.has(doc.id)) continue;
      seen.add(doc.id);
      documents.push(
        agentDocument({
          path: doc.path,
          label: doc.label,
          text: doc.text,
          dirty: doc.dirty,
          modifiedMs: doc.meta?.modified_ms ?? null,
        }),
      );
    }
    return documents;
  }

  /** Wire this window to the server, for as long as it exists. */
  listenForAgents(
    onAsk: (cb: (ask: AgentAsk) => void) => void,
    onStatus: (cb: (status: AgentStatus) => void) => void,
  ): void {
    onAsk((ask) => {
      void this.options.commands.answerAgent(ask.id, this.agentAnswer(ask.request));
    });
    onStatus((status) => {
      this.agent = status;
    });
    void this.options.commands.agentStatus().then((status) => {
      this.agent = status;
    });
  }

  /**
   * A fresh bearer token (plan WP 3.1).
   *
   * The port does not change and neither does anything a client was
   * configured with: `--mcp-stdio` reads the endpoint file every time it
   * connects, so a client set up the way the palette suggests picks the
   * new token up by itself and one set up with the old token by hand
   * stops working, which is what rotating one is for.
   */
  async rotateAgentToken(): Promise<boolean> {
    const done = await this.options.commands.rotateAgentToken();
    this.status =
      done.status === 'ok'
        ? 'New agent token · clients using --mcp-stdio pick it up on their next connection'
        : describeError(done.error);
    return done.status === 'ok';
  }

  /** Copy the configuration to paste into an agent client. */
  async copyAgentConfig(): Promise<boolean> {
    const config = await this.options.commands.agentClientConfig();
    if (config.status !== 'ok') {
      this.status = describeError(config.error);
      return false;
    }
    const ok = await copyText(config.data, this.options.clipboard ?? navigator.clipboard);
    this.status = ok ? 'Copied the agent client configuration' : 'Could not reach the clipboard';
    return ok;
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
   * map through. A hunk both sides changed becomes a conflict region:
   * the buffer keeps our version, theirs is held beside the document,
   * and the reader is offered both (plan WP 2.1). Save is held for that
   * document until they have chosen.
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
  externalChange(change: ExternalChange): Promise<void> {
    // Two of these can be in flight for one path -- the watcher's report
    // of a write, and the re-read a refused save does itself -- and each
    // waits on a merge in Rust. Run at once, the second merges against a
    // base the first is about to replace, and the later answer wins. One
    // at a time per path, and the queue is per path so a slow merge of a
    // ten megabyte document does not hold up a write to another one.
    const queued = (this.externalWrites.get(change.path) ?? Promise.resolve()).then(
      () => this.applyExternalChange(change),
      () => this.applyExternalChange(change),
    );
    const settled = queued.catch(() => undefined);
    this.externalWrites.set(change.path, settled);
    void settled.then(() => {
      if (this.externalWrites.get(change.path) === settled) {
        this.externalWrites.delete(change.path);
      }
    });
    return queued;
  }

  private async applyExternalChange(change: ExternalChange): Promise<void> {
    const doc = this.docFor(change.path);
    if (!doc) return;
    // The merge happens in Rust and the reader does not stop typing for
    // it. What comes back is offsets into the buffer as it was when the
    // question was asked, and applying those to a buffer that has moved
    // since puts somebody else's text in the wrong place -- silently,
    // because a stale offset is usually still in range. So the buffer is
    // checked when the answer arrives, and a merge that was overtaken is
    // asked again against what is there now.
    let merged: MergeResult | null = null;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
      const before = doc.state.doc;
      const result = await this.options.commands.merge3(
        doc.base.toString(),
        doc.text,
        change.content,
      );
      if (doc.state.doc === before) {
        merged = result;
        break;
      }
    }
    // What arrived is kept whatever we do with it, so a hunk still under
    // discussion is in the history rather than gone (design 4.4). An
    // agent write is already in there under the agent's own name, taken
    // by the same call that wrote the file, and taking it again here
    // would be a second row saying `Outside` about the same version.
    if (change.agent === null) {
      void this.options.commands.snapshot(change.path, change.content, 'external');
    }
    if (merged === null) {
      // Three merges overtaken in a row is somebody typing without a
      // pause. Nothing is applied and, more to the point, `base` is left
      // alone: the file on disk is still ahead of what this side thinks
      // it read, so the next save finds the mismatch and merges then,
      // which is the same path a save into a changed file already takes.
      this.status = `${basename(change.path)} changed on disk · it will be merged on the next save`;
      return;
    }
    if (this.sidebar && this.panel === 'history' && this.activeDoc === doc) {
      void this.refreshHistory();
    }
    this.applyExternal(doc, merged);
    // Their version is the file now, so it is what the next merge and the
    // next save compare against.
    doc.base = Text.of(change.content.split('\n'));
    doc.missing = false;
    if (doc.meta) doc.meta = { ...doc.meta, hash: change.hash };
    this.status = describeWrite(basename(change.path), merged, change.agent);
    // Awaited, so that a write is finished when the marks beside it are:
    // the count in the bar and the marks in the margin are one answer to
    // "what arrived", and they may not disagree for a frame.
    await this.pushChanges(doc);
  }

  /**
   * Apply an external write to a document, wherever it is being shown.
   *
   * One transaction carries both halves of the merge. The hunks only
   * they touched are the changes; the hunks both sides touched are the
   * regions, which the reader will settle. Doing it in one is not
   * tidiness: it is one undo step rather than two, and there is no
   * moment in between where the regions name text that has already
   * moved under them.
   *
   * The merge answers in offsets into the buffer as it was, and a state
   * field reads its effects against the buffer as it will be, which is
   * the convention every CodeMirror field is written to. So the change
   * set is built first and the regions are mapped through it.
   */
  private applyExternal(doc: Doc, merged: MergeResult): void {
    if (merged.changes.length === 0 && merged.conflicts.length === 0) return;
    const changes = ChangeSet.of(
      merged.changes.map((edit) => ({ from: edit.from, to: edit.to, insert: edit.insert })),
      doc.state.doc.length,
    );
    const effects: StateEffect<unknown>[] = [];
    if (merged.conflicts.length > 0) {
      effects.push(addConflicts.of(merged.conflicts.map((hunk) => raise(changes, hunk))));
    }
    this.applyTo(doc, { changes, effects, userEvent: 'external.change' });
  }

  /**
   * Put a transaction into a document wherever it is being shown.
   *
   * Read mode has no editor to dispatch to, so the buffer is updated and
   * the page is rendered again from it -- but only when the text moved.
   * A write that is all conflict changes no text, and a reader in Read
   * mode should not be scrolled for a widget they cannot see.
   */
  private applyTo(doc: Doc, spec: TransactionSpec): void {
    const mounted = this.mounted;
    if (mounted && mounted.tab.docId === doc.id) {
      // Through the view, which is what maps the cursor and the folds.
      mounted.view.dispatch(spec);
      return;
    }
    const transaction = doc.state.update(spec);
    const reading = this.reading?.tab.docId === doc.id && transaction.docChanged;
    if (reading) this.unmountRead();
    doc.state = transaction.state;
    for (const tab of this.tabs) {
      if (tab.docId !== doc.id) continue;
      tab.selection = tab.selection.map(transaction.changes);
      if (tab.anchor) {
        tab.anchor = { ...tab.anchor, offset: transaction.changes.mapPos(tab.anchor.offset) };
      }
    }
    // The editor's own dispatch schedules this; a document being read has
    // no editor, and a write that arrived while somebody was reading it
    // was leaving the number in the bar describing the version before.
    if (transaction.docChanged && this.activeDoc?.id === doc.id) this.scheduleWordCount();
    if (reading) this.epoch += 1;
  }

  // --- settling a conflict --------------------------------------------------

  /**
   * Go to the next hunk both sides wrote (scenario S5).
   *
   * Read mode has no cursor to put on one and no widget to draw, so the
   * step happens in Edit, which is the same reasoning as stepping
   * changes: the editor arrives from its own effect a moment later, so
   * the step waits in `pendingConflict` and `mount` runs it.
   */
  stepConflict(): boolean {
    const tab = this.activeTab;
    if (tab?.kind !== 'document') return false;
    if (tab.mode === 'read') {
      this.pendingConflict = true;
      this.setMode('edit');
      return true;
    }
    return this.runConflictStep();
  }

  private runConflictStep(): boolean {
    const view = this.mounted?.view;
    if (!view) return false;
    if (nextConflict(view)) return true;
    this.status = 'Nothing is waiting on you';
    return false;
  }

  /**
   * Settle the region the cursor is in, from the keyboard. The buttons
   * in the widget are the same two calls; this is the way to them for a
   * reader whose hands are on the keys.
   */
  settleConflict(mine: boolean): boolean {
    const view = this.mounted?.view;
    if (!view) return false;
    if (!(mine ? keepMineHere : takeTheirsHere)(view)) {
      this.status = 'Put the cursor in a conflict first';
      return false;
    }
    return true;
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
    // The override is keyed by path, and this is the same document under
    // another one: move it rather than leave it on a name nothing has.
    if (doc.reading !== null) {
      void this.options.commands.setDocumentOverride(event.from, {});
      void this.options.commands.setDocumentOverride(event.to, doc.reading);
    }
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
    this.showChanges(doc, []);
    this.status = 'Marked as reviewed';
  }

  /**
   * Review mode (design 4.4): the changes told rather than marked, with
   * a way to put each one back.
   *
   * Read mode has no editor to draw the panels over, so asking for
   * Review there switches to Edit first — the same reasoning as find and
   * as stepping (ADR 0016).
   */
  toggleReview(): void {
    this.review = !this.review;
    const tab = this.activeTab;
    if (this.review && tab?.kind === 'document' && tab.mode === 'read') this.setMode('edit');
    // A view that is about to be mounted picks this up from `mount`.
    this.mounted?.view.dispatch({ effects: setReviewEffect(this.review) });
    this.status = this.review ? 'Reviewing changes' : 'Review mode off';
    this.touch();
  }

  /** Put back the change the cursor is standing in (design 4.4). */
  revertHere(): boolean {
    const view = this.mounted?.view;
    if (!view) return false;
    if (revertChangeAtCursor(view)) {
      this.scheduleChangeScan();
      return true;
    }
    this.status = 'The cursor is not in a change';
    return false;
  }

  // --- the history panel ----------------------------------------------------

  /** Show one of the sidebar's panels, opening the sidebar if it is shut. */
  showPanel(panel: SidebarPanel): void {
    this.panel = panel;
    this.sidebar = true;
    if (panel === 'outline') this.refreshOutline();
    if (panel === 'history') void this.refreshHistory();
    this.touch();
  }

  /**
   * Every version of the active document the app has kept (design 4.4).
   *
   * A document with no file has no history: the history is keyed by
   * path, and an untitled buffer has never been anywhere to be a version
   * of.
   */
  async refreshHistory(): Promise<void> {
    const path = this.activeDoc?.path ?? null;
    if (path === null) {
      this.snapshots = [];
      return;
    }
    const result = await this.options.commands.listSnapshots(path);
    // The reader has moved to another document while this was coming
    // back, and these are somebody else's versions.
    if (this.activeDoc?.path !== path) return;
    this.snapshots = result.status === 'ok' ? result.data : [];
  }

  private async readVersion(info: SnapshotInfo): Promise<string | null> {
    const result = await this.options.commands.readSnapshot(info.id);
    if (result.status === 'ok') return result.data;
    this.status = describeError(result.error);
    return null;
  }

  /**
   * Measure the marks against a version out of the history, or stop.
   *
   * This is what the panel is for: "what did the AI change since I
   * looked" is the question the gutter answers by default, and this is
   * the same question asked about any moment the app has kept.
   */
  async compareWith(info: SnapshotInfo | null): Promise<void> {
    const doc = this.activeDoc;
    if (!doc) return;
    if (info === null || doc.againstId === info.id) {
      doc.compareWith(null, null);
      this.status = 'Marks show what changed since you last looked';
    } else {
      const text = await this.readVersion(info);
      if (text === null) return;
      doc.compareWith(Text.of(text.split('\n')), info.id);
      this.status = `Marks show what changed since ${snapshotTime(info)}`;
    }
    await this.pushChanges(doc);
  }

  /**
   * Put a version back in the buffer (design 4.4: "restore is itself a
   * user snapshot, so nothing is ever lost").
   *
   * What is in the buffer becomes a version of its own first, because it
   * may never have been one: an unsaved edit exists nowhere else, and a
   * restore that dropped it would be the one way this app can lose text.
   */
  async restoreSnapshot(info: SnapshotInfo): Promise<void> {
    const doc = this.activeDoc;
    if (!doc) return;
    const text = await this.readVersion(info);
    if (text === null) return;
    if (doc.path !== null) await this.options.commands.snapshot(doc.path, doc.text, 'user');
    this.applyTo(doc, {
      changes: { from: 0, to: doc.state.doc.length, insert: text },
      userEvent: 'restore.snapshot',
    });
    this.status = `Restored the version from ${snapshotTime(info)}`;
    void this.refreshHistory();
    await this.pushChanges(doc);
  }

  /**
   * Open a past version in a tab of its own, marked against another one
   * (design 4.4: "diff any two").
   *
   * Against whichever version the panel is comparing with, when the
   * reader has picked one, and otherwise against the version before this
   * one — which is the question a row is usually being asked: what did
   * this one change?
   */
  async openVersion(info: SnapshotInfo): Promise<void> {
    const doc = this.activeDoc;
    const text = await this.readVersion(info);
    if (text === null) return;
    const older = this.snapshots.find((other) => other.timestamp_ms < info.timestamp_ms) ?? null;
    const picked =
      doc && doc.againstId !== null && doc.againstId !== info.id
        ? (this.snapshots.find((other) => other.id === doc.againstId) ?? older)
        : older;
    const against = picked === null ? null : await this.readVersion(picked);
    const label = doc?.label ?? 'Document';
    const view = this.newDoc(text, { untitledName: `${label} at ${snapshotTime(info)}` });
    view.ephemeral = true;
    if (against !== null && picked !== null)
      view.compareWith(Text.of(against.split('\n')), picked.id);
    this.addTab(view, 'source');
    this.status =
      picked === null
        ? `${label} as it was at ${snapshotTime(info)}`
        : `${label}: ${snapshotTime(picked)} to ${snapshotTime(info)}`;
    await this.pushChanges(view);
  }

  /**
   * The blocks of a document as it stands, or null while the parse has
   * not reached the end of it.
   *
   * The tree is the editor's own, kept up to date a keystroke at a time,
   * so a scan of a long document costs a walk and not a parse. Asked for
   * the way the outline asks (design 4.1); where both want it, the
   * second call finds the work done.
   *
   * A parse that has not finished cannot be flattened: the blocks past
   * where it stopped are missing, and a diff would call them all deleted.
   * The marks stay where they are and the next scan tries again, which
   * is the same thing the field does between the keystroke and the diff.
   */
  private blocksOf(doc: Doc): DocBlock[] | null {
    const { tree, complete } = doc.parseTree();
    if (!complete) return null;
    return doc.blocksFor(doc.state.doc, (source) => flattenBlocks(tree, source));
  }

  /**
   * Work out the changes and hand them to the gutter and to Review
   * (plan WP 2.2, WP 2.3).
   *
   * The alignment is Rust's, over the blocks both sides flatten to. What
   * crosses the bridge is the middle: the blocks the two versions
   * already agree on at each end are matched off here, so somebody
   * typing sends a paragraph and not a document.
   */
  private async pushChanges(doc: Doc): Promise<void> {
    // Nothing has happened since they last looked, which is the state a
    // document is opened in and the one a save leaves it in.
    if (doc.baseline === doc.state.doc) {
      this.showChanges(doc, []);
      return;
    }
    const fresh = this.blocksOf(doc);
    if (fresh === null) {
      this.scheduleChangeScan();
      return;
    }
    const old = doc.baselineBlocks();
    const { head, tail } = commonBlocks(old, fresh);
    const of = doc.state.doc;
    const baseline = doc.baseline;
    const aligned = await this.options.commands.blockDiff(
      old.slice(head, old.length - tail),
      fresh.slice(head, fresh.length - tail),
    );
    // The buffer has moved on, so the offsets these were worked out
    // against are not the ones in front of the reader. The transaction
    // that moved it has already asked for another scan.
    if (doc.state.doc !== of) return;
    // The indices name blocks in the slices that were sent, which start
    // `head` into the lists they were cut from.
    const ops = aligned.map((op) => {
      const at = { ...op };
      if ('old' in at) at.old += head;
      if ('new' in at) at.new += head;
      return at;
    });
    this.showChanges(
      doc,
      blockChanges(ops, { blocks: old, text: baseline }, { blocks: fresh, text: of }),
    );
  }

  /** What the gutter, the panels and the badge are told, in one place. */
  private showChanges(doc: Doc, records: ChangeRecord[]): void {
    doc.changes = records;
    const mounted = this.mounted;
    if (mounted && mounted.tab.docId === doc.id) {
      mounted.view.dispatch({ effects: setChanges.of(records) });
    }
  }

  /**
   * The scan waits for the typing to stop rather than running through
   * it: the marks are mapped through every edit as it happens, so what
   * waits here is only the question of which runs there are, and asking
   * it in the middle of a burst answers about a buffer that has already
   * moved on.
   */
  private scheduleChangeScan(): void {
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const doc = this.activeDoc;
      if (doc) void this.pushChanges(doc);
    }, CHANGE_SCAN_DELAY);
  }

  // --- export -------------------------------------------------------------

  /**
   * The document in front as a page of its own (plan WP 3.2).
   *
   * Rendered here rather than lifted out of Read mode: what is in the
   * page there is a screenful and two margins of it, which is the whole
   * point of that view and the wrong thing to save. So the same renderer
   * runs over the whole document, and the same enhancers over the
   * result, and this waits for them -- an export is finished only when
   * every fence, formula and diagram is.
   *
   * What the reader is looking at is what they get: their theme, their
   * paper, their measure, their size, and the comments shown or folded
   * away as they have them.
   */
  async exportHtml(): Promise<void> {
    const tab = this.activeTab;
    const doc = tab && this.docOf(tab);
    if (!doc) return;
    const target = (await this.options.pickExportTarget?.(this.exportTarget(doc))) ?? null;
    if (target === null) return;
    // A large document is a second or two of rendering, and half of that
    // is Shiki over its fences. The line is the only thing that says so.
    this.status = `Exporting ${doc.label}…`;
    const page = await exportPage({
      source: doc.state.doc.toString(),
      title: doc.label,
      images: { path: doc.path, remote: doc.remoteImages },
      comments: this.comments,
      reading: withOverride(this.settings, doc.reading),
      appearance: resolveAppearance(this.settings.appearance, this.systemDark),
      enhancer: this.options.enhancer,
    });
    const result = await this.options.commands.exportHtml(target, page.html, page.images);
    this.status =
      result.status === 'error'
        ? describeError(result.error)
        : describeExport(result.data, basename(target));
  }

  /** Where an exported page is offered: beside the document, named after it. */
  private exportTarget(doc: Doc): string {
    const name = `${(doc.path === null ? this.saveTarget(doc) : basename(doc.path)).replace(/\.[^.]*$/, '')}.html`;
    const folder = doc.path === null ? this.saveFolder() : dirname(doc.path);
    return folder === '' ? name : resolvePath(folder, name);
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
      this.status = describeReadOnly(doc.meta.read_only, doc.label, doc.meta);
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

  /**
   * Undo, and redo beside it.
   *
   * These are commands of the app's rather than the standard menu items,
   * because the editor's history is CodeMirror's and the standard item is
   * WebKit's: `undo:` down the responder chain would put the DOM back
   * underneath the editor, which would read it as something typed. Being
   * a command means the key belongs to the shell now — the menu bar takes
   * Cmd+Z before the webview sees it — so the plain fields the shell has
   * of its own, the find bar and the settings, have to be handed back the
   * undo the browser keeps for them.
   */
  undo(): boolean {
    const view = this.view;
    if (inPlainField(view)) return document.execCommand('undo');
    return view === null ? false : undo(view);
  }

  redo(): boolean {
    const view = this.view;
    if (inPlainField(view)) return document.execCommand('redo');
    return view === null ? false : redo(view);
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
      this.status = describeReadOnly(doc.meta.read_only, doc.label, doc.meta);
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
    if (tab?.kind === 'pdf') {
      // No replace: a PDF is read here and never written. The bar drops
      // that row for a PDF rather than offering one that refuses.
      this.find = { ...this.find, open: true, replace: false };
      void this.runPdfSearch();
      return;
    }
    if (tab?.kind !== 'document') return;
    // Matches are drawn by an editor extension, so a document that has no
    // editor has no find bar either; it says so rather than opening one
    // that would report no matches in a document full of them.
    if (tab.mode === 'read' && !this.editorFits(this.doc(tab))) return;
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
    this.pdfSearch.clear();
    this.pdfView?.setHits([], null);
    this.pushQuery();
    this.focusEditor();
  }

  /** Change the query or a flag, and tell whichever view is searching. */
  updateFind(patch: Partial<FindState>): void {
    this.find = { ...this.find, ...patch };
    if (this.activePdf) {
      void this.runPdfSearch();
      return;
    }
    this.pushQuery();
  }

  /**
   * Search the PDF in front, and mark what is found.
   *
   * Every keystroke starts a new walk and abandons the one before it,
   * which is what `PdfSearch` counts generations for. The marks follow
   * the hits as they arrive, so a long document fills in rather than
   * waiting.
   */
  private async runPdfSearch(): Promise<void> {
    const pdf = this.activePdf;
    if (!pdf) return;
    const { query, caseSensitive, wholeWord, regexp } = this.find;
    if (!this.find.open || query === '') {
      this.pdfSearch.clear();
      this.pdfView?.setHits([], null);
      return;
    }
    try {
      await this.pdfSearch.run(pdf, query, { caseSensitive, wholeWord, regexp });
    } catch (error) {
      // A search that dies quietly reads as a document with no matches
      // in it, which is a worse lie than saying what went wrong.
      this.status = `Cannot search ${pdf.label} · ${
        error instanceof Error ? error.message : String(error)
      }`;
      return;
    }
    if (this.activePdf !== pdf || !this.pdfSearch.matches(query)) return;
    if (pdf.failure !== null) this.status = `Some pages would not be read · ${pdf.failure}`;
    this.pdfView?.setHits(this.pdfSearch.hits, null);
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
    if (this.activePdf) return this.stepPdfHit(forward);
    const view = this.mounted?.view;
    if (!view || this.find.query === '') return false;
    const moved = forward ? findNext(view) : findPrevious(view);
    if (!moved) this.status = `No match for ${this.find.query}`;
    return moved;
  }

  /** Enter in the find bar over a PDF: the next hit, and the page it is on. */
  private stepPdfHit(forward: boolean): boolean {
    const view = this.pdfView;
    const { hits } = this.pdfSearch;
    if (hits.length === 0) {
      if (this.find.query !== '') this.status = `No match for ${this.find.query}`;
      return false;
    }
    const at = stepHit(hits, this.pdfSearch.at, view?.page ?? 1, forward);
    if (at === -1) return false;
    this.pdfSearch.at = at;
    const hit = hits[at];
    if (!hit || !view) return false;
    view.goToHit(hit);
    // Marked after the scroll, so the page it is on is in the page and
    // has a text layer to mark.
    view.setHits(hits, hit);
    return true;
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
    const reason = doc?.meta?.read_only;
    if (!doc?.meta || !reason) return true;
    this.status = describeReadOnly(reason, doc.label, doc.meta);
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
    this.folderMatches = null;
  }

  /**
   * A keystroke in the palette. The tabs and recents are ranked here,
   * where they already are; the folder is matched in Rust, over the walk
   * it keeps, so a folder of fifty thousand files answers as fast as a
   * folder of twelve (plan WP 2.4).
   */
  setPaletteQuery(query: string): void {
    this.palette = { ...this.palette, query, index: 0 };
    void this.matchFiles(query);
  }

  private async matchFiles(query: string): Promise<void> {
    if (this.folder.root === null || query.trim() === '') {
      this.folderMatches = null;
      return;
    }
    this.paletteQuery += 1;
    const asked = this.paletteQuery;
    const found = await this.options.commands.findFiles(query, PALETTE_FILES);
    // Answers can arrive out of order; only the newest question has an
    // answer worth showing.
    if (asked === this.paletteQuery) this.folderMatches = found;
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

  // --- the folder ---------------------------------------------------------

  /** Cmd+Shift+O: choose a folder to work in (design 4.1, scenario S6). */
  async pickAndOpenFolder(): Promise<void> {
    const picked = await this.options.pickFolder?.();
    if (picked !== null && picked !== undefined && picked !== '') await this.openFolder(picked);
  }

  /**
   * Work in `path`: the tree in the sidebar, Cmd+P over its files,
   * Cmd+Shift+F through its contents, and a watch on the whole of it.
   */
  async openFolder(path: string): Promise<void> {
    if (!(await this.folder.open(path))) return;
    this.search.clear();
    this.folderMatches = null;
    this.panel = 'files';
    this.sidebar = true;
    this.status = `Working in ${this.folder.name}`;
    this.touch();
  }

  /**
   * Let it go. The tabs stay: they are documents the reader opened, and
   * closing a folder is not closing what came out of it. The panel stays
   * on Files too, where the recents are (design 4.1).
   */
  closeFolder(): void {
    const name = this.folder.name;
    this.folder.close();
    this.search.clear();
    this.folderMatches = null;
    if (name !== '') this.status = `Closed ${name}`;
    this.touch();
  }

  /** The folder watch: something under the root was written. */
  folderChanged(change: FolderChange): void {
    if (change.root !== this.folder.root) return;
    void this.folder.refresh(change.dirs);
  }

  searchProgress(progress: SearchProgress): void {
    this.search.progress(progress);
  }

  searchDone(done: SearchDone): void {
    this.search.done(done);
  }

  /**
   * Cmd+Shift+F: the folder search, with the sidebar open on it. A
   * selection becomes the query, the way it does for Cmd+F — what the
   * reader has in front of them is usually what they are looking for.
   */
  findInFolder(): void {
    if (this.folder.root === null) {
      this.status = 'Open a folder to search across it';
      return;
    }
    this.panel = 'files';
    this.sidebar = true;
    const selected = this.selectedWithin();
    if (selected !== null && selected !== '') this.search.type(selected);
    // The field itself is in the sidebar, which may only now be
    // arriving; it takes the keyboard from its own effect.
    this.search.wanted += 1;
    this.touch();
  }

  /** A file in the tree. */
  async openFile(path: string): Promise<void> {
    this.folder.selected = path;
    await this.openPath(path);
  }

  /**
   * A search result: the file, at the line the match is on.
   *
   * Read mode has no cursor, so this is the tab's own scroll anchor,
   * which both views honour. The selection goes on the tab as well, so
   * switching to Edit puts the caret on the words that were found.
   */
  async openHit(hit: SearchHit): Promise<void> {
    if (!(await this.openPath(hit.path))) return;
    const tab = this.activeTab;
    const doc = this.activeDoc;
    // The file may have gone to the window that already had it open
    // (design 6.5), and then there is nothing here to put a cursor in.
    if (!tab || !doc || doc.path !== hit.path) return;
    const text = doc.state.doc;
    const line = text.line(Math.min(Math.max(hit.line, 1), text.lines));
    const from = Math.min(line.from + hit.column, line.to);
    const to = Math.min(from + (hit.to - hit.from), line.to);
    tab.selection = EditorSelection.single(from, to);
    tab.anchor = { offset: from, y: 8 };
    const mounted = this.mounted;
    if (mounted && mounted.tab === tab) {
      mounted.view.dispatch({
        selection: tab.selection,
        effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 8 }),
      });
      mounted.view.focus();
      tab.anchor = null;
    } else if (this.reading && this.reading.tab === tab) {
      this.reading.view.scrollToOffset(from);
      tab.anchor = null;
    }
  }

  /**
   * The sidebar's "New file" (design 4.5): an empty file in the selected
   * folder, with its name up for typing. It opens when the name is
   * settled rather than now, so that the field the reader is typing into
   * is not taken from them by a document arriving.
   */
  async newFileInFolder(): Promise<void> {
    const made = await this.folder.newFile();
    if (made === null) return;
    this.justMade = made;
    this.status = `${basename(made)} · name it and press Enter`;
  }

  /** The inline rename, committed. */
  async renameInFolder(path: string, name: string): Promise<void> {
    const opening = this.justMade === path;
    this.justMade = null;
    const to = await this.folder.rename(path, name);
    if (to === null) return;
    // A tab open on it follows, exactly as it does when something else
    // renames the file under us.
    this.fileRenamed({ from: path, to });
    if (!opening) return;
    await this.openFile(to);
    // A file that has just been made is a file to write in, and an empty
    // document has nothing to read — the same reason Cmd+N opens in Edit.
    if (this.activeDoc?.path === to) this.setMode('edit');
  }

  // --- the outline and the sidebar ----------------------------------------

  toggleSidebar(): void {
    this.sidebar = !this.sidebar;
    if (this.sidebar && this.panel === 'outline') this.refreshOutline();
    if (this.sidebar && this.panel === 'history') void this.refreshHistory();
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
    const { entries, complete } = doc.headingList();
    this.outline = entries;
    this.outlineComplete = complete;
  }

  /**
   * What the Outline panel draws, from whichever kind of tab is in front
   * (ADR 0035). A PDF's bookmarks are the same idea as headings and go
   * somewhere else, which is why the destination is a union.
   */
  outlineRows: OutlineRow[] = $derived.by(() => {
    const pdf = this.activePdf;
    if (pdf) return pdf.outline.map(bookmarkRow);
    return this.outline.map(headingRow);
  });

  /** Click an outline entry, of either kind. */
  goToOutline(target: OutlineTarget): void {
    if (target.kind === 'page') {
      this.goToPdfPage(target.page);
      return;
    }
    this.goToOffset(target.id, target.from);
  }

  /** Click an outline entry: scroll in Read, move the cursor in the others. */
  goToHeading(entry: OutlineEntry): void {
    this.goToOffset(entry.id, entry.from);
  }

  private goToOffset(id: string, from: number): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.reading) {
      this.reading.view.scrollToId(id);
      return;
    }
    const view = this.mounted?.view;
    if (!view) return;
    const at = Math.min(from, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.single(at),
      effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 8 }),
    });
    view.focus();
  }

  /**
   * A link in Read mode. The webview never navigates (design 6.2): an
   * outside link goes to the system browser, and a link to a file beside
   * this one opens as a tab.
   *
   * Relative links resolve against the document's own folder rather than
   * the open folder, because that is what they mean: the same link means
   * the same file whether or not a folder happens to be open.
   */
  openLink(href: string, external: boolean): void {
    if (external) {
      if (this.options.openExternal) this.options.openExternal(href);
      else this.status = `Cannot open ${href} here`;
      return;
    }
    const [target = ''] = href.split('#');
    if (target === '') return;
    const from = this.activeDoc?.path;
    if (from === null || from === undefined) {
      this.status = `Save this document to follow ${href}`;
      return;
    }
    void this.openPath(resolvePath(dirname(from), decodeURIComponent(target)));
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
      // A PDF is a file and nothing else, so its entry is a path. It
      // still needs one: `TabState.document` is an index into this list
      // (ADR 0035).
      const pdf = this.pdfOf(tab);
      if (pdf) {
        if (!at.has(pdf.id)) {
          at.set(pdf.id, documents.length);
          documents.push({ path: pdf.path, untitled: null });
        }
        continue;
      }
      const doc = this.docOf(tab);
      // A view of a past version is not a document to come back to: what
      // it holds is in the history it was opened out of (plan WP 2.3).
      if (!doc || doc.ephemeral || at.has(doc.id)) continue;
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
      tabs: this.tabs
        .filter((tab) => this.docOf(tab)?.ephemeral !== true)
        .map((tab) => ({
          kind: tab.kind,
          document: at.get(tab.docId) ?? 0,
          mode: tab.mode,
          pinned: tab.pinned,
          active: tab.id === this.activeId,
          selection: { anchor: tab.selection.main.anchor, head: tab.selection.main.head },
          anchor: tab.anchor?.offset ?? 0,
          // The page, and not the fraction down it: the page is where
          // the reader was, and landing at the top of it is honest.
          page: tab.pdf?.page ?? null,
          folded: [...tab.folded],
        })),
      folder: this.folder.root,
      sidebar: this.sidebar,
      panel: this.panel,
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
    const panel = content.panel;
    this.panel = panel !== undefined && PANELS.includes(panel) ? panel : 'outline';
    this.comments = content.comments ?? false;
    // The folder first, because the tree is what the window looked like.
    // One that has since been moved is not opened and is said to be
    // gone, beside the files that are; the tabs are unaffected either
    // way, since they are documents and not part of any folder.
    const lost =
      content.folder && !(await this.folder.open(content.folder)) ? basename(content.folder) : null;
    const docs: (Doc | null)[] = [];
    // In step with `docs`, because `TabState.document` is one index into
    // one list and a PDF has an entry in it like anything else.
    const pdfs: (PdfDoc | null)[] = [];
    const gone: string[] = [];
    for (const entry of content.documents ?? []) {
      // A PDF is intercepted here as well as in `openPaths`, because
      // `restoreDoc` goes through `load`, which reads a file as text
      // (ADR 0035). Nothing is opened yet: the file is opened when a
      // pane mounts on it, so a session of PDFs costs one.
      if (entry.path && isPdfPath(entry.path)) {
        docs.push(null);
        pdfs.push(this.newPdf(entry.path));
        continue;
      }
      const doc = await this.restoreDoc(entry);
      if (doc === null && entry.path) gone.push(basename(entry.path));
      docs.push(doc);
      pdfs.push(null);
    }
    let active: string | null = null;
    for (const saved of content.tabs ?? []) {
      let tab: Tab;
      if (saved.kind === 'settings') {
        tab = this.openSettings();
      } else if (saved.kind === 'pdf') {
        const pdf = pdfs[saved.document ?? 0];
        if (!pdf) continue;
        tab = this.insert(Workspace.blankTab('pdf', pdf.id, 'read'), undefined, false);
        // The page the reader was on, and the top of it. The file has
        // not been opened yet, so there is nothing to clamp against;
        // the pane does that when it knows how many pages there are.
        tab.pdf = { page: Math.max(1, saved.page ?? 1), fraction: 0, zoom: 1 };
      } else {
        const doc = docs[saved.document ?? 0];
        if (!doc) continue;
        tab = this.addTab(doc, saved.mode ?? 'read', undefined, false);
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
    const missing = lost === null ? gone : [...gone, lost];
    if (missing.length > 0) said.push(`${missing.join(', ')} no longer there`);
    this.status = said.join(' · ');
  }

  /**
   * One entry of a session's document list, back as a document.
   *
   * Never called for a PDF: `load` reads the file as text, which is the
   * one thing that must not happen to one. `restore` routes those away
   * before they reach here (ADR 0035).
   */
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
   * The preferences as a launch found them, or as another window has
   * just changed them (plan WP 2.6). Nothing is written back: this is
   * the file being read, not the reader changing anything.
   */
  applySettings(settings: Settings | null | undefined): void {
    this.settings = readingSettings(settings);
    this.repaint();
  }

  /**
   * Give the document in front reading settings of its own, or change
   * the ones it has (design 11).
   *
   * Applied here and then written, rather than the other way round: the
   * page is the preview, and a reader dragging the measure should see it
   * move rather than watch it arrive. What comes back is what Rust made
   * of it, which is the same value with the numbers put back on the
   * scale.
   */
  async setOverride(change: Override): Promise<void> {
    const doc = this.activeDoc;
    const path = doc?.path ?? null;
    if (!doc || path === null) {
      // Overrides are kept by path, so there is nowhere to put one for
      // a document that has never been anywhere.
      this.status = 'Save this document before giving it its own type';
      return;
    }
    const merged = { ...(doc.reading ?? {}), ...change };
    doc.reading = overrideOf(merged);
    // A paper of its own can make this a dark page inside a light
    // window, and the live editor is the one thing that has to be told.
    this.repaint();
    const saved = await this.options.commands.setDocumentOverride(path, merged);
    if (doc.path !== path) return;
    doc.reading = overrideOf(saved);
    this.repaint();
  }

  /** Put the document in front back on the app's own settings. */
  async clearOverride(): Promise<void> {
    const doc = this.activeDoc;
    if (!doc || doc.reading === null) return;
    await this.setOverride({ paper: null, family: null, size: null, measure: null });
    this.status = 'Reading in the app’s own settings again';
  }

  /**
   * Whether the reading panel is open (plan WP 2.6).
   *
   * It lives here rather than in the component so a command can open it
   * and so it closes when the window does; it is not in the session,
   * because a panel is a gesture rather than a place.
   */
  readingPanel = $state(false);

  toggleReading(): void {
    this.readingPanel = !this.readingPanel;
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
    // Read mode holds the blocks it has measured and a gap standing in
    // for the ones it has not (plan WP 2.7). A change of size or measure
    // is a change to every one of those numbers, so it is told.
    this.reading?.view.remeasure();
  }

  /**
   * Cmd+= and Cmd+- (design 4.5). Zoom is the reading size and not a
   * second number beside it: one thing to set, one thing to remember,
   * and the type scale is drawn for the sizes it steps through.
   *
   * Over a PDF it is the page that grows, because a PDF has no reading
   * size to change — the type in it was set when the file was made. Same
   * key, same gesture, and the tab in front decides what it means, which
   * is the discipline `TabKind` exists for (ADR 0035).
   */
  zoom(steps: number): void {
    if (this.activeTab?.kind === 'pdf') {
      this.zoomPdf(steps > 0 ? 1 : -1);
      return;
    }
    const size = zoomed(this.applied.size, steps);
    if (size === this.applied.size) {
      this.status = `Text size ${size}px · that is as ${steps > 0 ? 'large' : 'small'} as it goes`;
      return;
    }
    this.setSize(size);
    this.status = `Text size ${size}px`;
  }

  resetZoom(): void {
    if (this.activeTab?.kind === 'pdf') {
      this.resetPdfZoom();
      return;
    }
    if (this.applied.size !== DEFAULT_SIZE) this.setSize(DEFAULT_SIZE);
    this.status = `Text size ${DEFAULT_SIZE}px`;
  }

  /**
   * Whichever size the reader is actually changing (plan WP 2.6).
   *
   * A document that was given a size of its own is the one that moves,
   * because that is the size on the screen and the one the key just
   * changed. Every other document is following the app, so the app is
   * what moves for them.
   */
  private setSize(size: number): void {
    if (this.activeDoc?.reading?.size != null) void this.setOverride({ size });
    else this.updateSettings({ size });
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
    await this.keepWhatTheDiskRefused();
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
    this.recount();
  }

  private scheduleWordCount(): void {
    if (this.countTimer !== null) return;
    this.countTimer = setTimeout(
      () => {
        this.countTimer = null;
        this.recount();
      },
      Math.min(COUNT_DELAY_MAX, Math.max(WORD_COUNT_DELAY, this.countCost * COUNT_SHARE)),
    );
  }

  /** The count the status bar shows, with the reader's notes left out. */
  private recount(): void {
    const started = performance.now();
    const doc = this.activeDoc;
    this.words = doc ? doc.wordCount() : 0;
    if (this.sidebar) this.refreshOutline();
    // What this one cost is what the next one waits on.
    this.countCost = performance.now() - started;
  }

  destroy(): void {
    // Dropping the views first, because putting one away is itself a
    // reason to write the session down and would set the timer again.
    this.unmount();
    this.unmountRead();
    this.unmountPdf();
    // A PDF holds its file whole and its pages as bitmaps, and the
    // engine's worker outlives any one of them (ADR 0035).
    for (const pdf of this.pdfs.values()) pdf.destroy();
    this.pdfs.clear();
    for (const record of this.closed) record.pdf?.destroy();
    this.options.pdfEngine?.destroy();
    for (const timer of [this.countTimer, this.changeTimer, this.sessionTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    for (const timer of this.autosaveTimers.values()) clearTimeout(timer);
    this.autosaveTimers.clear();
    // A search still walking a folder has a thread behind it in Rust,
    // and a window that is going has no use for what it finds.
    this.search.cancel();
    this.countTimer = null;
    this.changeTimer = null;
    this.sessionTimer = null;
  }
}
