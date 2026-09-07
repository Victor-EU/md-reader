import type {
  Block,
  BlockOp,
  Commands,
  Document,
  ExternalChange,
  FileFormat,
  Error as IpcError,
  Result,
  SaveResult,
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
  /** Simulate a write by another process; a listener registered through `onExternalChange` gets it. */
  externalWrite(path: string, content: string): void;
  onExternalChange(cb: (change: ExternalChange) => void): () => void;
  /** Every command call, for assertions on what the shell asked for. */
  calls: { command: string; args: unknown[] }[];
}

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
    watch: (path) => record('watch', [path], ok(null)),
    unwatch: (path) => record('unwatch', [path], ok(null)),
    merge3: (base, ours, theirs) =>
      record('merge3', [base, ours, theirs], notImplemented('merge3')),
    snapshot: (path, content, author) =>
      record('snapshot', [path, content, author], notImplemented('snapshot')),
    listSnapshots: (path) => record('list_snapshots', [path], notImplemented('list_snapshots')),
    readSnapshot: (id) => record('read_snapshot', [id], notImplemented('read_snapshot')),
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
    externalWrite(path, content) {
      files.set(path, { content });
      const change: ExternalChange = { path, content, hash: fakeHash(content), changes: [] };
      for (const cb of listeners) cb(change);
    },
    onExternalChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
