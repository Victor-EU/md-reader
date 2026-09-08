import type {
  Block,
  BlockOp,
  Commands,
  Document,
  ExternalChange,
  FileFormat,
  FileRemoved,
  FileRenamed,
  Error as IpcError,
  MergeResult,
  PositionEdit,
  Restore,
  Result,
  SaveResult,
  Settings,
  SnapshotAuthor,
  SnapshotInfo,
  WindowContent,
} from './index.ts';

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
  read_only?: boolean;
}

export interface FakeIpc {
  commands: Commands;
  files: Map<string, FakeFile>;
  /** Paths the shell has asked to watch. */
  watching: Set<string>;
  /** The session as the shell last pushed it, and what a launch reads. */
  session: { content: WindowContent | null; recents: string[] };
  settings: Settings;
  /** Files a launch is holding for the window; drained by `takeLaunchPaths`. */
  launch: string[];
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
  /** Every command call, for assertions on what the shell asked for. */
  calls: { command: string; args: unknown[] }[];
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

const ok = <T>(data: T): Result<T, IpcError> => ({ status: 'ok', data });
const err = <T>(error: IpcError): Result<T, IpcError> => ({ status: 'error', error });
const notImplemented = <T>(command: string): Result<T, IpcError> =>
  err({ kind: 'not_implemented', command });

function defaultFormat(content: string): FileFormat {
  return {
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    mixed_eol: false,
    bom: false,
    trailing_newline: content.endsWith('\n'),
    encoding: 'utf-8',
  };
}

export function createFakeIpc(initial: Record<string, string | FakeFile> = {}): FakeIpc {
  const files = new Map<string, FakeFile>();
  for (const [path, file] of Object.entries(initial))
    files.set(path, typeof file === 'string' ? { content: file } : file);
  const listeners = new Set<(change: ExternalChange) => void>();
  const calls: FakeIpc['calls'] = [];
  const watching = new Set<string>();
  const state = {
    session: { content: null as WindowContent | null, recents: [] as string[] },
    settings: { autosave: true } as Settings,
    launch: [] as string[],
    flushes: 0,
    closed: false,
  };
  const history = new Map<string, { info: SnapshotInfo; content: string }[]>();
  /** What the last known disk content was, so a change reports edits from it. */
  const seen = new Map<string, string>();
  let snapshots = 0;
  const record = <T>(command: string, args: unknown[], result: T): Promise<T> => {
    calls.push({ command, args });
    return Promise.resolve(result);
  };
  const read = (path: string): Result<Document, IpcError> => {
    const file = files.get(path);
    if (!file) return err({ kind: 'read', path, message: 'No such file or directory' });
    const format = { ...defaultFormat(file.content), ...file.format };
    return ok({
      content: file.content,
      meta: {
        path,
        byte_len: new TextEncoder().encode(file.content).length,
        modified_ms: Date.now(),
        hash: fakeHash(file.content),
        read_only: file.read_only ?? format.encoding !== 'utf-8',
        format,
      },
    });
  };
  const commands: Commands = {
    openDocument: (path) => record('open_document', [path], read(path)),
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
        files.set(path, {
          content: file.content,
          format: { ...file.format, encoding: 'utf-8' },
          read_only: false,
        });
      return record('convert_document_to_utf8', [path], read(path));
    },
    allowDocumentImages: (path) => record('allow_document_images', [path], ok(null)),
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
    snapshot: (path, content, author) => {
      const taken = history.get(path) ?? [];
      const latest = taken[taken.length - 1];
      if (latest?.content === content)
        return record('snapshot', [path, content, author], ok(latest.info));
      snapshots += 1;
      const info: SnapshotInfo = {
        id: `snapshot-${snapshots}`,
        path,
        author: author as SnapshotAuthor,
        timestamp_ms: Date.now(),
        hash: fakeHash(content),
        byte_len: new TextEncoder().encode(content).length,
      };
      taken.push({ info, content });
      history.set(path, taken);
      return record('snapshot', [path, content, author], ok(info));
    },
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
      return record<void>('save_settings', [settings], undefined);
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
    blockDiff: (oldBlocks: Block[], newBlocks: Block[]) =>
      record('block_diff', [oldBlocks, newBlocks], notImplemented<BlockOp[]>('block_diff')),
    listDir: (path) => record('list_dir', [path], notImplemented('list_dir')),
    search: (root, query, options) =>
      record('search', [root, query, options], notImplemented('search')),
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
    get launch() {
      return state.launch;
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
        changes: singleEdit(before, content),
      };
      for (const cb of listeners) cb(change);
      return change;
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
  };
}
