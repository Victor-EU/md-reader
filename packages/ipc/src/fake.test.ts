import { describe, expect, it } from 'vitest';
import { createFakeIpc, fakeHash } from './fake.ts';
import { unwrap } from './index.ts';

describe('fake ipc', () => {
  it('opens, saves with a hash check, and recreates a deleted file', async () => {
    const ipc = createFakeIpc({ '/a.md': 'hello\n' });
    const doc = await unwrap(ipc.commands.openDocument('/a.md'));
    expect(doc.content).toBe('hello\n');
    expect(doc.meta.hash).toBe(fakeHash('hello\n'));
    ipc.externalWrite('/a.md', 'changed\n');
    const stale = await ipc.commands.saveDocument(
      '/a.md',
      'mine\n',
      doc.meta.hash,
      doc.meta.format,
    );
    expect(stale).toMatchObject({ status: 'error', error: { kind: 'hash_mismatch' } });
    ipc.files.delete('/a.md');
    const saved = await unwrap(
      ipc.commands.saveDocument('/a.md', 'mine\n', doc.meta.hash, doc.meta.format),
    );
    expect(saved.hash).toBe(fakeHash('mine\n'));
    expect(ipc.files.get('/a.md')?.content).toBe('mine\n');
    expect(ipc.calls.map((c) => c.command)).toEqual([
      'open_document',
      'save_document',
      'save_document',
    ]);
  });

  it('refuses to save a read-only encoding and reports unimplemented commands', async () => {
    const ipc = createFakeIpc({
      '/l.md': { content: 'caf', format: { encoding: 'windows-1252' } },
    });
    const doc = await unwrap(ipc.commands.openDocument('/l.md'));
    expect(doc.meta.read_only).toBe(true);
    const result = await ipc.commands.saveDocument('/l.md', 'x', doc.meta.hash, doc.meta.format);
    expect(result).toMatchObject({ status: 'error', error: { kind: 'read_only_encoding' } });
    const converted = await unwrap(ipc.commands.convertDocumentToUtf8('/l.md'));
    expect(converted.meta.read_only).toBe(false);
    expect(await ipc.commands.listDir('/')).toMatchObject({
      status: 'error',
      error: { kind: 'not_implemented' },
    });
  });

  /**
   * The fake merges the whole document as one hunk, which is the
   * degenerate case of the real one. What the shell has to get right is
   * applying what comes back; which hunks conflict is decided and tested
   * in `crates/core/src/diff.rs`.
   */
  it('merges a clean buffer and conflicts over a dirty one', async () => {
    const ipc = createFakeIpc();
    expect(await ipc.commands.merge3('a\n', 'a\n', 'b\n')).toEqual({
      changes: [{ from: 0, to: 1, insert: 'b' }],
      conflicts: [],
    });
    expect(await ipc.commands.merge3('a\n', 'ours\n', 'ours\n')).toEqual({
      changes: [],
      conflicts: [],
    });
    const conflicting = await ipc.commands.merge3('a\n', 'ours\n', 'theirs\n');
    expect(conflicting.changes).toEqual([]);
    expect(conflicting.conflicts).toHaveLength(1);
  });

  it('keeps snapshots per document, newest first, without repeating one', async () => {
    const ipc = createFakeIpc();
    const first = await unwrap(ipc.commands.snapshot('/a.md', 'one', 'user'));
    const again = await unwrap(ipc.commands.snapshot('/a.md', 'one', 'external'));
    expect(again.id).toBe(first.id);
    const second = await unwrap(ipc.commands.snapshot('/a.md', 'two', 'external'));
    await unwrap(ipc.commands.snapshot('/b.md', 'elsewhere', 'user'));
    expect((await unwrap(ipc.commands.listSnapshots('/a.md'))).map((s) => s.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await unwrap(ipc.commands.readSnapshot(first.id))).toBe('one');
  });

  it('tracks what the shell asked to watch', async () => {
    const ipc = createFakeIpc({ '/a.md': 'one' });
    await ipc.commands.watch('/a.md');
    expect(ipc.watching.has('/a.md')).toBe(true);
    await ipc.commands.unwatch('/a.md');
    expect(ipc.watching.has('/a.md')).toBe(false);
  });

  it('delivers external changes to listeners', () => {
    const ipc = createFakeIpc();
    const seen: string[] = [];
    const stop = ipc.onExternalChange((c) => seen.push(c.content));
    ipc.externalWrite('/x.md', 'one');
    stop();
    ipc.externalWrite('/x.md', 'two');
    expect(seen).toEqual(['one']);
  });

  it('reports an external write as the edits from what was last on disk', async () => {
    const ipc = createFakeIpc({ '/x.md': 'one\ntwo\n' });
    await ipc.commands.watch('/x.md');
    const change = ipc.externalWrite('/x.md', 'one\nTWO\n');
    expect(change.changes).toEqual([{ from: 4, to: 7, insert: 'TWO' }]);
    expect(ipc.files.get('/x.md')?.content).toBe('one\nTWO\n');
  });

  it('moves a file out from under the shell', () => {
    const ipc = createFakeIpc({ '/x.md': 'here' });
    expect(ipc.externalRename('/x.md', '/y.md')).toEqual({ from: '/x.md', to: '/y.md' });
    expect(ipc.files.get('/y.md')?.content).toBe('here');
    expect(ipc.externalRemove('/y.md')).toEqual({ path: '/y.md' });
    expect(ipc.files.has('/y.md')).toBe(false);
  });
});
