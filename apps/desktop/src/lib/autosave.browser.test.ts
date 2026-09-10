import type { MergeResult } from '@markdown/ipc';
import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;
/** What the save panel was offered, and what it answers with. */
let suggested: string | null = null;
let saveTarget: string | null = null;

const FILES = { '/a/one.md': '# One\n', '/a/two.md': '# Two\n' };

/**
 * `merge` stands in for the Rust merge, which decides what conflicts.
 * The fake's own answer is a whole-document conflict whenever both sides
 * have moved, so a test about a race that merges cleanly has to say so.
 */
function open(files: Record<string, string> = FILES, merge?: () => MergeResult) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({
    commands: merge ? { ...ipc.commands, merge3: () => Promise.resolve(merge()) } : ipc.commands,
    pickSaveTarget: (name) => {
      suggested = name;
      return Promise.resolve(saveTarget);
    },
  });
}

/** What the EditorPane component's effect does, by hand. */
function edit() {
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

/** Type at the end of the document, the way the editor dispatches it. */
function type(text: string) {
  const view = workspace.view;
  if (!view) throw new Error('nothing is mounted');
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

/** Longer than the pause autosave waits out (design 6.6). */
const pause = () => new Promise((resolve) => setTimeout(resolve, 900));

const writes = (path?: string) =>
  ipc.calls.filter((call) => call.command === 'save_document' && (!path || call.args[0] === path))
    .length;

const contentOf = (path: string) => ipc.files.get(path)?.content;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  suggested = null;
  saveTarget = '/a/picked.md';
  open();
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('what the window closes on', () => {
  /** Open a file, edit it, and leave a conflict standing over the edit. */
  async function held() {
    open({ '/a/one.md': 'one\ntwo\nthree\n' }, () => ({
      changes: [],
      conflicts: [{ from: 4, to: 9, ours: 'ours\n', theirs: 'THEIRS\n' }],
    }));
    await workspace.openPath('/a/one.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 4, to: 7, insert: 'ours' } });
    await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\nTHEIRS\nthree\n'));
  }

  const versions = async (path: string) => {
    const listed = await ipc.commands.listSnapshots(path);
    return listed.status === 'ok' ? listed.data : [];
  };

  it('keeps a buffer the save was held for, rather than losing it with the window', async () => {
    await held();
    type('\nmore of it');
    const buffer = workspace.view?.state.doc.toString() ?? '';
    expect(writes('/a/one.md')).toBe(0);

    await workspace.flushPending();

    // Still not written -- the conflict is the reader's question to
    // answer and a close is not an answer. But the work exists now.
    expect(writes('/a/one.md')).toBe(0);
    const newest = (await versions('/a/one.md'))[0];
    expect(newest?.author).toBe('user');
    const read = await ipc.commands.readSnapshot(newest?.id ?? '');
    expect(read).toMatchObject({ status: 'ok', data: buffer });
  });

  it('keeps a dirty buffer that autosave was turned off for', async () => {
    open();
    await workspace.openPath('/a/one.md');
    workspace.setAutosave(false);
    edit();
    type('\ntyped with autosave off');
    const buffer = workspace.view?.state.doc.toString() ?? '';

    await workspace.flushPending();

    const newest = (await versions('/a/one.md'))[0];
    expect(newest?.author).toBe('user');
    expect(await ipc.commands.readSnapshot(newest?.id ?? '')).toMatchObject({
      status: 'ok',
      data: buffer,
    });
  });

  it('takes no version of a document the disk already has', async () => {
    open();
    await workspace.openPath('/a/one.md');
    edit();
    type('\nsaved by the timer');
    await pause();
    const before = (await versions('/a/one.md')).length;

    await workspace.flushPending();

    expect((await versions('/a/one.md')).length).toBe(before);
  });
});

describe('autosave', () => {
  it('writes the file once the typing stops', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('a first line\n');
    // Nothing yet: the reader is still in the middle of a sentence.
    expect(contentOf('/a/one.md')).toBe('# One\n');

    await pause();
    expect(contentOf('/a/one.md')).toBe('# One\na first line\n');
    expect(workspace.activeDoc?.dirty).toBe(false);
  });

  it('makes one write of a burst of typing, not one a keystroke', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    for (const word of ['a ', 'burst ', 'of ', 'typing']) {
      type(word);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await pause();
    expect(writes()).toBe(1);
    expect(contentOf('/a/one.md')).toBe('# One\na burst of typing\n');
  });

  it('writes nothing when the buffer has come back to what the file holds', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('typed then taken back');
    workspace.view?.dispatch({
      changes: { from: '# One\n'.length, to: workspace.view.state.doc.length },
    });
    await pause();
    expect(writes()).toBe(0);
  });

  it('leaves the file alone while it is off, and keeps the dirty dot', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setAutosave(false);
    edit();
    type('not going anywhere\n');
    await pause();
    expect(writes()).toBe(0);
    expect(workspace.activeDoc?.dirty).toBe(true);
    expect(contentOf('/a/one.md')).toBe('# One\n');
  });

  it('writes what is already dirty when it is turned back on', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setAutosave(false);
    edit();
    type('typed with it off\n');
    await pause();
    expect(writes()).toBe(0);

    workspace.setAutosave(true);
    await vi.waitFor(() => expect(contentOf('/a/one.md')).toBe('# One\ntyped with it off\n'));
    expect(workspace.status).toBe('Autosave on');
  });

  it('writes the document being left when another tab comes to the front', async () => {
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    workspace.activate(workspace.tabs[0]?.id ?? null);
    edit();
    type('half a sentence');

    workspace.activate(workspace.tabs[1]?.id ?? null);
    await vi.waitFor(() => expect(contentOf('/a/one.md')).toBe('# One\nhalf a sentence\n'));
  });

  it('does not count a second tab on the same document as leaving it', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('still here');
    workspace.duplicateView();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes()).toBe(0);
  });

  it('writes the document as its tab closes, and does not call it unsaved', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('typed and closed\n');
    workspace.closeActive();

    await vi.waitFor(() => expect(contentOf('/a/one.md')).toBe('# One\ntyped and closed\n'));
    expect(workspace.status).toBe('Closed one.md');
  });

  it('still says a closing tab had unsaved changes when autosave is off', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setAutosave(false);
    edit();
    type('kept in the buffer');
    workspace.closeActive();
    expect(workspace.status).toMatch(/with unsaved changes/);
    expect(writes()).toBe(0);
  });

  it('writes every open document before the window closes', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('one edited\n');
    await workspace.openPath('/a/two.md');
    edit();
    type('two edited\n');

    await workspace.flushPending();
    expect(contentOf('/a/one.md')).toBe('# One\none edited\n');
    expect(contentOf('/a/two.md')).toBe('# Two\ntwo edited\n');
    // The session is written after the files, so it records a window
    // whose documents are already on disk.
    expect(ipc.flushes).toBe(1);
    expect(ipc.session.content?.documents?.length).toBe(2);
  });

  it('never opens the save panel for a document nobody has named', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    type('# Not saved anywhere yet\n');
    await pause();
    await workspace.flushAutosave();
    workspace.closeActive();

    expect(suggested).toBeNull();
    expect(writes()).toBe(0);
  });

  it('leaves a document that opened read-only alone', async () => {
    open({});
    ipc.files.set('/latin.md', { content: '# Latin\n', format: { encoding: 'windows-1252' } });
    await workspace.openPath('/latin.md');
    edit();
    type('cannot be written\n');
    await pause();
    expect(writes()).toBe(0);
  });

  it('merges the write that got there first and tries again, without a word about it', async () => {
    // Their line goes to the top, ours to the bottom: two hunks with a
    // line between them, which is the merge deciding on its own.
    open(FILES, () => ({ changes: [{ from: 0, to: 5, insert: '# ONE' }], conflicts: [] }));
    await workspace.openPath('/a/one.md');
    edit();
    type('mine\n');
    // Somebody else writes the file while the timer is running. Nothing
    // told this window, so its expected hash is the one it opened with.
    ipc.externalWrite('/a/one.md', '# ONE\n');

    await pause();
    await vi.waitFor(() => expect(contentOf('/a/one.md')).toBe('# ONE\nmine\n'));
    // Refused once on the hash, then written after the merge.
    expect(writes()).toBe(2);
    expect(workspace.status).toMatch(/changed on disk/);
    expect(workspace.status).not.toMatch(/Saved/);
  });

  /**
   * The same race, where the merge cannot decide. The retry is held
   * rather than written: a timer must not answer a question the reader
   * has not been asked yet (design 7.2, plan WP 2.1).
   */
  it('holds the write when the race turns out to be a conflict', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('mine\n');
    ipc.externalWrite('/a/one.md', '# One\ntheirs\n');

    await pause();
    await vi.waitFor(() => expect(workspace.unsettled).toBe(1));
    expect(contentOf('/a/one.md')).toBe('# One\ntheirs\n');
    expect(workspace.activeDoc?.text).toBe('# One\nmine\n');
    expect(workspace.status).toContain('1 conflict to settle');

    // And it stays held: the timer does not come back for another go.
    const written = writes();
    type(' more\n');
    await pause();
    expect(writes()).toBe(written);
  });

  /**
   * The Changes badge counts what the reader has not looked at yet
   * (design 4.4). A timer firing is not them looking at it, so what
   * somebody else wrote stays marked until they say otherwise.
   */
  it('does not mark a write from somebody else as read just because it saved', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    await workspace.externalChange(ipc.externalWrite('/a/one.md', '# One\nfrom the agent\n'));
    expect(workspace.unreviewed).toBeGreaterThan(0);

    type('and mine\n');
    await pause();
    expect(contentOf('/a/one.md')).toBe('# One\nfrom the agent\nand mine\n');
    expect(workspace.unreviewed).toBeGreaterThan(0);

    // Saying so is still what clears them.
    workspace.markReviewed();
    expect(workspace.unreviewed).toBe(0);
  });

  it('records an autosaved version as one, and a save by hand as the reader', async () => {
    await workspace.openPath('/a/one.md');
    edit();
    type('typed\n');
    await pause();
    // Something of its own for the save by hand to record: a version is
    // its content, so saving what the timer already stored stores nothing.
    type('and more\n');
    await workspace.save();

    const listed = await ipc.commands.listSnapshots('/a/one.md');
    const authors =
      listed.status === 'ok' ? listed.data.map((snapshot) => snapshot.author).reverse() : [];
    // Opening the file, the autosave, and the save by hand.
    expect(authors).toEqual(['user', 'autosave', 'user']);
  });
});

describe('a new file', () => {
  it('is named from its first heading and lands beside the one already open', async () => {
    await workspace.openPath('/a/one.md');
    workspace.newUntitled();
    workspace.mount(host);
    type('# Team brief\n\n- what it is for\n- who reads it\n- when it is due\n');

    saveTarget = '/a/Team brief.md';
    expect(await workspace.save()).toBe(true);
    expect(suggested).toBe('/a/Team brief.md');
    expect(contentOf('/a/Team brief.md')).toBe(
      '# Team brief\n\n- what it is for\n- who reads it\n- when it is due\n',
    );
    expect(workspace.labels).toEqual(['one.md', 'Team brief.md']);
  });

  it('renders the heading before it names the file', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    type('# The **fast** path\n');
    saveTarget = null;
    await workspace.save();
    expect(suggested).toBe('The fast path.md');
  });

  it('proposes the name it already answers to when there is no heading', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    type('Three bullets and no title.\n');
    saveTarget = null;
    await workspace.save();
    expect(suggested).toBe('Untitled 1.md');
  });

  it('is autosaved from its first save on', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    type('# Brief\n');
    saveTarget = '/a/Brief.md';
    expect(await workspace.save()).toBe(true);

    type('\nand a second thought\n');
    await pause();
    expect(contentOf('/a/Brief.md')).toBe('# Brief\n\nand a second thought\n');
    expect(ipc.watching.has('/a/Brief.md')).toBe(true);
  });
});
