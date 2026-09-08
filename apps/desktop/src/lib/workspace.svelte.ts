import { EditorSelection, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type EditorMode, setModeEffect } from '@mdreader/editor-core';
import type { Commands, FileFormat } from '@mdreader/ipc';
import { Doc, nextId } from './document.svelte.ts';
import { basename, dirname, shortenDir, tabLabels } from './paths.ts';
import { countWords, describeError, describeFormat } from './text.ts';

/** Read arrives in WP 1.4; the switch shows it, disabled, until then. */
export type ViewMode = EditorMode;

/** One tab: a view onto a document, with the state that is per view. */
export interface Tab {
  id: string;
  docId: string;
  mode: ViewMode;
  pinned: boolean;
  selection: EditorSelection;
  scrollTop: number;
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
  palette = $state<{ open: boolean; kind: PaletteKind; query: string; index: number }>({
    open: false,
    kind: 'files',
    query: '',
    index: 0,
  });

  private readonly docs = new Map<string, Doc>();
  private closed = $state<ClosedTab[]>([]);
  private mounted: { view: EditorView; tab: Tab } | null = null;
  private untitledCount = 0;
  private epoch = $state(0);
  private countTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly options: WorkspaceOptions) {}

  activeTab: Tab | null = $derived(this.tabs.find((tab) => tab.id === this.activeId) ?? null);
  activeDoc: Doc | null = $derived(this.activeTab ? this.doc(this.activeTab) : null);
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
    const result = await this.options.commands.openDocument(path);
    if (result.status === 'error') {
      this.status = describeError(result.error);
      return false;
    }
    const doc = new Doc(result.data.content, { path, meta: result.data.meta });
    this.docs.set(doc.id, doc);
    this.addTab(doc);
    this.remember(path);
    this.status = result.data.meta.read_only
      ? `${basename(path)} is ${result.data.meta.format.encoding}; convert to UTF-8 to edit`
      : `${basename(path)} · ${describeFormat(result.data.meta.format)}`;
    return true;
  }

  async pickAndOpen(): Promise<void> {
    const picked = (await this.options.pickFiles?.()) ?? [];
    await this.openPaths(picked);
  }

  newUntitled(): void {
    this.untitledCount += 1;
    const doc = new Doc('', { untitledName: `Untitled ${this.untitledCount}` });
    this.docs.set(doc.id, doc);
    this.addTab(doc);
  }

  /** A second view onto the same document; undo is shared through its state. */
  duplicateView(): void {
    const tab = this.activeTab;
    if (!tab) return;
    // The live cursor lives in the view until the tab gives it up.
    this.syncMounted();
    const copy = this.addTab(this.doc(tab));
    copy.mode = tab.mode;
    copy.selection = tab.selection;
  }

  private addTab(doc: Doc, at?: number): Tab {
    const tab: Tab = {
      id: nextId('tab'),
      docId: doc.id,
      mode: 'edit',
      pinned: false,
      selection: EditorSelection.single(0),
      scrollTop: 0,
    };
    const pinned = this.pinnedCount();
    const index = Math.min(Math.max(at ?? this.tabs.length, pinned), this.tabs.length);
    this.tabs.splice(index, 0, tab);
    this.activate(tab.id);
    return this.tabs[index] as Tab;
  }

  private remember(path: string): void {
    this.recents = [path, ...this.recents.filter((p) => p !== path)].slice(0, RECENTS_LIMIT);
  }

  // --- tabs ---------------------------------------------------------------

  activate(id: string | null): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.countNow();
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
    if (wasActive) this.unmount();
    this.tabs.splice(index, 1);
    this.closed = [{ tab: { ...tab }, doc, index }, ...this.closed].slice(0, CLOSED_LIMIT);
    if (!this.tabs.some((other) => other.docId === doc.id)) this.docs.delete(doc.id);
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activeId = next?.id ?? null;
      this.countNow();
    }
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
    const tab: Tab = { ...record.tab, id: nextId('tab') };
    this.tabs.splice(Math.min(record.index, this.tabs.length), 0, tab);
    this.activate(tab.id);
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
  }

  private pinnedCount(): number {
    return this.tabs.filter((tab) => tab.pinned).length;
  }

  // --- modes and the editor view ------------------------------------------

  setMode(mode: ViewMode): void {
    const tab = this.activeTab;
    if (!tab || tab.mode === mode) return;
    tab.mode = mode;
    this.mounted?.view.dispatch({ effects: setModeEffect(mode) });
  }

  get view(): EditorView | null {
    return this.mounted?.view ?? null;
  }

  focusEditor(): void {
    this.mounted?.view.focus();
  }

  /** Mount the active tab's view. The component calls this from an effect. */
  mount(parent: HTMLElement): void {
    const tab = this.activeTab;
    if (!tab || this.mounted) return;
    const doc = this.doc(tab);
    const view: EditorView = new EditorView({
      state: doc.state,
      parent,
      dispatchTransactions: (trs) => this.applyTransactions(view, trs),
    });
    this.mounted = { view, tab };
    view.dispatch({ selection: tab.selection, effects: setModeEffect(tab.mode) });
    view.scrollDOM.scrollTop = tab.scrollTop;
    view.focus();
  }

  /** Copy what the live view knows back onto the tab that owns it. */
  private syncMounted(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    const tab = this.tabs.find((other) => other.id === mounted.tab.id);
    if (tab) {
      tab.selection = mounted.view.state.selection;
      tab.scrollTop = mounted.view.scrollDOM.scrollTop;
    }
    const doc = this.docs.get(mounted.tab.docId);
    if (doc) doc.state = mounted.view.state;
  }

  /** Save the view state back onto its tab and drop the view. */
  unmount(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    this.syncMounted();
    this.mounted = null;
    mounted.view.destroy();
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
    if (changed) this.scheduleWordCount();
  }

  // --- saving -------------------------------------------------------------

  get canSave(): boolean {
    const doc = this.activeDoc;
    return doc !== null && !doc.meta?.read_only;
  }

  async save(): Promise<boolean> {
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
    this.saving = true;
    const result = await this.options.commands.saveDocument(
      path,
      written.toString(),
      doc.meta?.hash ?? null,
      format,
    );
    this.saving = false;
    if (result.status === 'error') {
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
    this.remember(path);
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
    doc.replace(result.data.content, tab.mode);
    doc.meta = result.data.meta;
    tab.selection = EditorSelection.single(0);
    this.epoch += 1;
    this.status = `Converted ${basename(doc.path)} to UTF-8`;
    return true;
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

  // --- word count ---------------------------------------------------------

  countNow(): void {
    if (this.countTimer !== null) {
      clearTimeout(this.countTimer);
      this.countTimer = null;
    }
    this.words = countWords(this.activeDoc?.text ?? '');
  }

  private scheduleWordCount(): void {
    if (this.countTimer !== null) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.words = countWords(this.activeDoc?.text ?? '');
    }, WORD_COUNT_DELAY);
  }

  destroy(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer);
    this.unmount();
  }
}
