import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;
let saveTarget: string | null = '/new/untitled.md';

function open(files: Record<string, string>) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({
    commands: ipc.commands,
    pickFiles: async () => Object.keys(files),
    pickSaveTarget: async () => saveTarget,
  });
}

/** What the EditorPane component's effect does, by hand. */
function remount() {
  workspace.unmount();
  workspace.mount(host);
}

/** A file opens in Read mode (design 4.2); these tests are about the editor. */
function edit() {
  workspace.setMode('edit');
  remount();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  saveTarget = '/new/untitled.md';
  open({});
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('opening', () => {
  it('opens a file into a tab and reports its format', async () => {
    open({ '/a/one.md': '# One\n' });
    await workspace.openPath('/a/one.md');
    expect(workspace.tabs.length).toBe(1);
    expect(workspace.activeDoc?.text).toBe('# One\n');
    expect(workspace.labels).toEqual(['one.md']);
    expect(workspace.status).toBe('one.md · UTF-8 · LF');
    expect(workspace.recents).toEqual(['/a/one.md']);
  });

  it('focuses the existing tab when the path is already open', async () => {
    open({ '/a/one.md': 'one', '/a/two.md': 'two' });
    await workspace.openPath('/a/one.md');
    await workspace.openPath('/a/two.md');
    const first = workspace.tabs[0]?.id;
    await workspace.openPath('/a/one.md');
    expect(workspace.tabs.length).toBe(2);
    expect(workspace.activeId).toBe(first);
  });

  it('reports a missing file in the status bar and opens nothing', async () => {
    expect(await workspace.openPath('/gone.md')).toBe(false);
    expect(workspace.tabs).toEqual([]);
    expect(workspace.status).toBe('No such file or directory');
  });

  it('disambiguates tabs that share a file name', async () => {
    open({ '/site/docs/index.md': 'a', '/blog/docs/index.md': 'b' });
    await workspace.openPaths(['/site/docs/index.md', '/blog/docs/index.md']);
    expect(workspace.labels).toEqual(['site/docs/index.md', 'blog/docs/index.md']);
  });

  it('numbers untitled documents', () => {
    workspace.newUntitled();
    workspace.newUntitled();
    expect(workspace.labels).toEqual(['Untitled 1', 'Untitled 2']);
  });
});

describe('tabs', () => {
  beforeEach(async () => {
    open({ '/a.md': 'a', '/b.md': 'b', '/c.md': 'c' });
    await workspace.openPaths(['/a.md', '/b.md', '/c.md']);
  });

  it('jumps by index, with 9 meaning the last tab', () => {
    workspace.activateIndex(1);
    expect(workspace.activeDoc?.path).toBe('/a.md');
    workspace.activateIndex(9);
    expect(workspace.activeDoc?.path).toBe('/c.md');
  });

  it('cycles in both directions and wraps', () => {
    workspace.activateIndex(1);
    workspace.cycle(-1);
    expect(workspace.activeDoc?.path).toBe('/c.md');
    workspace.cycle(1);
    expect(workspace.activeDoc?.path).toBe('/a.md');
  });

  it('reorders by drag', () => {
    workspace.move(2, 0);
    expect(workspace.labels).toEqual(['c.md', 'a.md', 'b.md']);
  });

  it('keeps pinned tabs in their own block', () => {
    workspace.togglePin(workspace.tabs[2]?.id as string);
    expect(workspace.labels).toEqual(['c.md', 'a.md', 'b.md']);
    // An unpinned tab cannot be dragged in front of a pinned one.
    workspace.move(2, 0);
    expect(workspace.labels).toEqual(['c.md', 'b.md', 'a.md']);
    workspace.togglePin(workspace.tabs[0]?.id as string);
    expect(workspace.labels).toEqual(['c.md', 'b.md', 'a.md']);
  });

  it('activates the next tab when the active one closes', () => {
    workspace.activateIndex(2);
    workspace.closeActive();
    expect(workspace.labels).toEqual(['a.md', 'c.md']);
    expect(workspace.activeDoc?.path).toBe('/c.md');
  });

  it('reopens a closed tab where it was, with its buffer', () => {
    workspace.activateIndex(2);
    edit();
    workspace.view?.dispatch({ changes: { from: 0, insert: 'edited ' } });
    workspace.closeActive();
    expect(workspace.status).toMatch(/unsaved changes/);
    workspace.reopenClosed();
    expect(workspace.labels).toEqual(['a.md', 'b.md', 'c.md']);
    expect(workspace.activeDoc?.text).toBe('edited b');
    expect(workspace.activeDoc?.dirty).toBe(true);
  });
});

describe('views onto one document', () => {
  it('shares the buffer and keeps a cursor per view', async () => {
    open({ '/a.md': 'hello\n' });
    await workspace.openPath('/a.md');
    edit();
    workspace.view?.dispatch({ selection: { anchor: 5 } });

    workspace.duplicateView();
    remount();
    expect(workspace.tabs.length).toBe(2);
    expect(workspace.tabs[0]?.docId).toBe(workspace.tabs[1]?.docId);
    expect(workspace.view?.state.selection.main.head).toBe(5);

    // An edit in the second view moves the first view's saved cursor with it.
    workspace.view?.dispatch({ changes: { from: 0, insert: '# ' } });
    expect(workspace.tabs[0]?.selection.main.head).toBe(7);

    workspace.activate(workspace.tabs[0]?.id as string);
    remount();
    expect(workspace.activeDoc?.text).toBe('# hello\n');
    expect(workspace.view?.state.selection.main.head).toBe(7);
  });

  it('keeps the document open while another tab still shows it', async () => {
    open({ '/a.md': 'hello\n' });
    await workspace.openPath('/a.md');
    workspace.duplicateView();
    workspace.closeActive();
    expect(workspace.activeDoc?.text).toBe('hello\n');
  });
});

describe('modes', () => {
  it('switches the mounted view between edit and source, per tab', async () => {
    open({ '/a.md': '# Heading\n' });
    await workspace.openPath('/a.md');
    edit();
    const line = () => host.querySelector('.cm-line')?.className ?? '';
    expect(line()).toContain('mdr-h1');
    workspace.setMode('source');
    expect(line()).not.toContain('mdr-h1');
    expect(workspace.activeTab?.mode).toBe('source');

    workspace.newUntitled();
    remount();
    expect(workspace.activeTab?.mode).toBe('edit');
  });
});

describe('saving', () => {
  it('writes the buffer and clears the dirty flag', async () => {
    open({ '/a.md': 'a\n' });
    await workspace.openPath('/a.md');
    edit();
    workspace.view?.dispatch({ changes: { from: 0, insert: 'more ' } });
    expect(workspace.activeDoc?.dirty).toBe(true);

    expect(await workspace.save()).toBe(true);
    expect(ipc.files.get('/a.md')?.content).toBe('more a\n');
    expect(workspace.activeDoc?.dirty).toBe(false);
    expect(workspace.status).toBe('Saved a.md');
  });

  it('refuses when the file changed on disk and says so', async () => {
    open({ '/a.md': 'a\n' });
    await workspace.openPath('/a.md');
    ipc.externalWrite('/a.md', 'someone else\n');
    expect(await workspace.save()).toBe(false);
    expect(workspace.status).toMatch(/changed on disk/);
  });

  it('asks for a location the first time an untitled document is saved', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    workspace.view?.dispatch({ changes: { from: 0, insert: 'fresh' } });
    expect(await workspace.save()).toBe(true);
    expect(ipc.files.get('/new/untitled.md')?.content).toBe('fresh');
    expect(workspace.activeDoc?.path).toBe('/new/untitled.md');
    expect(workspace.labels).toEqual(['untitled.md']);
  });

  it('leaves the document untitled when the location panel is cancelled', async () => {
    saveTarget = null;
    workspace.newUntitled();
    expect(await workspace.save()).toBe(false);
    expect(workspace.activeDoc?.path).toBeNull();
  });

  it('will not save a document that opened read-only', async () => {
    open({});
    ipc.files.set('/latin.md', { content: 'a', format: { encoding: 'windows-1252' } });
    await workspace.openPath('/latin.md');
    expect(workspace.canSave).toBe(false);
    expect(await workspace.save()).toBe(false);
    expect(workspace.status).toMatch(/convert to UTF-8/);

    expect(await workspace.convertToUtf8()).toBe(true);
    expect(workspace.canSave).toBe(true);
  });
});

describe('the file palette', () => {
  it('lists open tabs first, then the recents that are not open', async () => {
    open({ '/a.md': 'a', '/b.md': 'b' });
    await workspace.openPaths(['/a.md', '/b.md']);
    workspace.closeActive();
    expect(workspace.fileChoices().map((choice) => [choice.label, choice.tabId !== null])).toEqual([
      ['a.md', true],
      ['b.md', false],
    ]);
  });

  it('counts words after an edit settles', async () => {
    open({ '/a.md': 'one two three\n' });
    await workspace.openPath('/a.md');
    expect(workspace.words).toBe(3);
    edit();
    workspace.view?.dispatch({ changes: { from: 0, insert: 'four ' } });
    workspace.countNow();
    expect(workspace.words).toBe(4);
  });
});
