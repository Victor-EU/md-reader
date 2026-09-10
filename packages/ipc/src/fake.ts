import type {
  AgentAnswer,
  AgentAsk,
  AgentRequest,
  AgentStatus,
  AssetWrite,
  Block,
  BlockOp,
  Commands,
  DirEntry,
  Document,
  ExportWrite,
  ExternalChange,
  FileFormat,
  FileHit,
  FileMatches,
  FileRemoved,
  FileRenamed,
  FolderChange,
  Error as IpcError,
  MenuSection,
  MergeResult,
  Override,
  PositionEdit,
  ReadOnly,
  Restore,
  Result,
  SaveResult,
  SearchDone,
  SearchHit,
  SearchProgress,
  Settings,
  SnapshotAuthor,
  SnapshotInfo,
  TabMove,
  WindowContent,
} from './index.ts';
import { EDITABLE_BYTES, OPEN_BYTES } from './index.ts';

/**
 * An in-memory implementation of the generated command surface, for the
 * shell's tests: the same `Commands` type, so a test cannot drift from
 * the contract, and the same error kinds. Files live in a map; the
 * hash is a cheap digest of the content, which is all a hash check needs.
 * Behaviour mirrors `crates/core`: a stale hash refuses the save, a
 * missing file is recreated, a read-only encoding refuses the save.
 */
export interface FakeFile {
  content: string;
  format?: Partial<FileFormat>;
  read_only?: ReadOnly | null;
  /**
   * What the file weighs on disk, when a test needs a size it does not
   * want to hold in memory. Design 8's ceilings are megabytes apart, and
   * a test about them is about the number, not about the bytes.
   */
  byte_len?: number;
}

export interface FakeIpc {
  commands: Commands;
  files: Map<string, FakeFile>;
  /** Paths the shell has asked to watch. */
  watching: Set<string>;
  /** The session as the shell last pushed it, and what a launch reads. */
  session: { content: WindowContent | null; recents: string[] };
  settings: Settings;
  /** What single documents have been given to be read in, by path (plan WP 2.6). */
  overrides: Map<string, Override>;
  /** Tell the shell the preferences changed, the way Rust's event does. */
  changeSettings(settings: Settings): void;
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
  /** Files a launch is holding for the window; drained by `takeLaunchPaths`. */
  launch: string[];
  /**
   * The windows there are, `main` first, as `newWindow` and a torn-off
   * tab have made them (plan WP 2.5).
   */
  windows: string[];
  /** Tabs the shell has handed to another window, in the order it did. */
  moved: TabMove[];
  /** Tabs waiting for this window; drained by `takeMovedTabs`. */
  arriving: TabMove[];
  /**
   * Files another window has open. `revealPath` answers for these, which
   * is the one thing a single-window fake cannot know by itself.
   */
  elsewhere: Set<string>;
  /** Hand a tab to this window, the way Rust's event does. */
  deliverTab(move: TabMove): void;
  onTabArrived(cb: (move: TabMove) => void): () => void;
  /** How many times the shell has asked for an immediate write. */
  flushes: number;
  /** Set when the shell has said it is ready for the window to close. */
  closed: boolean;
  /** Simulate a write by another process, and report what the watcher would say. */
  externalWrite(path: string, content: string): ExternalChange;
  /** Simulate the file being deleted under an open tab. */
  externalRemove(path: string): FileRemoved;
  /** Simulate the file being renamed by something else. */
  externalRename(from: string, to: string): FileRenamed;
  onExternalChange(cb: (change: ExternalChange) => void): () => void;
  /** The folder the shell has open, as `open_folder` left it. */
  folder: string | null;
  /**
   * The three folder events Rust pushes at the window. Registered the
   * same way the real ones are listened to in `main.ts`, so a test wires
   * the shell up exactly as the app does.
   */
  onFolderChange(cb: (change: FolderChange) => void): () => void;
  onSearchProgress(cb: (progress: SearchProgress) => void): () => void;
  onSearchDone(cb: (done: SearchDone) => void): () => void;
  /** Every command call, for assertions on what the shell asked for. */
  calls: { command: string; args: unknown[] }[];
  /**
   * Simulate a write over MCP: the same event a watcher write makes, with
   * a name on it (design 9, plan WP 3.1).
   */
  agentWrite(path: string, content: string, agent: string): ExternalChange;
  /**
   * Ask the window something the way the MCP server does, and wait for
   * what it says back through `answerAgent`.
   */
  askAgent(request: AgentRequest): Promise<AgentAnswer>;
  onAgentAsk(cb: (ask: AgentAsk) => void): () => void;
  /** Tell the windows the server's state changed, the way Rust's event does. */
  changeAgentStatus(status: AgentStatus): void;
  onAgentStatus(cb: (status: AgentStatus) => void): () => void;
  /** The status as `agent_status` answers it. */
  agentStatus: AgentStatus;
  /** How many times the reader has asked for a fresh token. */
  rotations: number;
  /** The menu bar the window last described (build plan section 8). */
  menu: MenuSection[];
}

/**
 * One edit covering everything two texts do not already share at their
 * ends, in UTF-16 offsets, which is what the real one produces for a
 * change that falls in one place.
 */
export function singleEdit(from: string, to: string): PositionEdit[] {
  if (from === to) return [];
  let head = 0;
  while (head < from.length && head < to.length && from[head] === to[head]) head += 1;
  // Never between the halves of a surrogate pair.
  if (head > 0 && isLow(from.charCodeAt(head))) head -= 1;
  let tail = 0;
  while (
    tail < from.length - head &&
    tail < to.length - head &&
    from[from.length - 1 - tail] === to[to.length - 1 - tail]
  )
    tail += 1;
  if (tail > 0 && isLow(from.charCodeAt(from.length - tail))) tail -= 1;
  return [{ from: head, to: from.length - tail, insert: to.slice(head, to.length - tail) }];
}

const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

export function fakeHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A block alignment with none of the passes that make the real one worth
 * having: a longest common subsequence over the blocks, and what is left
 * over paired off in the order it comes. No similarity threshold, no
 * moves, one word run per changed block.
 *
 * It is enough for the shell, whose job is to flatten both sides, send
 * the middle, and turn what comes back into marks. Which blocks pair
 * with which is decided in `crates/core/src/blocks.rs` and tested there
 * against the semantic diff cases of design 7.3.
 */
export function fakeAlign(old: Block[], fresh: Block[]): BlockOp[] {
  const same = (a: Block | undefined, b: Block | undefined) =>
    a !== undefined && b !== undefined && a.kind === b.kind && a.text === b.text;
  const rows = old.length;
  const columns = fresh.length;
  const table = new Int32Array((rows + 1) * (columns + 1));
  const cell = (at: number) => table[at] ?? 0;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const at = row * (columns + 1) + column;
      table[at] = same(old[row], fresh[column])
        ? cell(at + columns + 2) + 1
        : Math.max(cell(at + columns + 1), cell(at + 1));
    }
  }
  const ops: BlockOp[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && same(old[row], fresh[column])) {
      ops.push({ op: 'equal', old: row, new: column });
      row += 1;
      column += 1;
      continue;
    }
    const fromRow = row;
    const fromColumn = column;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && same(old[row], fresh[column])) break;
      const at = row * (columns + 1) + column;
      if (row < rows && (column >= columns || cell(at + columns + 1) >= cell(at + 1))) row += 1;
      else column += 1;
    }
    const paired = Math.min(row - fromRow, column - fromColumn);
    for (let step = paired; step < row - fromRow; step += 1) {
      ops.push({ op: 'deleted', old: fromRow + step });
    }
    for (let step = 0; step < column - fromColumn; step += 1) {
      const at = fromColumn + step;
      if (step < paired) {
        ops.push({
          op: 'changed',
          old: fromRow + step,
          new: at,
          words: [
            {
              old_from: 0,
              old_to: old[fromRow + step]?.text.length ?? 0,
              new_from: 0,
              new_to: fresh[at]?.text.length ?? 0,
            },
          ],
        });
      } else ops.push({ op: 'inserted', new: at });
    }
  }
  return ops;
}

const ok = <T>(data: T): Result<T, IpcError> => ({ status: 'ok', data });
const err = <T>(error: IpcError): Result<T, IpcError> => ({ status: 'error', error });
const SEPARATOR = /[/\\]/;

function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? '' : path.slice(0, cut);
}

function basename(path: string): string {
  return path.split(SEPARATOR).pop() ?? path;
}

/**
 * The fake's fuzzy match: the leftmost subsequence, with the positions it
 * used. Which of two files scores higher is `nucleo`'s business and is
 * settled in `crates/core`; what the shell needs from a fake is an
 * answer of the right shape, with the right file in it.
 */
function subsequence(query: string, text: string): number[] | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let at = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found < 0) return null;
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

function defaultFormat(content: string): FileFormat {
  return {
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    mixed_eol: false,
    bom: false,
    // An empty file has no stored form to preserve, so the app's own
    // is used, as `crates/core` does.
    trailing_newline: content === '' || content.endsWith('\n'),
    encoding: 'utf-8',
  };
}

/** The magic numbers the real `store_asset` recognises, for the fake. */
/** What `EMBED_LIMIT` is worth in `crates/core/src/export.rs`. */
const EXPORT_EMBED_LIMIT = 4 * 1024 * 1024;

function fakeSniff(bytes: string): string | null {
  if (bytes.startsWith('\x89PNG')) return 'png';
  if (bytes.startsWith('\xff\xd8\xff')) return 'jpg';
  if (bytes.startsWith('GIF8')) return 'gif';
  if (bytes.trimStart().startsWith('<svg')) return 'svg';
  return null;
}

export function createFakeIpc(initial: Record<string, string | FakeFile> = {}): FakeIpc {
  const files = new Map<string, FakeFile>();
  for (const [path, file] of Object.entries(initial))
    files.set(path, typeof file === 'string' ? { content: file } : file);
  const listeners = new Set<(change: ExternalChange) => void>();
  const folderListeners = new Set<(change: FolderChange) => void>();
  const progressListeners = new Set<(progress: SearchProgress) => void>();
  const doneListeners = new Set<(done: SearchDone) => void>();
  const tabListeners = new Set<(move: TabMove) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();
  const askListeners = new Set<(ask: AgentAsk) => void>();
  const statusListeners = new Set<(status: AgentStatus) => void>();
  /** Questions the fake server has out with the window, by id. */
  const answering = new Map<number, (answer: AgentAnswer) => void>();
  let nextAsk = 0;
  const overrides = new Map<string, Override>();
  const elsewhere = new Set<string>();
  const calls: FakeIpc['calls'] = [];
  const watching = new Set<string>();
  const state = {
    session: { content: null as WindowContent | null, recents: [] as string[] },
    settings: { autosave: true } as Settings,
    launch: [] as string[],
    flushes: 0,
    closed: false,
    folder: null as string | null,
    windows: ['main'],
    moved: [] as TabMove[],
    arriving: [] as TabMove[],
    agentStatus: {
      port: 51_234,
      endpoint: '/app-data/mcp.json',
      clients: 0,
    } as AgentStatus,
    rotations: 0,
    menu: [] as MenuSection[],
  };
  /** The search that has been started and not yet replaced or cancelled. */
  let search = 0;
  const history = new Map<string, { info: SnapshotInfo; content: string }[]>();
  /** What the last known disk content was, so a change reports edits from it. */
  const seen = new Map<string, string>();
  let snapshots = 0;
  const record = <T>(command: string, args: unknown[], result: T): Promise<T> => {
    calls.push({ command, args });
    return Promise.resolve(result);
  };
  /** What the folder watch would say about a write under the open folder. */
  const touched = (dir: string): void => {
    const root = state.folder;
    if (root === null || !dir.startsWith(root)) return;
    for (const cb of folderListeners) cb({ root, dirs: [dir] });
  };
  /**
   * Store a version, as `History::snapshot` does: the same content twice
   * running is the same version, not a second one.
   */
  const take = (path: string, content: string, author: string): SnapshotInfo => {
    const taken = history.get(path) ?? [];
    const latest = taken[taken.length - 1];
    if (latest?.content === content) return latest.info;
    snapshots += 1;
    const info: SnapshotInfo = {
      id: `snapshot-${snapshots}`,
      path,
      author: author as SnapshotAuthor,
      agent: null,
      timestamp_ms: Date.now(),
      hash: fakeHash(content),
      byte_len: new TextEncoder().encode(content).length,
    };
    taken.push({ info, content });
    history.set(path, taken);
    return info;
  };
  const read = (path: string): Result<Document, IpcError> => {
    const file = files.get(path);
    if (!file) return err({ kind: 'read', path, message: 'No such file or directory' });
    const format = { ...defaultFormat(file.content), ...file.format };
    const byteLen = file.byte_len ?? new TextEncoder().encode(file.content).length;
    // Design 8's ceilings, as `read_document` applies them.
    if (byteLen > OPEN_BYTES) {
      return err({ kind: 'too_large', path, byte_len: byteLen, limit: OPEN_BYTES });
    }
    const reason: ReadOnly | null =
      format.encoding === 'utf-8' ? (byteLen > EDITABLE_BYTES ? 'size' : null) : 'encoding';
    return ok({
      content: file.content,
      meta: {
        path,
        byte_len: byteLen,
        modified_ms: Date.now(),
        hash: fakeHash(file.content),
        read_only: file.read_only === undefined ? reason : file.read_only,
        format,
      },
    });
  };
  /**
   * The fake half of `store_asset`: the same folder, the same sniffing,
   * the same reuse of a name whose bytes are already there, so a shell
   * test sees the path the real command would have written to.
   */
  const storeAsset = (
    document: string,
    name: string,
    bytes: string,
  ): Result<AssetWrite, IpcError> => {
    const cut = Math.max(document.lastIndexOf('/'), document.lastIndexOf('\\'));
    if (cut < 0) return err({ kind: 'write', path: document, message: 'no folder for images' });
    const ext = fakeSniff(bytes);
    if (ext === null) return err({ kind: 'write', path: name, message: 'not an image' });
    const stem = (name.split(/[/\\]/).pop() ?? '').replace(/\.[^.]*$/, '').trim() || 'image';
    const dir = `${document.slice(0, cut)}/assets`;
    for (let n = 0; n < 100; n++) {
      const file = `${stem}${n === 0 ? '' : `-${n}`}.${ext}`;
      const path = `${dir}/${file}`;
      const existing = files.get(path);
      if (existing && existing.content !== bytes) continue;
      if (!existing) files.set(path, { content: bytes });
      return ok({ path, relative: `assets/${file}`, written: !existing });
    }
    return err({ kind: 'write', path: dir, message: 'too many images with this name' });
  };

  /**
   * The fake half of `write_export`: the same sentinel, the same choice
   * between carrying the images and putting them in a folder beside the
   * page, so a shell test can read the line the status bar will show and
   * the page the reader will open.
   */
  const writeExport = (
    path: string,
    html: string,
    images: string[],
  ): Result<ExportWrite, IpcError> => {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const stem = path.slice(cut + 1).replace(/\.[^.]*$/, '');
    const total = images.reduce((sum, image) => sum + (files.get(image)?.content.length ?? 0), 0);
    const folder = total <= EXPORT_EMBED_LIMIT ? null : `${path.slice(0, cut)}/${stem}-images`;
    let missing = 0;
    const urls = images.map((image) => {
      const name = image.split(/[/\\]/).pop() ?? '';
      const content = files.get(image)?.content;
      const ext = content === undefined ? null : fakeSniff(content);
      if (content === undefined || ext === null) {
        missing += 1;
        return name;
      }
      if (folder === null) return `data:image/${ext};base64,${btoa(content)}`;
      files.set(`${folder}/${name}`, { content });
      return `${stem}-images/${name}`;
    });
    files.set(path, {
      content: html.replace(/mdr-export-image-(\d+)/g, (whole, n) => urls[Number(n)] ?? whole),
    });
    return ok({ path, embedded: folder === null, images: images.length, missing, folder });
  };

  const commands: Commands = {
    openDocument: (path) => {
      const result = read(path);
      // Rust records the version it found the file in and starts watching
      // it, inside the same command: the bytes are already there, so
      // nothing crosses the bridge to say so (plan WP 3.3).
      if (result.status === 'ok') {
        if (result.data.meta.read_only !== 'size') take(path, result.data.content, 'user');
        watching.add(path);
      }
      return record('open_document', [path], result);
    },
    saveDocument: (path, content, expectedHash, format) => {
      const args = [path, content, expectedHash, format];
      if (format.encoding !== 'utf-8') {
        return record(
          'save_document',
          args,
          err<SaveResult>({ kind: 'read_only_encoding', path, encoding: format.encoding }),
        );
      }
      const existing = files.get(path);
      if (existing && expectedHash !== null && fakeHash(existing.content) !== expectedHash) {
        return record(
          'save_document',
          args,
          err<SaveResult>({
            kind: 'hash_mismatch',
            path,
            expected: expectedHash,
            actual: fakeHash(existing.content),
          }),
        );
      }
      const stored = format.eol === 'crlf' ? content.replace(/\r?\n/g, '\r\n') : content;
      const withTrailing =
        format.trailing_newline && stored.length > 0 && !/[\r\n]$/.test(stored)
          ? `${stored}\n`
          : stored;
      files.set(path, { content: withTrailing, format });
      return record(
        'save_document',
        args,
        ok({
          hash: fakeHash(withTrailing),
          byte_len: withTrailing.length,
          modified_ms: Date.now(),
        }),
      );
    },
    convertDocumentToUtf8: (path) => {
      const file = files.get(path);
      if (file)
        // No `read_only` of its own: the rule above decides again, the
        // way Rust's convert re-reads the file it just wrote.
        files.set(path, {
          content: file.content,
          format: { ...file.format, encoding: 'utf-8' },
        });
      return record('convert_document_to_utf8', [path], read(path));
    },
    allowDocumentImages: (path) => record('allow_document_images', [path], ok(null)),
    writeAsset: (document, name, data) =>
      record('write_asset', [document, name, data], storeAsset(document, name, atob(data))),
    exportHtml: (path, html, images) =>
      record('export_html', [path, html, images], writeExport(path, html, images)),
    importAsset: (document, source) => {
      const file = files.get(source);
      const result = file
        ? storeAsset(document, source.split(/[/\\]/).pop() ?? '', file.content)
        : err<AssetWrite>({ kind: 'read', path: source, message: 'No such file or directory' });
      return record('import_asset', [document, source], result);
    },
    watch: (path) => {
      watching.add(path);
      seen.set(path, files.get(path)?.content ?? '');
      return record('watch', [path], ok(null));
    },
    unwatch: (path) => {
      watching.delete(path);
      return record('unwatch', [path], ok(null));
    },
    /**
     * The whole document as one hunk, which is the degenerate case of the
     * real merge and enough for the shell: what the shell has to get
     * right is applying what comes back and setting a conflict aside.
     * Whether a hunk conflicts is decided in `crates/core/src/diff.rs`
     * and tested there against the design's merge table.
     */
    merge3: (base, ours, theirs) => {
      const result: MergeResult =
        theirs === base || ours === theirs
          ? { changes: [], conflicts: [] }
          : ours === base
            ? { changes: singleEdit(ours, theirs), conflicts: [] }
            : {
                changes: [],
                conflicts: [{ from: 0, to: ours.length, ours, theirs }],
              };
      calls.push({ command: 'merge3', args: [base, ours, theirs] });
      return Promise.resolve(result);
    },
    snapshot: (path, content, author) =>
      record('snapshot', [path, content, author], ok(take(path, content, author))),
    listSnapshots: (path) =>
      record(
        'list_snapshots',
        [path],
        ok([...(history.get(path) ?? [])].reverse().map((taken) => taken.info)),
      ),
    readSnapshot: (id) => {
      const found = [...history.values()].flat().find((taken) => taken.info.id === id);
      return record(
        'read_snapshot',
        [id],
        found
          ? ok(found.content)
          : err<string>({ kind: 'unavailable', what: 'the history', message: `no snapshot ${id}` }),
      );
    },
    loadWindow: () =>
      record<Restore>('load_window', [], {
        content: state.session.content,
        recents: [...state.session.recents],
        settings: { ...state.settings },
      }),
    saveWindow: (content, recents) => {
      state.session = { content, recents: [...recents] };
      return record<void>('save_window', [content, recents], undefined);
    },
    saveSettings: (settings) => {
      state.settings = { ...settings };
      // Rust tells every window, this one included (plan WP 2.6).
      for (const cb of settingsListeners) cb({ ...settings });
      return record<void>('save_settings', [settings], undefined);
    },
    documentOverride: (path) =>
      record<Override>('document_override', [path], { ...(overrides.get(path) ?? {}) }),
    setDocumentOverride: (path, reading) => {
      const kept = Object.fromEntries(
        Object.entries(reading).filter(([, value]) => value !== null && value !== undefined),
      ) as Override;
      if (Object.keys(kept).length === 0) overrides.delete(path);
      else overrides.set(path, kept);
      return record<Override>('set_document_override', [path, reading], {
        ...(overrides.get(path) ?? {}),
      });
    },
    flushState: () => {
      state.flushes += 1;
      return record('flush_state', [], ok(null));
    },
    takeLaunchPaths: () => {
      const paths = [...state.launch];
      state.launch.length = 0;
      return record('take_launch_paths', [], paths);
    },
    confirmClose: () => {
      state.closed = true;
      return record<void>('confirm_close', [], undefined);
    },
    newWindow: () => {
      const label = `window-${state.windows.length + 1}`;
      state.windows.push(label);
      return record('new_window', [], ok(label));
    },
    /**
     * The fake has no desktop to hit-test and no pointer to read, so it
     * makes the one distinction the shell acts on: a tab dropped goes to
     * a window that was already there, and one moved by the command goes
     * to a window made for it.
     */
    moveTab: (tab, dropped) => {
      state.moved.push(tab);
      const created = !dropped || state.windows.length < 2;
      const label = created ? `window-${state.windows.length + 1}` : (state.windows[1] as string);
      if (created) state.windows.push(label);
      return record('move_tab', [tab, dropped], ok({ label, created }));
    },
    takeMovedTabs: () => {
      const tabs = [...state.arriving];
      state.arriving.length = 0;
      return record('take_moved_tabs', [], tabs);
    },
    revealPath: (path) => record('reveal_path', [path], elsewhere.has(path)),
    blockDiff: (oldBlocks: Block[], newBlocks: Block[]) =>
      record('block_diff', [oldBlocks, newBlocks], fakeAlign(oldBlocks, newBlocks)),
    /**
     * One level of the tree, out of the paths in the file map. The real
     * one leaves out what `.gitignore` names, which is decided by the
     * same walker the search uses and tested where that lives.
     */
    listDir: (path) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = new Map<string, DirEntry>();
      for (const [at, file] of files) {
        if (!at.startsWith(prefix)) continue;
        const rest = at.slice(prefix.length);
        const cut = rest.indexOf('/');
        const name = cut < 0 ? rest : rest.slice(0, cut);
        entries.set(prefix + name, {
          path: prefix + name,
          name,
          is_dir: cut >= 0,
          byte_len: cut < 0 ? file.content.length : 0,
          modified_ms: null,
        });
      }
      const listed = [...entries.values()].sort(
        (a, b) =>
          Number(b.is_dir) - Number(a.is_dir) ||
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
      return record('list_dir', [path], ok(listed));
    },
    /**
     * A folder exists in the fake if some file is under it: the map is
     * of files, and a directory is a prefix of their paths. That is the
     * one way a fake folder can be missing, which is what the window
     * needs to see when a session names a folder that has since moved.
     */
    openFolder: (path) => {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      if (![...files.keys()].some((at) => at.startsWith(prefix))) {
        return record(
          'open_folder',
          [path],
          err<string>({ kind: 'read', path, message: 'No such file or directory' }),
        );
      }
      state.folder = path;
      return record('open_folder', [path], ok(path));
    },
    closeFolder: () => {
      state.folder = null;
      search = 0;
      return record<void>('close_folder', [], undefined);
    },
    findFiles: (query, limit) => {
      const root = state.folder;
      const hits: FileHit[] = [];
      const prefix = root === null ? null : root.endsWith('/') ? root : `${root}/`;
      if (prefix !== null && query.trim() !== '') {
        for (const at of files.keys()) {
          if (!at.startsWith(prefix)) continue;
          const relative = at.slice(prefix.length);
          const matched = subsequence(query, relative);
          if (matched === null) continue;
          const name = basename(relative);
          const start = relative.length - name.length;
          hits.push({
            path: at,
            name,
            dir: relative.slice(0, Math.max(start - 1, 0)),
            positions: matched.filter((n) => n >= start).map((n) => n - start),
          });
        }
      }
      const matches: FileMatches = {
        hits: hits.slice(0, limit),
        files: prefix === null ? 0 : [...files.keys()].filter((at) => at.startsWith(prefix)).length,
        truncated: false,
      };
      return record('find_files', [query, limit], matches);
    },
    /**
     * Search the folder's contents and deliver the results the way Rust
     * does: as events, after the call has already answered with the id.
     */
    startSearch: (id, query, options) => {
      const root = state.folder;
      if (root === null) {
        return record(
          'start_search',
          [id, query, options],
          err<null>({
            kind: 'unavailable',
            what: 'the folder',
            message: 'no folder is open to search',
          }),
        );
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(
          options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          options.case_sensitive ? '' : 'i',
        );
      } catch (error) {
        return record(
          'start_search',
          [id, query, options],
          err<null>({ kind: 'bad_query', query, message: String(error) }),
        );
      }
      search = id;
      const prefix = root.endsWith('/') ? root : `${root}/`;
      const hits: SearchHit[] = [];
      for (const [at, file] of files) {
        if (!at.startsWith(prefix)) continue;
        file.content.split('\n').forEach((text, line) => {
          if (hits.length >= options.max_results) return;
          const found = pattern.exec(text);
          if (found === null) return;
          hits.push({
            path: at,
            line: line + 1,
            from: found.index,
            to: found.index + found[0].length,
            column: found.index,
            text,
          });
        });
      }
      queueMicrotask(() => {
        if (search !== id) return;
        if (hits.length > 0) for (const cb of progressListeners) cb({ id, hits });
        for (const cb of doneListeners)
          cb({
            id,
            hits: hits.length,
            truncated: hits.length >= options.max_results,
            cancelled: false,
          });
      });
      return record('start_search', [id, query, options], ok(null));
    },
    cancelSearch: (id) => {
      if (search === id) search = 0;
      return record<void>('cancel_search', [id], undefined);
    },
    createFile: (dir, name) => {
      const cut = name.lastIndexOf('.');
      const [stem, ext] = cut > 0 ? [name.slice(0, cut), name.slice(cut)] : [name, ''];
      for (let n = 1; n < 100; n++) {
        const path = `${dir}/${n === 1 ? name : `${stem} ${n}${ext}`}`;
        if (files.has(path)) continue;
        files.set(path, { content: '' });
        touched(dir);
        return record('create_file', [dir, name], ok(path));
      }
      return record(
        'create_file',
        [dir, name],
        err<string>({ kind: 'write', path: dir, message: 'too many files of this name' }),
      );
    },
    renamePath: (path, name) => {
      const dir = dirname(path);
      const to = `${dir}/${name}`;
      const file = files.get(path);
      if (files.has(to)) {
        return record(
          'rename_path',
          [path, name],
          err<string>({
            kind: 'write',
            path: to,
            message: 'there is already a file with that name',
          }),
        );
      }
      if (file) {
        files.set(to, file);
        files.delete(path);
        watching.delete(path);
      }
      touched(dir);
      return record('rename_path', [path, name], ok(to));
    },
    answerAgent: (id, answer) => {
      calls.push({ command: 'answer_agent', args: [id, answer] });
      // An id nobody is waiting for is dropped, the way Rust drops one.
      answering.get(id)?.(answer);
      answering.delete(id);
      return Promise.resolve();
    },
    agentStatus: () => {
      calls.push({ command: 'agent_status', args: [] });
      return Promise.resolve({ ...state.agentStatus });
    },
    rotateAgentToken: () => {
      state.rotations += 1;
      return record('rotate_agent_token', [], ok(null));
    },
    agentClientConfig: () =>
      record(
        'agent_client_config',
        [],
        ok(
          '{\n  "mcpServers": {\n    "md-reader": {\n      "command": "mdreader-desktop",\n      "args": ["--mcp-stdio"]\n    }\n  }\n}\n',
        ),
      ),
    setMenu: (sections) => {
      state.menu = sections;
      return record('set_menu', [sections], undefined);
    },
  };
  return {
    commands,
    files,
    calls,
    watching,
    get session() {
      return state.session;
    },
    get settings() {
      return state.settings;
    },
    overrides,
    changeSettings(settings) {
      state.settings = { ...settings };
      for (const cb of settingsListeners) cb({ ...settings });
    },
    onSettingsChanged(cb) {
      settingsListeners.add(cb);
      return () => settingsListeners.delete(cb);
    },
    get launch() {
      return state.launch;
    },
    get windows() {
      return state.windows;
    },
    get moved() {
      return state.moved;
    },
    get arriving() {
      return state.arriving;
    },
    elsewhere,
    deliverTab(move) {
      for (const cb of tabListeners) cb(move);
    },
    onTabArrived(cb) {
      tabListeners.add(cb);
      return () => tabListeners.delete(cb);
    },
    get flushes() {
      return state.flushes;
    },
    get closed() {
      return state.closed;
    },
    externalWrite(path, content) {
      const before = seen.get(path) ?? files.get(path)?.content ?? '';
      files.set(path, { content });
      seen.set(path, content);
      const change: ExternalChange = {
        path,
        content,
        hash: fakeHash(content),
        agent: null,
        changes: singleEdit(before, content),
      };
      for (const cb of listeners) cb(change);
      return change;
    },
    agentWrite(path, content, agent) {
      const before = seen.get(path) ?? files.get(path)?.content ?? '';
      files.set(path, { content });
      seen.set(path, content);
      const change: ExternalChange = {
        path,
        content,
        hash: fakeHash(content),
        agent,
        changes: singleEdit(before, content),
      };
      for (const cb of listeners) cb(change);
      return change;
    },
    askAgent(request) {
      const id = nextAsk;
      nextAsk += 1;
      const answer = new Promise<AgentAnswer>((resolve) => {
        answering.set(id, resolve);
      });
      for (const cb of askListeners) cb({ id, request });
      return answer;
    },
    onAgentAsk(cb) {
      askListeners.add(cb);
      return () => askListeners.delete(cb);
    },
    changeAgentStatus(status) {
      state.agentStatus = { ...status };
      for (const cb of statusListeners) cb({ ...status });
    },
    onAgentStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    get agentStatus() {
      return state.agentStatus;
    },
    get menu() {
      return state.menu;
    },
    get rotations() {
      return state.rotations;
    },
    externalRemove(path) {
      files.delete(path);
      seen.delete(path);
      return { path };
    },
    externalRename(from, to) {
      const file = files.get(from);
      if (file) files.set(to, file);
      files.delete(from);
      watching.delete(from);
      seen.delete(from);
      return { from, to };
    },
    onExternalChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get folder() {
      return state.folder;
    },
    onFolderChange(cb) {
      folderListeners.add(cb);
      return () => folderListeners.delete(cb);
    },
    onSearchProgress(cb) {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    onSearchDone(cb) {
      doneListeners.add(cb);
      return () => doneListeners.delete(cb);
    },
  };
}
