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

  it('refuses to save a read-only encoding', async () => {
    const ipc = createFakeIpc({
      '/l.md': { content: 'caf', format: { encoding: 'windows-1252' } },
    });
    const doc = await unwrap(ipc.commands.openDocument('/l.md'));
    expect(doc.meta.read_only).toBe('encoding');
    const result = await ipc.commands.saveDocument('/l.md', 'x', doc.meta.hash, doc.meta.format);
    expect(result).toMatchObject({ status: 'error', error: { kind: 'read_only_encoding' } });
    const converted = await unwrap(ipc.commands.convertDocumentToUtf8('/l.md'));
    expect(converted.meta.read_only).toBeNull();
  });

  /** Design 8's ceilings, which the fake applies so the shell can be tested against them. */
  it('opens a large file for reading only and refuses a huge one', async () => {
    const ipc = createFakeIpc({
      '/big.md': { content: '# Big\n', byte_len: 42_000_000 },
      '/huge.md': { content: '# Huge\n', byte_len: 120_000_000 },
      '/small.md': '# Small\n',
    });
    expect((await unwrap(ipc.commands.openDocument('/big.md'))).meta.read_only).toBe('size');
    expect((await unwrap(ipc.commands.openDocument('/small.md'))).meta.read_only).toBeNull();
    expect(await ipc.commands.openDocument('/huge.md')).toMatchObject({
      status: 'error',
      error: { kind: 'too_large', byte_len: 120_000_000, limit: 100_000_000 },
    });
  });

  it('lists a folder one level at a time, folders first', async () => {
    const ipc = createFakeIpc({
      '/w/b.md': 'b',
      '/w/A.md': 'a',
      '/w/sub/c.md': 'c',
      '/elsewhere/d.md': 'd',
    });
    const listed = await unwrap(ipc.commands.listDir('/w'));
    expect(listed.map((entry) => entry.name)).toEqual(['sub', 'A.md', 'b.md']);
    expect(listed[0]?.is_dir).toBe(true);
    expect((await unwrap(ipc.commands.listDir('/w/sub'))).map((e) => e.path)).toEqual([
      '/w/sub/c.md',
    ]);
  });

  it('matches file names in the open folder and nowhere else', async () => {
    const ipc = createFakeIpc({ '/w/notes/plan.md': 'p', '/other/plan.md': 'p' });
    expect((await ipc.commands.findFiles('plan', 10)).hits).toEqual([]);
    await unwrap(ipc.commands.openFolder('/w'));
    const found = await ipc.commands.findFiles('plan', 10);
    expect(found.hits.map((hit) => hit.path)).toEqual(['/w/notes/plan.md']);
    expect(found.hits[0]).toMatchObject({ name: 'plan.md', dir: 'notes' });
    expect(found.files).toBe(1);
  });

  it('searches the folder and delivers the results as events', async () => {
    const ipc = createFakeIpc({
      '/w/one.md': 'first\nthe cat sat\n',
      '/w/two.md': 'nothing\n',
    });
    const progress: number[] = [];
    let finished = 0;
    ipc.onSearchProgress((p) => progress.push(p.id));
    ipc.onSearchDone((d) => {
      finished = d.hits;
    });
    await unwrap(ipc.commands.openFolder('/w'));
    // The window names its own search, because the results are events
    // and an event can arrive before the call that started it answers.
    await unwrap(
      ipc.commands.startSearch(7, 'cat', {
        case_sensitive: false,
        regex: false,
        max_results: 100,
      }),
    );
    await Promise.resolve();
    expect(progress).toEqual([7]);
    expect(finished).toBe(1);
  });

  it('makes a file, numbers the next one, and renames within the folder', async () => {
    const ipc = createFakeIpc({ '/w/there.md': 'x' });
    await unwrap(ipc.commands.openFolder('/w'));
    const changed: string[] = [];
    ipc.onFolderChange((change) => changed.push(...change.dirs));
    expect(await ipc.commands.openFolder('/nowhere')).toMatchObject({
      status: 'error',
      error: { kind: 'read' },
    });
    expect(await unwrap(ipc.commands.createFile('/w', 'Untitled.md'))).toBe('/w/Untitled.md');
    expect(await unwrap(ipc.commands.createFile('/w', 'Untitled.md'))).toBe('/w/Untitled 2.md');
    expect(await unwrap(ipc.commands.renamePath('/w/Untitled.md', 'Notes.md'))).toBe('/w/Notes.md');
    expect(ipc.files.has('/w/Notes.md')).toBe(true);
    expect(await ipc.commands.renamePath('/w/Untitled 2.md', 'Notes.md')).toMatchObject({
      status: 'error',
      error: { kind: 'write' },
    });
    expect(changed).toEqual(['/w', '/w', '/w']);
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

  it('tears a tab into a window it makes, and hands one over to a window there is', async () => {
    const ipc = createFakeIpc();
    const tab = {
      path: '/a.md',
      untitled_name: null,
      meta: null,
      text: 'one\n',
      base: 'one\n',
      reviewed: 'one\n',
      state: '{}',
      mode: 'read' as const,
      pinned: false,
      anchor: 0,
      page: null,
      folded: [],
    };
    // Not dropped anywhere: a window of its own, made for it.
    expect(await unwrap(ipc.commands.moveTab(tab, false))).toEqual({
      label: 'window-2',
      created: true,
    });
    // Dropped: the window that was already under it.
    expect(await unwrap(ipc.commands.moveTab(tab, true))).toEqual({
      label: 'window-2',
      created: false,
    });
    expect(ipc.windows).toEqual(['main', 'window-2']);
    expect(ipc.moved.length).toBe(2);
  });

  it('hands a waiting tab over once, the way the launch queue does', async () => {
    const ipc = createFakeIpc();
    ipc.arriving.push({
      path: '/a.md',
      untitled_name: null,
      meta: null,
      text: '',
      base: '',
      reviewed: '',
      state: '{}',
      mode: 'read',
      pinned: false,
      anchor: 0,
      page: null,
      folded: [],
    });
    expect((await ipc.commands.takeMovedTabs()).map((move) => move.path)).toEqual(['/a.md']);
    expect(await ipc.commands.takeMovedTabs()).toEqual([]);
  });

  it('says when another window has the file, which is all a fake window knows', async () => {
    const ipc = createFakeIpc({ '/a.md': 'one' });
    expect(await ipc.commands.revealPath('/a.md')).toBe(false);
    ipc.elsewhere.add('/a.md');
    expect(await ipc.commands.revealPath('/a.md')).toBe(true);
  });

  it('moves a file out from under the shell', () => {
    const ipc = createFakeIpc({ '/x.md': 'here' });
    expect(ipc.externalRename('/x.md', '/y.md')).toEqual({ from: '/x.md', to: '/y.md' });
    expect(ipc.files.get('/y.md')?.content).toBe('here');
    expect(ipc.externalRemove('/y.md')).toEqual({ path: '/y.md' });
    expect(ipc.files.has('/y.md')).toBe(false);
  });
});
