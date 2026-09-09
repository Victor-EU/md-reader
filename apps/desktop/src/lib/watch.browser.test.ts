import { changesField } from '@mdreader/editor-core';
import type { MergeResult } from '@mdreader/ipc';
import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;

function open(files: Record<string, string>, merge?: (...args: string[]) => MergeResult) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({
    commands: merge
      ? {
          ...ipc.commands,
          merge3: (base, ours, theirs) => Promise.resolve(merge(base, ours, theirs)),
        }
      : ipc.commands,
  });
}

/** What the EditorPane component's effect does, by hand. */
function edit() {
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

/**
 * The margin bars are measured rather than decorated, so they are drawn
 * in the view's measure phase, which is a frame away.
 */
const drawn = () => new Promise((resolve) => requestAnimationFrame(resolve));

const commandsCalled = () => ipc.calls.map((call) => call.command);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open({});
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('watching an open file', () => {
  it('watches a file it opens and snapshots what it found', async () => {
    open({ '/a/one.md': '# One\n' });
    await workspace.openPath('/a/one.md');
    expect(ipc.watching.has('/a/one.md')).toBe(true);
    expect(commandsCalled()).toContain('snapshot');
    expect(await ipc.commands.listSnapshots('/a/one.md')).toMatchObject({
      status: 'ok',
      data: [{ author: 'user' }],
    });
  });

  it('stops watching when the last tab on a document closes', async () => {
    open({ '/a/one.md': '# One\n' });
    await workspace.openPath('/a/one.md');
    workspace.duplicateView();
    workspace.close(workspace.tabs[1]?.id ?? '');
    expect(ipc.watching.has('/a/one.md')).toBe(true);
    workspace.close(workspace.tabs[0]?.id ?? '');
    expect(ipc.watching.has('/a/one.md')).toBe(false);
  });

  it('watches again when the tab is reopened', async () => {
    open({ '/a/one.md': '# One\n' });
    await workspace.openPath('/a/one.md');
    workspace.closeActive();
    workspace.reopenClosed();
    expect(ipc.watching.has('/a/one.md')).toBe(true);
  });
});

describe('a write by somebody else', () => {
  it('takes the whole write into a clean buffer and leaves the cursor where it was', async () => {
    open({ '/a/one.md': 'alpha\nbeta\ngamma\n' });
    await workspace.openPath('/a/one.md');
    edit();
    // The reader is reading the last line while the write lands above it.
    workspace.view?.dispatch({ selection: { anchor: 'alpha\nbeta\n'.length + 2 } });
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'alpha\nBETA!\ngamma\n'));
    expect(workspace.activeDoc?.text).toBe('alpha\nBETA!\ngamma\n');
    expect(workspace.activeDoc?.dirty).toBe(false);
    expect(workspace.view?.state.doc.lineAt(workspace.view.state.selection.main.head).text).toBe(
      'gamma',
    );
    expect(workspace.status).toContain('changed on disk');
  });

  it('leaves the unsaved edit alone and brings their hunks in', async () => {
    // The shell's job is to apply what the merge returns; which hunks
    // conflict is decided in Rust and tested there.
    open({ '/a/one.md': 'one\ntwo\nthree\n' }, () => ({
      changes: [{ from: 0, to: 3, insert: 'ONE' }],
      conflicts: [],
    }));
    await workspace.openPath('/a/one.md');
    edit();
    const doc = workspace.activeDoc;
    if (!doc) throw new Error('no document');
    workspace.view?.dispatch({ changes: { from: 7, to: 7, insert: ' edited' } });
    expect(doc.dirty).toBe(true);
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'ONE\ntwo\nthree\n'));
    expect(doc.text).toBe('ONE\ntwo edited\nthree\n');
    expect(workspace.status).toContain('1 change merged in');
  });

  it('keeps our version of a conflicting hunk and offers theirs beside it', async () => {
    open({ '/a/one.md': 'one\n' });
    await workspace.openPath('/a/one.md');
    edit();
    const doc = workspace.activeDoc;
    if (!doc) throw new Error('no document');
    workspace.view?.dispatch({ changes: { from: 0, to: 3, insert: 'ours' } });
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'theirs\n'));
    expect(doc.text).toBe('ours\n');
    expect(workspace.unsettled).toBe(1);
    expect(workspace.status).toContain('1 conflict to settle');
    // Nothing is lost: what arrived is in the history as well.
    const stored = await ipc.commands.listSnapshots('/a/one.md');
    expect(stored.status === 'ok' && stored.data.some((s) => s.author === 'external')).toBe(true);
  });

  it('takes their version as the new base, so the next save is not refused', async () => {
    open({ '/a/one.md': 'one\n' });
    await workspace.openPath('/a/one.md');
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'two\n'));
    expect(workspace.activeDoc?.dirty).toBe(false);
    expect(await workspace.save()).toBe(true);
    expect(workspace.status).toBe('Saved one.md');
  });

  it('updates a document being read, in place', async () => {
    open({ '/a/one.md': '# One\n\nBody.\n' });
    await workspace.openPath('/a/one.md');
    workspace.mountRead(host);
    await workspace.externalChange(ipc.externalWrite('/a/one.md', '# One\n\nBody, changed.\n'));
    expect(workspace.activeDoc?.text).toBe('# One\n\nBody, changed.\n');
  });

  /**
   * Saving restores the file's stored form, so a document the reader
   * stripped the last newline from sits on disk with one. The edits the
   * watcher works out are relative to that file and would land one
   * character short of the buffer; merging against the buffer's own base
   * is what keeps the two in step.
   */
  it('merges against the buffer, not against the file it was saved to', async () => {
    open({ '/a/one.md': 'one\ntwo\n' });
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 7, to: 8, insert: '' } });
    expect(await workspace.save()).toBe(true);
    expect(workspace.activeDoc?.text).toBe('one\ntwo');
    expect(ipc.files.get('/a/one.md')?.content).toBe('one\ntwo\n');
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'ONE\ntwo\n'));
    expect(workspace.activeDoc?.text).toBe('ONE\ntwo\n');
  });

  it('ignores a change to a file nothing has open', async () => {
    open({ '/a/one.md': 'one\n' });
    await workspace.openPath('/a/one.md');
    await workspace.externalChange(ipc.externalWrite('/a/other.md', 'elsewhere\n'));
    expect(workspace.activeDoc?.text).toBe('one\n');
  });
});

describe('a save that races somebody else', () => {
  /**
   * The hash check refuses the save; the reader does not see a refusal,
   * they see their save go through with the other write merged into it
   * (design 7.2).
   */
  it('merges what arrived first and saves anyway', async () => {
    open({ '/a/one.md': 'one\ntwo\n' }, (_base, _ours, theirs) => ({
      changes: [{ from: 0, to: 3, insert: theirs.slice(0, theirs.indexOf('\n')) }],
      conflicts: [],
    }));
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 7, to: 7, insert: ' edited' } });
    // Somebody else writes, and the watcher has not reported it yet.
    ipc.files.set('/a/one.md', { content: 'THEIRS\ntwo\n' });
    expect(await workspace.save()).toBe(true);
    expect(workspace.activeDoc?.text).toBe('THEIRS\ntwo edited\n');
    expect(ipc.files.get('/a/one.md')?.content).toBe('THEIRS\ntwo edited\n');
    expect(workspace.status).toContain('Saved one.md');
  });

  it('gives up rather than trying forever', async () => {
    open({ '/a/one.md': 'one\n' });
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 0, to: 3, insert: 'mine' } });
    ipc.files.set('/a/one.md', { content: 'theirs\n' });
    // A writer that gets in again between the re-read and the retry.
    const original = ipc.commands.openDocument;
    ipc.commands.openDocument = async (path) => {
      const document = await original(path);
      ipc.files.set('/a/one.md', { content: `${Math.random()}\n` });
      return document;
    };
    expect(await workspace.save()).toBe(false);
    expect(workspace.status).toContain('changed on disk');
  });
});

describe('a file that goes away', () => {
  it('keeps the buffer and says the file is gone', async () => {
    open({ '/a/one.md': 'still here\n' });
    await workspace.openPath('/a/one.md');
    workspace.fileRemoved(ipc.externalRemove('/a/one.md'));
    expect(workspace.activeDoc?.text).toBe('still here\n');
    expect(workspace.activeDoc?.missing).toBe(true);
    expect(workspace.status).toContain('no longer on disk');
  });

  it('writes the file again on the next save', async () => {
    open({ '/a/one.md': 'still here\n' });
    await workspace.openPath('/a/one.md');
    workspace.fileRemoved(ipc.externalRemove('/a/one.md'));
    expect(await workspace.save()).toBe(true);
    expect(ipc.files.get('/a/one.md')?.content).toBe('still here\n');
    expect(workspace.activeDoc?.missing).toBe(false);
  });

  it('follows a rename to the new name', async () => {
    open({ '/a/one.md': 'moving\n' });
    await workspace.openPath('/a/one.md');
    workspace.fileRenamed(ipc.externalRename('/a/one.md', '/a/two.md'));
    expect(workspace.activeDoc?.path).toBe('/a/two.md');
    expect(workspace.labels).toEqual(['two.md']);
    expect(ipc.watching.has('/a/two.md')).toBe(true);
    expect(workspace.status).toBe('one.md is now two.md');
  });
});

/**
 * Three paragraphs, one line each, which is what the change marks are
 * about: the unit the engine aligns is the block, so a fixture whose
 * lines are all one paragraph would be one mark however much of it
 * changed (plan WP 2.2).
 */
const three = 'one\n\ntwo\n\nthree\n';

describe('what the reader has seen', () => {
  it('counts what arrived and stops counting once it is marked reviewed', async () => {
    open({ '/a/one.md': three });
    await workspace.openPath('/a/one.md');
    expect(workspace.unreviewed).toBe(0);
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\n\nTWO\n\nthree\n'));
    expect(workspace.unreviewed).toBe(1);
    workspace.markReviewed();
    expect(workspace.unreviewed).toBe(0);
    expect(workspace.status).toBe('Marked as reviewed');
  });

  it('draws the change in the gutter', async () => {
    open({ '/a/one.md': three });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\n\nTWO\n\nthree\n'));
    await drawn();
    expect(host.querySelectorAll('.cm-change-changed').length).toBe(1);
    workspace.markReviewed();
    await drawn();
    expect(host.querySelectorAll('.cm-change').length).toBe(0);
  });

  /**
   * The case design 7.3 exists for. An agent that reflows a document to
   * eighty columns has replaced every line of it and said nothing
   * different, and the line diff this replaced would have marked all of
   * them.
   */
  it('says nothing about a write that only rewrapped a paragraph', async () => {
    open({ '/a/one.md': 'one\n\nthe cat sat on the mat and did not move again\n' });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(
      ipc.externalWrite('/a/one.md', 'one\n\nthe cat sat on\nthe mat and did\nnot move again\n'),
    );
    expect(workspace.activeDoc?.text).toBe(
      'one\n\nthe cat sat on\nthe mat and did\nnot move again\n',
    );
    expect(workspace.unreviewed).toBe(0);
    await drawn();
    expect(host.querySelectorAll('.cm-change').length).toBe(0);
  });

  /**
   * The whole paragraph, not the line inside it that holds the word.
   * The block is what changed; which words in it did is what Review mode
   * draws (design 7.3).
   */
  it('marks the paragraph a word changed in, not one line of it', async () => {
    open({ '/a/one.md': 'one\n\nthe cat\nsat on\nthe mat\n' });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(
      ipc.externalWrite('/a/one.md', 'one\n\nthe cat\nsat on\nthe rug\n'),
    );
    await drawn();
    const bar = host.querySelector('.cm-change-changed')?.getBoundingClientRect();
    const paragraph = workspace.view?.state.doc;
    if (!bar || !paragraph) throw new Error('nothing drawn');
    // One bar, and it is as tall as the three lines it is beside.
    expect(host.querySelectorAll('.cm-change-changed')).toHaveLength(1);
    expect(bar.height).toBeGreaterThan(2 * (workspace.view?.defaultLineHeight ?? 0));
  });

  it('keeps the markers beside their text while the reader types', async () => {
    open({ '/a/one.md': three });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\n\ntwo\n\nTHREE\n'));
    const doc = workspace.activeDoc;
    if (!doc) throw new Error('no document');
    const at = () => doc.state.field(changesField)[0]?.from;
    const before = at();
    // Typing above the change moves it down by exactly what was typed.
    workspace.view?.dispatch({ changes: { from: 0, to: 0, insert: 'new line\n' } });
    expect(at()).toBe((before ?? 0) + 'new line\n'.length);
  });

  /**
   * Scenario S4's last clause: "the human presses a key to step through
   * the changes, then mark reviewed". Added at the Phase 1 gate, where
   * the by-hand pass found the marks drawn and no way to walk them.
   */
  it('steps the cursor from one changed run to the next, and wraps', async () => {
    open({ '/a/one.md': 'one\n\ntwo\n\nthree\n\nfour\n\nfive\n' });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(
      ipc.externalWrite('/a/one.md', 'one\n\nTWO\n\nthree\n\nFOUR\n\nfive\n'),
    );
    const line = () => {
      const state = workspace.view?.state;
      if (!state) throw new Error('no view');
      return state.doc.lineAt(state.selection.main.head).number;
    };
    expect(workspace.stepChange(true)).toBe(true);
    expect(line()).toBe(3);
    // A cursor already on a change is looking at it, so next means the
    // one after — and past the last one it comes back to the first.
    expect(workspace.stepChange(true)).toBe(true);
    expect(line()).toBe(7);
    expect(workspace.stepChange(true)).toBe(true);
    expect(line()).toBe(3);
    expect(workspace.stepChange(false)).toBe(true);
    expect(line()).toBe(7);
  });

  it('says so rather than moving when nothing has changed', async () => {
    open({ '/a/one.md': 'one\ntwo\n' });
    await workspace.openPath('/a/one.md');
    edit();
    expect(workspace.stepChange(true)).toBe(false);
    expect(workspace.status).toBe('Nothing has changed under you');
  });

  it('steps from Read mode by switching to the view that has a cursor', async () => {
    open({ '/a/one.md': 'one\n\ntwo\n\nthree\n\nfour\n' });
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\n\ntwo\n\nTHREE\n\nfour\n'));
    workspace.unmount();
    workspace.setMode('read');
    expect(workspace.stepChange(true)).toBe(true);
    // The editor arrives from its own effect, which is where the step runs.
    workspace.mount(host);
    const state = workspace.view?.state;
    if (!state) throw new Error('no view');
    expect(state.doc.lineAt(state.selection.main.head).number).toBe(5);
  });

  it('saving marks the document as seen', async () => {
    open({ '/a/one.md': 'one\n' });
    await workspace.openPath('/a/one.md');
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'two\n'));
    expect(workspace.unreviewed).toBe(1);
    await workspace.save();
    expect(workspace.unreviewed).toBe(0);
  });
});
