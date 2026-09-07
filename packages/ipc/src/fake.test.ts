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
    expect(await ipc.commands.merge3('a', 'b', 'c')).toMatchObject({
      status: 'error',
      error: { kind: 'not_implemented' },
    });
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
});
