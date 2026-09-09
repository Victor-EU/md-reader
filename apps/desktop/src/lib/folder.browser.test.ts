import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

/**
 * The folder workspace as the window meets it (design 4.1, plan WP 2.4):
 * the tree, the palette over it, the content search, and what a launch
 * puts back. Which files a folder contains is `crates/core`'s question —
 * it is the walker that answers `.gitignore` — so these are about what
 * the window does with the answer.
 */
let ipc: FakeIpc;
let workspace: Workspace;
let folder: string | null;

const FILES = {
  '/w/plan.md': '# Plan\n\nthe cat sat\n',
  '/w/notes/deep.md': '# Deep\n\nnothing here\n',
  '/w/notes/cats.md': '# Cats\n\nthe cat again\n',
};

function start(files: Record<string, string> = FILES) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({
    commands: ipc.commands,
    pickFolder: async () => folder,
  });
  // Exactly what `main.ts` wires the real events to.
  ipc.onFolderChange((change) => workspace.folderChanged(change));
  ipc.onSearchProgress((progress) => workspace.searchProgress(progress));
  ipc.onSearchDone((done) => workspace.searchDone(done));
}

/** The tree as the sidebar draws it: name, and how deep it is. */
function rows(): string[] {
  return workspace.folder.rows.map((row) => `${'  '.repeat(row.depth)}${row.name}`);
}

/** Let the fake's events, which arrive as microtasks, land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  folder = '/w';
  start();
});

afterEach(() => {
  workspace.destroy();
});

describe('opening a folder', () => {
  it('lists the top level and shows the sidebar on it', async () => {
    await workspace.pickAndOpenFolder();
    expect(workspace.folder.root).toBe('/w');
    expect(workspace.folder.name).toBe('w');
    expect(workspace.sidebar).toBe(true);
    expect(workspace.panel).toBe('files');
    expect(rows()).toEqual(['notes', 'plan.md']);
    expect(workspace.status).toBe('Working in w');
  });

  it('reads a folder only when it is opened', async () => {
    await workspace.openFolder('/w');
    expect(rows()).toEqual(['notes', 'plan.md']);
    await workspace.folder.toggle('/w/notes');
    expect(rows()).toEqual(['notes', '  cats.md', '  deep.md', 'plan.md']);
    await workspace.folder.toggle('/w/notes');
    expect(rows()).toEqual(['notes', 'plan.md']);
  });

  it('opens a file from the tree into a tab', async () => {
    await workspace.openFolder('/w');
    await workspace.openFile('/w/plan.md');
    expect(workspace.tabs.length).toBe(1);
    expect(workspace.activeDoc?.path).toBe('/w/plan.md');
    expect(workspace.folder.selected).toBe('/w/plan.md');
  });

  it('keeps the tabs when the folder is closed, and offers the recents', async () => {
    await workspace.openFolder('/w');
    await workspace.openFile('/w/plan.md');
    workspace.closeFolder();
    expect(workspace.folder.root).toBeNull();
    expect(workspace.tabs.length).toBe(1);
    expect(workspace.recents).toEqual(['/w/plan.md']);
    // The panel stays where it is: without a folder it is the recents.
    expect(workspace.panel).toBe('files');
  });
});

describe('the folder watch', () => {
  it('re-reads a folder the tree is showing when something is written', async () => {
    await workspace.openFolder('/w');
    await ipc.commands.createFile('/w', 'fresh.md');
    await settle();
    expect(rows()).toEqual(['notes', 'fresh.md', 'plan.md']);
  });

  /** The watch covers the whole folder; most of it is not on screen. */
  it('says nothing about a folder nobody has opened', async () => {
    await workspace.openFolder('/w');
    await ipc.commands.createFile('/w/notes', 'unseen.md');
    await settle();
    expect(rows()).toEqual(['notes', 'plan.md']);
    await workspace.folder.toggle('/w/notes');
    expect(rows()).toContain('  unseen.md');
  });
});

describe('new files in the tree', () => {
  it('makes one in the selected folder and asks for its name', async () => {
    await workspace.openFolder('/w');
    workspace.folder.selected = '/w/notes';
    await workspace.newFileInFolder();
    expect(ipc.files.has('/w/notes/Untitled.md')).toBe(true);
    expect(workspace.folder.renaming).toBe('/w/notes/Untitled.md');
    expect(rows()).toContain('  Untitled.md');
  });

  it('opens the file it just made once it has a name', async () => {
    await workspace.openFolder('/w');
    await workspace.newFileInFolder();
    await workspace.renameInFolder('/w/Untitled.md', 'brief.md');
    expect(ipc.files.has('/w/brief.md')).toBe(true);
    expect(workspace.activeDoc?.path).toBe('/w/brief.md');
    expect(workspace.folder.renaming).toBeNull();
    // Made to be written in, and empty: there is nothing to read.
    expect(workspace.activeTab?.mode).toBe('edit');
  });

  it('takes a tab with it when a file it holds is renamed', async () => {
    await workspace.openFolder('/w');
    await workspace.openFile('/w/plan.md');
    await workspace.renameInFolder('/w/plan.md', 'strategy.md');
    expect(workspace.activeDoc?.path).toBe('/w/strategy.md');
    expect(workspace.status).toBe('plan.md is now strategy.md');
  });

  it('refuses a name that is already taken and says so', async () => {
    await workspace.openFolder('/w');
    await workspace.folder.toggle('/w/notes');
    await workspace.renameInFolder('/w/notes/cats.md', 'deep.md');
    expect(ipc.files.has('/w/notes/cats.md')).toBe(true);
    expect(workspace.status).toContain('already');
  });
});

describe('Cmd+P over the folder', () => {
  it('offers the folder after the tabs, and never a file twice', async () => {
    await workspace.openFolder('/w');
    await workspace.openFile('/w/plan.md');
    workspace.openPalette('files');
    workspace.setPaletteQuery('cats');
    await settle();
    expect(workspace.folderMatches?.hits.map((hit) => hit.path)).toEqual(['/w/notes/cats.md']);
    expect(workspace.folderMatches?.hits[0]?.dir).toBe('notes');
    // The open tab is the window's own row; the folder does not repeat it.
    workspace.setPaletteQuery('plan');
    await settle();
    expect(workspace.fileChoices().map((choice) => choice.path)).toContain('/w/plan.md');
  });

  it('asks nothing of Rust with no folder open', async () => {
    workspace.openPalette('files');
    workspace.setPaletteQuery('plan');
    await settle();
    expect(workspace.folderMatches).toBeNull();
    expect(ipc.calls.some((call) => call.command === 'find_files')).toBe(false);
  });

  /** Answers can arrive out of order; only the newest question has one. */
  it('keeps the answer to the newest keystroke', async () => {
    await workspace.openFolder('/w');
    workspace.openPalette('files');
    workspace.setPaletteQuery('cat');
    workspace.setPaletteQuery('deep');
    await settle();
    expect(workspace.folderMatches?.hits.map((hit) => hit.name)).toEqual(['deep.md']);
  });
});

describe('searching the folder', () => {
  it('fills with results as they are found and groups them by file', async () => {
    await workspace.openFolder('/w');
    workspace.search.type('cat');
    await workspace.search.run();
    await settle();
    expect(workspace.search.running).toBe(false);
    // `# Cats` matches too: the search is not case-sensitive.
    expect(workspace.search.found).toBe(3);
    expect(workspace.search.groups.map((group) => group.name)).toEqual(['plan.md', 'cats.md']);
    expect(workspace.search.groups[1]?.dir).toBe('notes');
    expect(workspace.search.groups[1]?.hits).toHaveLength(2);
    expect(workspace.search.groups[0]?.hits[0]?.line).toBe(3);
  });

  it('opens a result at the line the match is on', async () => {
    await workspace.openFolder('/w');
    workspace.search.query = 'cat again';
    await workspace.search.run();
    await settle();
    const hit = workspace.search.hits[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    await workspace.openHit(hit);
    expect(workspace.activeDoc?.path).toBe('/w/notes/cats.md');
    const tab = workspace.activeTab;
    const at = workspace.activeDoc?.state.doc.lineAt(tab?.selection.main.head ?? 0);
    expect(at?.text).toBe('the cat again');
    expect(at?.number).toBe(3);
  });

  it('drops the answers of a search that has been replaced', async () => {
    await workspace.openFolder('/w');
    workspace.search.query = 'cat';
    await workspace.search.run();
    // A batch from a search two keystrokes ago, arriving late.
    workspace.searchProgress({ id: -1, hits: [] });
    workspace.searchDone({ id: -1, hits: 99, truncated: true, cancelled: false });
    await settle();
    expect(workspace.search.truncated).toBe(false);
    expect(workspace.search.found).toBe(3);
  });

  it('says so rather than searching when there is no folder', () => {
    workspace.findInFolder();
    expect(workspace.status).toBe('Open a folder to search across it');
    expect(workspace.panel).not.toBe('files');
  });

  it('runs the query again when a flag changes', async () => {
    await workspace.openFolder('/w');
    workspace.search.query = 'Cat';
    await workspace.search.run();
    await settle();
    expect(workspace.search.found).toBe(3);
    workspace.search.flag({ caseSensitive: true });
    await settle();
    // Only `# Cats` has the capital.
    expect(workspace.search.found).toBe(1);
    expect(workspace.search.groups[0]?.name).toBe('cats.md');
  });

  it('clears the results with the query', async () => {
    await workspace.openFolder('/w');
    workspace.search.query = 'cat';
    await workspace.search.run();
    await settle();
    workspace.search.clear();
    expect(workspace.search.hits).toEqual([]);
    expect(workspace.search.showing).toBe('');
  });
});

describe('the session', () => {
  it('carries the folder and the panel, and puts them back', async () => {
    await workspace.openFolder('/w');
    await workspace.openFile('/w/plan.md');
    const content = workspace.sessionState();
    expect(content.folder).toBe('/w');
    expect(content.panel).toBe('files');

    const before = workspace;
    start();
    await workspace.restore(content, ['/w/plan.md']);
    expect(workspace.folder.root).toBe('/w');
    expect(workspace.panel).toBe('files');
    expect(rows()).toEqual(['notes', 'plan.md']);
    expect(workspace.tabs.length).toBe(1);
    before.destroy();
  });

  it('opens without one, and says so, when the folder has gone', async () => {
    start({});
    await workspace.restore({ documents: [], tabs: [], folder: '/gone', panel: 'files' }, []);
    expect(rows()).toEqual([]);
    expect(workspace.status).toBe('gone no longer there');
  });
});
