import { conflicts } from '@markdown/editor-core';
import type { MergeResult } from '@markdown/ipc';
import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

/**
 * A hunk both sides wrote, from the watcher to the widget and back out
 * to the file (scenario S5, plan WP 2.1). Which hunks conflict is the
 * Rust merge's decision and is tested there; this is what the shell does
 * with the answer.
 */

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;

function open(files: Record<string, string>, merge?: () => MergeResult) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({
    commands: merge ? { ...ipc.commands, merge3: () => Promise.resolve(merge()) } : ipc.commands,
  });
}

/** What the EditorPane component's effect does, by hand. */
function edit() {
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

/** Longer than the pause autosave waits out (design 6.6). */
const pause = () => new Promise((resolve) => setTimeout(resolve, 900));

const contentOf = (path: string) => ipc.files.get(path)?.content;
const panels = () => host.querySelectorAll('.mdr-conflict-foot').length;

/**
 * Open one file, edit its second line, and let a write land on the same
 * line. The cursor stays in what the reader typed, which is where it
 * would be. The hunk is `ours\n` at 4..9 in the buffer that leaves.
 */
async function contested(): Promise<void> {
  open({ '/a/one.md': 'one\ntwo\nthree\n' }, () => ({
    changes: [],
    conflicts: [{ from: 4, to: 9, ours: 'ours\n', theirs: 'THEIRS\n' }],
  }));
  await workspace.openPath('/a/one.md');
  edit();
  workspace.view?.dispatch({
    changes: { from: 4, to: 7, insert: 'ours' },
    selection: { anchor: 8 },
  });
  await workspace.externalChange(ipc.externalWrite('/a/one.md', 'one\nTHEIRS\nthree\n'));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('a write nobody can merge', () => {
  it('keeps our version, draws theirs, and counts the question', async () => {
    await contested();
    expect(workspace.activeDoc?.text).toBe('one\nours\nthree\n');
    expect(workspace.unsettled).toBe(1);
    expect(panels()).toBe(1);
    expect(workspace.status).toContain('1 conflict to settle');
  });

  it('holds the save and says why when the reader presses it', async () => {
    await contested();
    expect(await workspace.save()).toBe(false);
    expect(workspace.status).toBe('one.md: 1 conflict to settle before it can be saved');
    expect(contentOf('/a/one.md')).toBe('one\nTHEIRS\nthree\n');
  });

  /**
   * The keystroke sets the timer; the write arrives before it fires. The
   * timer is called off, and a write nobody asked for would say nothing
   * anyway, so the line about what arrived is the one the reader is left
   * looking at. (This pins the second half: the cancellation itself is
   * only visible as a `Saving…` flicker, which is why it was found by
   * hand and not here.)
   */
  it('leaves the line that says what arrived standing', async () => {
    await contested();
    const said = workspace.status;
    await pause();
    expect(workspace.status).toBe(said);
    expect(contentOf('/a/one.md')).toBe('one\nTHEIRS\nthree\n');
  });

  it('holds the timer too, and lets it go when the question is answered', async () => {
    await contested();
    await pause();
    expect(contentOf('/a/one.md')).toBe('one\nTHEIRS\nthree\n');
    workspace.settleConflict(true);
    await vi.waitFor(() => expect(contentOf('/a/one.md')).toBe('one\nours\nthree\n'));
  });

  /** Keeping mine writes nothing, so this is the whole of what it does. */
  it('keeps our version when the reader says so', async () => {
    await contested();
    expect(workspace.settleConflict(true)).toBe(true);
    expect(workspace.activeDoc?.text).toBe('one\nours\nthree\n');
    expect(workspace.unsettled).toBe(0);
    expect(panels()).toBe(0);
    expect(workspace.status).toBe('Kept your version');
  });

  /**
   * The buttons in the widget go straight to the editor rather than
   * through the shell, so the line that says a question has been
   * answered has to be written where both roads meet -- otherwise the
   * bar goes on saying the save is held after it has been let go.
   */
  it('says so when the choice was made in the widget', async () => {
    await contested();
    const button = host.querySelector<HTMLElement>('.mdr-conflict-choice[data-choice="theirs"]');
    button?.click();
    expect(workspace.activeDoc?.text).toBe('one\nTHEIRS\nthree\n');
    expect(workspace.unsettled).toBe(0);
    expect(workspace.status).toBe('Took their version');
  });

  it('takes their version when the reader says so', async () => {
    await contested();
    expect(workspace.settleConflict(false)).toBe(true);
    expect(workspace.activeDoc?.text).toBe('one\nTHEIRS\nthree\n');
    expect(workspace.unsettled).toBe(0);
  });

  it('says so when the cursor is not in one', async () => {
    await contested();
    workspace.view?.dispatch({ selection: { anchor: 0 } });
    expect(workspace.settleConflict(true)).toBe(false);
    expect(workspace.status).toBe('Put the cursor in a conflict first');
    expect(workspace.unsettled).toBe(1);
  });
});

describe('finding the conflict', () => {
  it('puts the cursor on the next one', async () => {
    await contested();
    workspace.view?.dispatch({ selection: { anchor: 0 } });
    expect(workspace.stepConflict()).toBe(true);
    expect(workspace.view?.state.selection.main.head).toBe(4);
  });

  /**
   * Read mode has no widget to draw, so the step switches modes first --
   * the same reasoning as stepping changes, and the reason the status
   * bar's count is a button rather than a label.
   */
  it('switches out of Read mode to get to one', async () => {
    await contested();
    workspace.setMode('read');
    workspace.mountRead(host);
    expect(workspace.stepConflict()).toBe(true);
    workspace.unmount();
    workspace.mount(host);
    expect(workspace.activeTab?.mode).toBe('edit');
    expect(workspace.view?.state.selection.main.head).toBe(4);
  });
});

describe('a question that stays open', () => {
  it('survives the reader looking at the source and coming back', async () => {
    await contested();
    workspace.setMode('source');
    expect(workspace.unsettled).toBe(1);
    expect(panels()).toBe(1);
    workspace.setMode('edit');
    expect(panels()).toBe(1);
  });

  it('survives the tab going away and coming back', async () => {
    await contested();
    workspace.unmount();
    workspace.mount(host);
    expect(workspace.unsettled).toBe(1);
    expect(panels()).toBe(1);
  });

  /** The regions are mapped like everything else, so they stay put. */
  it('follows its text while the reader goes on typing above it', async () => {
    await contested();
    workspace.view?.dispatch({ changes: { from: 0, to: 0, insert: 'a new first line\n' } });
    const doc = workspace.activeDoc;
    if (!doc) throw new Error('no document');
    expect(conflicts(doc.state)[0]?.from).toBe(21);
    workspace.settleConflict(false);
    expect(workspace.activeDoc?.text).toBe('a new first line\none\nTHEIRS\nthree\n');
  });
});
