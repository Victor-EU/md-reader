import { EditorSelection } from '@codemirror/state';
import type { WindowContent } from '@mdreader/ipc';
import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;
let extra: Workspace[] = [];

const FILES = {
  '/a/one.md': '# One\n\nFirst file.\n',
  '/a/two.md': '# Two\n\nSecond file.\n',
  '/a/three.md': '# Three\n',
};

function open(files: Record<string, string> = FILES) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({ commands: ipc.commands });
}

/** A second window on the same files: what the next launch would build. */
function relaunch(): Workspace {
  const next = new Workspace({ commands: ipc.commands });
  extra.push(next);
  return next;
}

/** Longer than the shell's own pause before it pushes the session. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

const saves = () => ipc.calls.filter((call) => call.command === 'save_window').length;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open();
});

afterEach(() => {
  workspace.destroy();
  for (const other of extra) other.destroy();
  extra = [];
  host.remove();
});

describe('what a window remembers', () => {
  it('brings back the tabs, their modes, their pins and the one in front', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    await workspace.openPath('/a/three.md');
    workspace.setMode('source');
    workspace.togglePin(workspace.tabs[2]?.id ?? '');
    workspace.activate(
      workspace.tabs.find((tab) => workspace.doc(tab).path === '/a/two.md')?.id ?? null,
    );

    const next = relaunch();
    await next.restore(workspace.sessionState());

    expect(next.tabs.map((tab) => next.doc(tab).path)).toEqual([
      '/a/three.md',
      '/a/one.md',
      '/a/two.md',
    ]);
    expect(next.tabs.map((tab) => tab.pinned)).toEqual([true, false, false]);
    expect(next.tabs.map((tab) => tab.mode)).toEqual(['source', 'read', 'read']);
    expect(next.activeDoc?.path).toBe('/a/two.md');
  });

  it('brings back the sidebar, the comment toggle and the recent files', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    workspace.toggleSidebar();
    workspace.toggleComments();

    const next = relaunch();
    await next.restore(workspace.sessionState(), workspace.recents);

    expect(next.sidebar).toBe(true);
    expect(next.comments).toBe(true);
    expect(next.recents).toEqual(['/a/two.md', '/a/one.md']);
  });

  it('brings back where the cursor was and what was folded', async () => {
    await workspace.openPath('/a/one.md');
    const tab = workspace.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.selection = EditorSelection.single(4, 7);
    tab.anchor = { offset: 4, y: 0 };
    tab.folded = ['one'];

    const next = relaunch();
    await next.restore(workspace.sessionState());

    const back = next.tabs[0];
    expect(back?.selection.main.anchor).toBe(4);
    expect(back?.selection.main.head).toBe(7);
    expect(back?.anchor?.offset).toBe(4);
    expect(back?.folded).toEqual(['one']);
  });

  it('takes the cursor off the live editor rather than the tab copy of it', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setMode('edit');
    workspace.mount(host);
    workspace.view?.dispatch({ selection: { anchor: 9 } });

    expect(workspace.sessionState().tabs?.[0]?.selection).toEqual({ anchor: 9, head: 9 });
  });

  it('carries an untitled document whole, since the session is its only home', async () => {
    workspace.newUntitled();
    workspace.setMode('edit');
    workspace.mount(host);
    workspace.view?.dispatch({ changes: { from: 0, insert: 'notes to nobody' } });

    const next = relaunch();
    await next.restore(workspace.sessionState());

    expect(next.tabs).toHaveLength(1);
    expect(next.activeDoc?.path).toBeNull();
    expect(next.activeDoc?.text).toBe('notes to nobody');
    expect(next.activeDoc?.label).toBe('Untitled 1');
  });

  it('keeps the dirty dot on it: no file has that text', async () => {
    workspace.newUntitled();
    workspace.setMode('edit');
    workspace.mount(host);
    workspace.view?.dispatch({ changes: { from: 0, insert: 'notes to nobody' } });

    const next = relaunch();
    await next.restore(workspace.sessionState());

    expect(next.activeDoc?.dirty).toBe(true);
    // But the reader has read it, so it is not marked as a change.
    expect(next.unreviewed).toBe(0);
  });

  it('has nothing to be dirty about when it is empty', async () => {
    workspace.newUntitled();
    const next = relaunch();
    await next.restore(workspace.sessionState());
    expect(next.activeDoc?.dirty).toBe(false);
  });

  it('does not hand a new document a name a restored one already has', async () => {
    workspace.newUntitled();
    workspace.newUntitled();
    const next = relaunch();
    await next.restore(workspace.sessionState());
    next.newUntitled();
    expect(next.tabs.map((tab) => next.doc(tab).label)).toEqual([
      'Untitled 1',
      'Untitled 2',
      'Untitled 3',
    ]);
  });

  it('brings two views of one document back as two views of one buffer', async () => {
    await workspace.openPath('/a/one.md');
    workspace.duplicateView();

    const next = relaunch();
    await next.restore(workspace.sessionState());

    expect(next.tabs).toHaveLength(2);
    expect(next.sessionState().documents).toHaveLength(1);
    expect(next.doc(next.tabs[0] as never).id).toBe(next.doc(next.tabs[1] as never).id);
  });

  it('watches and snapshots every file it puts back', async () => {
    await workspace.openPath('/a/one.md');
    const saved = workspace.sessionState();

    const next = relaunch();
    ipc.watching.clear();
    ipc.calls.length = 0;
    await next.restore(saved);

    expect(ipc.watching.has('/a/one.md')).toBe(true);
    // Both are `open_document`'s doing, where the bytes are, so what is
    // asserted is that they happened rather than who asked for them.
    expect(await ipc.commands.listSnapshots('/a/one.md')).toMatchObject({
      status: 'ok',
      data: [{ author: 'user' }],
    });
  });

  it('counts the document it ends on, not every one it puts back', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    await workspace.openPath('/a/three.md');
    workspace.activate(
      workspace.tabs.find((tab) => workspace.doc(tab).path === '/a/three.md')?.id ?? null,
    );
    const saved = workspace.sessionState();

    const next = relaunch();
    await next.restore(saved);

    // A restore builds the strip rather than walking it: the tabs behind
    // the one in front are not visited, so nothing counts their words or
    // walks them for an outline nobody asked for (plan WP 3.3). The one
    // in front is a heading and nothing else; the other two are three
    // words each.
    expect(next.activeDoc?.path).toBe('/a/three.md');
    expect(next.words).toBe(1);
  });

  it('leaves out a file that is no longer there, and says which', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    const saved = workspace.sessionState();
    ipc.files.delete('/a/one.md');

    const next = relaunch();
    await next.restore(saved);

    expect(next.tabs.map((tab) => next.doc(tab).path)).toEqual(['/a/two.md']);
    expect(next.status).toContain('one.md no longer there');
  });

  it('keeps the cursor inside a file that has shrunk since', async () => {
    await workspace.openPath('/a/one.md');
    const tab = workspace.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.selection = EditorSelection.single(18);
    tab.anchor = { offset: 18, y: 0 };
    const saved = workspace.sessionState();
    ipc.files.set('/a/one.md', { content: '#\n' });

    const next = relaunch();
    await next.restore(saved);

    expect(next.tabs[0]?.selection.main.head).toBe(2);
    expect(next.tabs[0]?.anchor?.offset).toBe(2);
  });

  it('starts blank when there is nothing to put back', async () => {
    const next = relaunch();
    await next.restore({});
    expect(next.tabs).toEqual([]);
    expect(next.status).toBe('');
  });
});

describe('when the session is written down', () => {
  it('pushes once for a burst of changes, not once for each', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    workspace.setMode('source');
    workspace.togglePin(workspace.tabs[0]?.id ?? '');
    expect(saves()).toBe(0);

    await settle();

    expect(saves()).toBe(1);
    expect(ipc.session.content?.tabs).toHaveLength(2);
    expect(ipc.session.recents).toEqual(['/a/two.md', '/a/one.md']);
  });

  it('pushes a tab change at the end of the turn, not after a pause', async () => {
    await workspace.openPath('/a/one.md');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(saves()).toBe(1);
  });

  it('waits out a pause only for the text of a document with no file', async () => {
    workspace.newUntitled();
    workspace.setMode('edit');
    workspace.mount(host);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = saves();
    workspace.view?.dispatch({ changes: { from: 0, insert: 'typing' } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(saves()).toBe(before);
    await settle();
    expect(saves()).toBe(before + 1);
  });

  it('pushes and asks for a write when the window is closing', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.flushPending();
    expect(saves()).toBe(1);
    expect(ipc.flushes).toBe(1);
    expect(ipc.session.content?.documents).toEqual([{ path: '/a/one.md', untitled: null }]);
  });

  it('has nothing left pending after the flush', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.flushPending();
    await settle();
    expect(saves()).toBe(1);
  });

  it('leaves no push behind when the window is torn down', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setMode('edit');
    workspace.mount(host);
    workspace.destroy();
    await settle();
    expect(saves()).toBe(0);
  });

  it('records a file the reader closed as gone from the window', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.flushPending();
    workspace.closeActive();
    await workspace.flushPending();
    expect(ipc.session.content?.documents).toEqual([]);
    expect(ipc.session.recents).toEqual(['/a/one.md']);
  });
});

describe('the preferences', () => {
  it('start with autosave on, as the design says', () => {
    expect(workspace.settings.autosave).toBe(true);
  });

  it('are written down when they change', () => {
    workspace.updateSettings({ autosave: false });
    expect(workspace.settings.autosave).toBe(false);
    expect(ipc.settings.autosave).toBe(false);
  });
});

describe('the files a launch was asked to open', () => {
  it('opens them, and focuses the tab of one that is already open', async () => {
    await workspace.openPath('/a/one.md');
    const first = workspace.tabs[0]?.id;
    await workspace.openPaths(['/a/two.md', '/a/one.md']);
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.activeId).toBe(first);
  });

  it('opens what a restored window does not already hold', async () => {
    await workspace.openPath('/a/one.md');
    const saved = workspace.sessionState();

    const next = relaunch();
    await next.restore(saved);
    await next.openPaths(['/a/one.md', '/a/three.md']);

    expect(next.tabs.map((tab) => next.doc(tab).path)).toEqual(['/a/one.md', '/a/three.md']);
  });
});

describe('the shape the session file takes', () => {
  it('is a document list the tabs point into', async () => {
    await workspace.openPath('/a/one.md');
    workspace.duplicateView();
    workspace.newUntitled();
    const state: WindowContent = workspace.sessionState();
    expect(state.documents).toHaveLength(2);
    expect(state.tabs?.map((tab) => tab.document)).toEqual([0, 0, 1]);
    expect(state.tabs?.filter((tab) => tab.active)).toHaveLength(1);
  });
});
