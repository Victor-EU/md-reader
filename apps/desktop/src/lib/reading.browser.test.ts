import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAppearance, DEFAULT_SETTINGS } from './appearance.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * The four themes and the settings one document may be read in instead
 * of the app's (design 11, plan WP 2.6).
 *
 * The theme is the window's and the override is the document's, which is
 * the whole shape of this: what a reader gives one report follows that
 * report between tabs and across a restart, and never reaches the tab
 * next to it.
 */
let ipc: FakeIpc;
let workspace: Workspace;

const FILES = {
  '/w/report.md': '# Report\n\nA long paragraph to read.\n',
  '/w/notes.md': '# Notes\n',
};

/** What a settled `await` leaves: the override arrives one turn late. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ipc = createFakeIpc(FILES);
  workspace = new Workspace({ commands: ipc.commands });
});

describe('the theme', () => {
  it('is written on the root element, and is the only thing that changes', () => {
    const root = document.createElement('div');
    applyAppearance(root, DEFAULT_SETTINGS, false);
    expect(root.dataset.theme).toBe('one');
    expect(root.dataset.appearance).toBe('light');
    expect(root.dataset.paper).toBe('white');

    applyAppearance(root, { ...DEFAULT_SETTINGS, theme: 'grove' }, false);
    expect(root.dataset.theme).toBe('grove');
    // A theme is the palette and nothing else: what the reader set the
    // page to is not a theme's to answer.
    expect(root.dataset.paper).toBe('white');
    expect(root.style.getPropertyValue('--read-size')).toBe('16px');
  });

  it('is an app setting, written down and told to every window', async () => {
    const other = new Workspace({ commands: ipc.commands });
    ipc.onSettingsChanged((settings) => other.applySettings(settings));
    workspace.updateSettings({ theme: 'slate' });
    await settled();
    expect(ipc.settings.theme).toBe('slate');
    // The window next to it is the same app, so it is wearing the same
    // theme without having been asked.
    expect(other.settings.theme).toBe('slate');
    expect(other.applied.theme).toBe('slate');
  });
});

describe('a document read in its own settings', () => {
  it('is read in them, while every other document is not', async () => {
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ family: 'serif', measure: 84 });
    expect(workspace.applied.family).toBe('serif');
    expect(workspace.applied.measure).toBe(84);
    expect(workspace.overridden).toBe(true);
    // The app itself has not moved.
    expect(workspace.settings.family).toBe('sans');

    await workspace.openPath('/w/notes.md');
    expect(workspace.applied.family).toBe('sans');
    expect(workspace.applied.measure).toBe(DEFAULT_SETTINGS.measure);
    expect(workspace.overridden).toBe(false);

    // And back again: the settings followed the document, not the tab.
    workspace.activate(workspace.tabs[0]?.id ?? '');
    expect(workspace.applied.family).toBe('serif');
  });

  it("says nothing about the window, which is not a document's to dress", async () => {
    await workspace.openPath('/w/report.md');
    workspace.updateSettings({ theme: 'ink', appearance: 'dark' });
    await workspace.setOverride({ paper: 'cream', family: 'serif' });
    expect(workspace.applied.theme).toBe('ink');
    expect(workspace.applied.appearance).toBe('dark');
    expect(workspace.applied.paper).toBe('cream');
  });

  /** The high-contrast paper is a dark page inside a light window. */
  it('takes the code palette with the paper it was given', async () => {
    await workspace.openPath('/w/report.md');
    expect(workspace.darkPage).toBe(false);
    await workspace.setOverride({ paper: 'black' });
    expect(workspace.darkPage).toBe(true);
    await workspace.openPath('/w/notes.md');
    expect(workspace.darkPage).toBe(false);
  });

  it('is kept beside the app rather than in the file', async () => {
    const before = ipc.files.get('/w/report.md')?.content;
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ family: 'mono' });
    expect(ipc.files.get('/w/report.md')?.content).toBe(before);
    expect(ipc.overrides.get('/w/report.md')).toEqual({ family: 'mono' });
  });

  it('is still there when the document is opened again', async () => {
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ size: 22 });
    workspace.close(workspace.tabs[0]?.id ?? '');
    expect(workspace.applied.size).toBe(DEFAULT_SETTINGS.size);

    await workspace.openPath('/w/report.md');
    await settled();
    expect(workspace.applied.size).toBe(22);
    expect(workspace.overridden).toBe(true);
  });

  it('goes away when the reader puts it back', async () => {
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ family: 'serif', size: 22 });
    await workspace.clearOverride();
    expect(workspace.overridden).toBe(false);
    expect(workspace.applied.family).toBe('sans');
    expect(ipc.overrides.has('/w/report.md')).toBe(false);
  });

  /** Overrides are kept by path, so there is nowhere to put one. */
  it('cannot be given to a document that has never been anywhere', async () => {
    workspace.newUntitled();
    await workspace.setOverride({ family: 'serif' });
    expect(workspace.overridden).toBe(false);
    expect(workspace.status).toMatch(/Save this document/);
  });

  /**
   * A document belongs to one window (plan WP 2.5), and what it is read
   * in belongs to the path, so it arrives with the tab.
   */
  it('goes with the tab to another window', async () => {
    const there = new Workspace({ commands: ipc.commands });
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ family: 'serif' });
    await workspace.moveTab(workspace.tabs[0]?.id ?? '');
    const move = ipc.moved.at(-1);
    if (!move) throw new Error('nothing was moved');
    there.adoptTab(move);
    await settled();
    expect(there.applied.family).toBe('serif');
    expect(there.overridden).toBe(true);
  });

  it('follows the file when it is renamed under the reader', async () => {
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ family: 'serif' });
    workspace.fileRenamed({ from: '/w/report.md', to: '/w/final.md' });
    await settled();
    expect(ipc.overrides.has('/w/report.md')).toBe(false);
    expect(ipc.overrides.get('/w/final.md')).toEqual({ family: 'serif' });
    expect(workspace.applied.family).toBe('serif');
  });
});

describe('zoom', () => {
  it('moves the app when the document is following it', async () => {
    await workspace.openPath('/w/report.md');
    workspace.zoom(1);
    expect(workspace.settings.size).toBe(17);
    expect(workspace.applied.size).toBe(17);
    expect(workspace.overridden).toBe(false);
  });

  /**
   * A document that was given a size of its own is the one that moves:
   * that is the size on the screen, and the one the key just changed.
   */
  it('moves the document when the document has a size of its own', async () => {
    await workspace.openPath('/w/report.md');
    await workspace.setOverride({ size: 20 });
    workspace.zoom(1);
    await settled();
    expect(workspace.applied.size).toBe(22);
    expect(workspace.settings.size).toBe(DEFAULT_SETTINGS.size);
    expect(ipc.overrides.get('/w/report.md')).toEqual({ size: 22 });
  });
});
