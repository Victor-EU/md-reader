import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

/**
 * Review mode and the history panel end to end (design 4.4, plan WP
 * 2.3): the shell asked for changes the way the window asks for them,
 * with the fake engine standing in for Rust's.
 */

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;

const file = 'one\n\nthe cat sat down\n\nthree\n';

function open(files: Record<string, string>) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({ commands: ipc.commands });
}

/** What the EditorPane component's effect does, by hand. */
function edit() {
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

/** A write by somebody else, which is what leaves changes to review. */
async function rewritten(text: string) {
  await workspace.externalChange(ipc.externalWrite('/a/one.md', text));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open({ '/a/one.md': file });
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('Review mode', () => {
  it('draws a panel for each change, with both versions in it', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    expect(host.querySelectorAll('.mdr-review')).toHaveLength(0);
    workspace.toggleReview();
    const panel = host.querySelector('.mdr-review');
    // The fake alignment pairs whole blocks rather than words, so what
    // it puts either side of the change is the block. Which words go
    // where inside one is the engine's answer, tested in `changes.test`.
    expect(panel?.querySelector('del')?.textContent).toBe('the cat sat down');
    expect(panel?.querySelector('ins')?.textContent).toBe('the cat stood up');
  });

  /** Read mode has no editor to draw over, so asking for Review moves. */
  it('switches to Edit when it is asked for from Read mode', async () => {
    await workspace.openPath('/a/one.md');
    expect(workspace.activeTab?.mode).toBe('read');
    workspace.toggleReview();
    expect(workspace.activeTab?.mode).toBe('edit');
  });

  it('draws the panels on a view mounted after it was turned on', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    workspace.toggleReview();
    workspace.unmount();
    workspace.mount(host);
    expect(host.querySelectorAll('.mdr-review')).toHaveLength(1);
  });

  it('puts one change back and leaves the rest of the document alone', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('ONE\n\nthe cat stood up\n\nthree\n');
    expect(workspace.unreviewed).toBe(2);
    // The cursor goes to the second change, which is the one to put back.
    workspace.view?.dispatch({ selection: { anchor: 8 } });
    expect(workspace.revertHere()).toBe(true);
    expect(workspace.activeDoc?.text).toBe('ONE\n\nthe cat sat down\n\nthree\n');
  });

  /**
   * Revert puts back what arrived and nothing the reader wrote: a word
   * they have added to the paragraph since is theirs, and stays (ADR
   * 0036). It used to go back with the paragraph.
   */
  it('puts back what arrived and keeps what the reader wrote beside it', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    workspace.view?.dispatch({ changes: { from: 'one\n\n'.length, insert: 'Yes, ' } });
    // A scan, waited for: stopping a comparison nobody started asks for one.
    await workspace.compareWith(null);
    workspace.view?.dispatch({ selection: { anchor: 'one\n\nYes, the'.length } });
    expect(workspace.revertHere()).toBe(true);
    expect(workspace.activeDoc?.text).toBe('one\n\nYes, the cat sat down\n\nthree\n');
    await workspace.compareWith(null);
    expect(workspace.unreviewed).toBe(0);
  });

  it('says so when the cursor is not in a change', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    workspace.view?.dispatch({ selection: { anchor: 0 } });
    expect(workspace.revertHere()).toBe(false);
    expect(workspace.status).toContain('not in a change');
  });
});

describe('the history panel', () => {
  it('lists the versions of the document in front', async () => {
    await workspace.openPath('/a/one.md');
    workspace.showPanel('history');
    expect(workspace.panel).toBe('history');
    expect(workspace.sidebar).toBe(true);
    await workspace.refreshHistory();
    expect(workspace.snapshots.map((info) => info.author)).toEqual(['user']);
  });

  it('has nothing to list for a document that has never been saved', async () => {
    workspace.newUntitled();
    workspace.showPanel('history');
    await workspace.refreshHistory();
    expect(workspace.snapshots).toEqual([]);
  });

  it('marks what changed since a version the reader picked', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    workspace.showPanel('history');
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    await workspace.refreshHistory();
    workspace.markReviewed();
    expect(workspace.unreviewed).toBe(0);
    // The version the file was opened at, which is now two writes back.
    const first = workspace.snapshots.at(-1);
    if (!first) throw new Error('no versions');
    await workspace.compareWith(first);
    expect(workspace.activeDoc?.againstId).toBe(first.id);
    expect(workspace.unreviewed).toBe(1);
    await workspace.compareWith(first);
    expect(workspace.activeDoc?.againstId).toBe(null);
    expect(workspace.unreviewed).toBe(0);
  });

  it('stops comparing once the reader says they have seen it', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    await workspace.refreshHistory();
    const first = workspace.snapshots.at(-1);
    if (!first) throw new Error('no versions');
    await workspace.compareWith(first);
    workspace.markReviewed();
    expect(workspace.activeDoc?.against).toBe(null);
  });

  /**
   * "Restore is itself a user snapshot, so nothing is ever lost": the
   * buffer that is about to be replaced becomes a version first.
   */
  it('keeps what is in the buffer before putting an old version back', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 0, to: 3, insert: 'EDITED' } });
    await workspace.refreshHistory();
    const first = workspace.snapshots.at(-1);
    if (!first) throw new Error('no versions');
    await workspace.restoreSnapshot(first);
    expect(workspace.activeDoc?.text).toBe(file);
    const kept = await ipc.commands.listSnapshots('/a/one.md');
    expect(kept.status === 'ok' && kept.data.some((info) => info.author === 'user')).toBe(true);
    const held = await ipc.commands.readSnapshot(
      (kept.status === 'ok' ? kept.data[0]?.id : '') ?? '',
    );
    expect(held.status === 'ok' && held.data.startsWith('EDITED')).toBe(true);
  });

  /** Read mode has no editor to dispatch to, so the buffer takes it. */
  it('puts a version back into a document nobody is editing', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 0, to: 3, insert: 'EDITED' } });
    await workspace.refreshHistory();
    workspace.unmount();
    workspace.setMode('read');
    const first = workspace.snapshots.at(-1);
    if (!first) throw new Error('no versions');
    await workspace.restoreSnapshot(first);
    expect(workspace.activeDoc?.text).toBe(file);
  });

  it('opens a past version in a tab of its own, marked against the one before it', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await rewritten('one\n\nthe cat stood up\n\nthree\n');
    await workspace.refreshHistory();
    const newest = workspace.snapshots[0];
    if (!newest) throw new Error('no versions');
    await workspace.openVersion(newest);
    const doc = workspace.activeDoc;
    expect(doc?.path).toBe(null);
    expect(doc?.ephemeral).toBe(true);
    expect(doc?.text).toBe('one\n\nthe cat stood up\n\nthree\n');
    expect(doc?.changes.map((record) => record.kind)).toEqual(['changed']);
  });

  /** A view of a past version is not a document to come back to. */
  it('leaves an opened version out of the session', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.refreshHistory();
    const newest = workspace.snapshots[0];
    if (!newest) throw new Error('no versions');
    await workspace.openVersion(newest);
    const session = workspace.sessionState();
    expect(session.tabs).toHaveLength(1);
    expect(session.documents).toEqual([{ path: '/a/one.md', untitled: null }]);
  });
});
