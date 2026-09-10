import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

/**
 * More than one window (design 4.1, 6.5, plan WP 2.5). Two windows are
 * two webviews and share nothing, so a document belongs to one of them
 * at a time: these are about what it takes with it when it changes
 * hands, and about what each window is left holding.
 *
 * One fake stands for Rust, as one Rust process serves both windows.
 */
let host: HTMLDivElement;
let ipc: FakeIpc;
/** The window a tab leaves, and the one it arrives in. */
let here: Workspace;
let there: Workspace;

const FILES = { '/w/one.md': 'One two three.\n', '/w/two.md': '# Two\n' };

function open(files: Record<string, string> = FILES) {
  ipc = createFakeIpc(files);
  here = new Workspace({ commands: ipc.commands });
  there = new Workspace({ commands: ipc.commands });
}

/** Mount a window's editor on the shared host, as its pane does. */
function edit(workspace: Workspace) {
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

function type(workspace: Workspace, text: string) {
  const view = workspace.view;
  if (!view) throw new Error('nothing is mounted');
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

/** The one tab the window has, or a failure that says there is not one. */
function only(workspace: Workspace) {
  const tab = workspace.tabs[0];
  if (!tab) throw new Error('the window has no tab');
  return tab;
}

/** The payload the last move handed over. */
function handed() {
  const move = ipc.moved.at(-1);
  if (!move) throw new Error('nothing has been moved');
  return move;
}

const commands = () => ipc.calls.map((call) => call.command);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open();
});

afterEach(() => {
  here.destroy();
  there.destroy();
  host.remove();
});

describe('a tab moved to another window', () => {
  it('arrives with the document, the mode and the cursor it left with', async () => {
    await here.openPath('/w/one.md');
    edit(here);
    here.view?.dispatch({ selection: { anchor: 4, head: 7 } });

    expect(await here.moveTab(only(here).id)).toBe(true);
    there.adoptTab(handed());

    const tab = only(there);
    expect(there.activeDoc?.path).toBe('/w/one.md');
    expect(there.activeDoc?.text).toBe('One two three.\n');
    expect(tab.mode).toBe('edit');
    expect(tab.selection.main.anchor).toBe(4);
    expect(tab.selection.main.head).toBe(7);
    expect(there.status).toBe('one.md moved here');
  });

  it('can be undone on the other side, which is the history crossing with it', async () => {
    await here.openPath('/w/one.md');
    edit(here);
    type(here, 'and mine\n');
    expect(await here.moveTab(only(here).id)).toBe(true);

    there.adoptTab(handed());
    edit(there);
    const view = there.view;
    if (!view) throw new Error('nothing is mounted');
    expect(view.state.doc.toString()).toBe('One two three.\nand mine\n');
    // The reader presses Cmd+Z in the window the tab landed in.
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe('One two three.\n');
  });

  it('leaves the window it came from, and is not one of its closed tabs', async () => {
    await here.openPath('/w/one.md');
    await here.openPath('/w/two.md');
    expect(await here.moveTab(only(here).id)).toBe(true);

    expect(here.labels).toEqual(['two.md']);
    // Reopening it here would be a second copy of a document that lives
    // in another window now.
    expect(here.canReopen).toBe(false);
  });

  it('carries unsaved work, and the window it lands in is what writes it', async () => {
    await here.openPath('/w/one.md');
    edit(here);
    type(here, 'not on disk yet\n');
    expect(await here.moveTab(only(here).id)).toBe(true);
    // The timer that would have written it here was called off with it.
    expect(ipc.files.get('/w/one.md')?.content).toBe('One two three.\n');

    there.adoptTab(handed());
    expect(there.activeDoc?.dirty).toBe(true);
    await vi.waitFor(() =>
      expect(ipc.files.get('/w/one.md')?.content).toBe('One two three.\nnot on disk yet\n'),
    );
  });

  it('keeps the Changes badge, which a change of window does not answer', async () => {
    await here.openPath('/w/one.md');
    edit(here);
    await here.externalChange(ipc.externalWrite('/w/one.md', 'One two three.\nfrom the agent\n'));
    expect(here.unreviewed).toBeGreaterThan(0);

    expect(await here.moveTab(only(here).id)).toBe(true);
    there.adoptTab(handed());
    await vi.waitFor(() => expect(there.unreviewed).toBeGreaterThan(0));
  });

  it('gives up the watch before the other window takes it up', async () => {
    await here.openPath('/w/one.md');
    expect(await here.moveTab(only(here).id)).toBe(true);
    there.adoptTab(handed());
    // One entry per path in Rust: watched again after it is let go of,
    // never the other way round. The first watch is `open_document`'s,
    // taken where the file was read.
    expect(commands().filter((name) => name === 'watch' || name === 'unwatch')).toEqual([
      'unwatch',
      'watch',
    ]);
    expect(ipc.watching.has('/w/one.md')).toBe(true);
  });

  it('an untitled document keeps its name and its unsaved dot', async () => {
    here.newUntitled();
    here.mount(host);
    type(here, '# Nowhere yet\n');
    expect(await here.moveTab(only(here).id)).toBe(true);

    there.adoptTab(handed());
    expect(there.activeDoc?.label).toBe('Untitled 1');
    expect(there.activeDoc?.text).toBe('# Nowhere yet\n');
    expect(there.activeDoc?.dirty).toBe(true);
    // And the next new document there does not answer to the same name.
    there.newUntitled();
    expect(there.labels).toEqual(['Untitled 1', 'Untitled 2']);
  });

  it('arrives pinned when it left pinned, at the front of the strip', async () => {
    await here.openPath('/w/one.md');
    here.togglePin(only(here).id);
    expect(await here.moveTab(only(here).id)).toBe(true);

    await there.openPath('/w/two.md');
    there.adoptTab(handed());
    expect(there.labels).toEqual(['one.md', 'two.md']);
    expect(only(there).pinned).toBe(true);
  });

  it('is refused for a document with a second view in this window', async () => {
    await here.openPath('/w/one.md');
    here.duplicateView();
    expect(await here.moveTab(only(here).id)).toBe(false);
    expect(here.tabs.length).toBe(2);
    expect(here.status).toMatch(/another view in this window/);
    expect(ipc.moved.length).toBe(0);
  });

  it('is refused for a tab that is not a document', async () => {
    const settings = here.openSettings();
    expect(await here.moveTab(settings.id)).toBe(false);
    expect(here.tabs.length).toBe(1);
    expect(ipc.moved.length).toBe(0);
  });

  it('stays where it is when the other window cannot be reached', async () => {
    ipc = createFakeIpc(FILES);
    here = new Workspace({
      commands: {
        ...ipc.commands,
        moveTab: () =>
          Promise.resolve({
            status: 'error',
            error: { kind: 'unavailable', what: 'the other window', message: 'it has gone' },
          }),
      },
    });
    await here.openPath('/w/one.md');
    expect(await here.moveTab(only(here).id)).toBe(false);
    expect(here.labels).toEqual(['one.md']);
    expect(here.status).toContain('the other window');
    // And the file it holds is watched again, not left to nobody.
    expect(commands().filter((name) => name === 'watch' || name === 'unwatch')).toEqual([
      'unwatch',
      'watch',
    ]);
  });

  it('lands on the tab already open when the file is somehow open here too', async () => {
    await here.openPath('/w/one.md');
    await there.openPath('/w/one.md');
    expect(await here.moveTab(only(here).id)).toBe(true);

    there.adoptTab(handed());
    expect(there.labels).toEqual(['one.md']);
    expect(there.status).toBe('one.md is already open here');
  });
});

describe('a file another window has open', () => {
  it('comes forward there instead of opening a second copy here', async () => {
    ipc.elsewhere.add('/w/one.md');
    expect(await here.openPath('/w/one.md')).toBe(true);
    expect(here.tabs.length).toBe(0);
    expect(here.status).toBe('one.md is open in another window');
    expect(commands()).not.toContain('open_document');
  });

  it('is opened here when no other window has it', async () => {
    expect(await here.openPath('/w/one.md')).toBe(true);
    expect(here.labels).toEqual(['one.md']);
  });
});

describe('a new window', () => {
  it('is asked for by name and says so', async () => {
    await here.newWindow();
    expect(ipc.windows).toEqual(['main', 'window-2']);
    expect(here.status).toBe('New window');
  });

  it('is where the tear-off command puts the tab', async () => {
    await here.openPath('/w/one.md');
    expect(await here.tearOffActive()).toBe(true);
    expect(here.status).toBe('Moved one.md to a new window');
    expect(handed().path).toBe('/w/one.md');
  });
});
