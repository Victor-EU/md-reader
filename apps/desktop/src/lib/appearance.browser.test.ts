import { EditorView } from '@codemirror/view';
import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAppearance, DEFAULT_SETTINGS, DEFAULT_SIZE, SIZES } from './appearance.ts';
import { createShell, type Shell } from './shell.svelte.ts';
import { Workspace } from './workspace.svelte.ts';
// The attributes this file writes mean nothing without the stylesheet.
import '../app.css';

let ipc: FakeIpc;
let shell: Shell;
let workspace: Workspace;
let host: HTMLDivElement;
let extra: Workspace[] = [];

const FILES = { '/a/one.md': '# One\n\nFirst file.\n', '/a/two.md': '# Two\n' };

/** Longer than the shell's own pause before it pushes the session. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  ipc = createFakeIpc(FILES);
  shell = createShell({ commands: ipc.commands, mac: true });
  workspace = shell.workspace;
});

afterEach(() => {
  workspace.destroy();
  for (const other of extra) other.destroy();
  extra = [];
  host.remove();
  const root = document.documentElement;
  root.removeAttribute('data-appearance');
  root.removeAttribute('data-paper');
  for (const name of ['--read-family', '--read-size', '--read-measure']) {
    root.style.removeProperty(name);
  }
});

describe('dressing the window', () => {
  it('turns the settings into two attributes and three lengths', () => {
    const root = document.documentElement;
    applyAppearance(
      root,
      { ...DEFAULT_SETTINGS, paper: 'cream', family: 'serif', size: 18 },
      false,
    );
    expect(root.dataset.appearance).toBe('light');
    expect(root.dataset.paper).toBe('cream');
    expect(root.style.getPropertyValue('--read-size')).toBe('18px');
    expect(root.style.getPropertyValue('--read-measure')).toBe('68ch');
    const styles = getComputedStyle(root);
    // Which the generated stylesheet turns into theme one's cream paper.
    expect(styles.getPropertyValue('--page-bg').trim()).toBe('#faf5ec');
    expect(styles.getPropertyValue('--read-family')).toContain('Source Serif 4 Variable');
  });

  it('follows the system when the setting says system', () => {
    const root = document.documentElement;
    applyAppearance(root, DEFAULT_SETTINGS, true);
    expect(root.dataset.appearance).toBe('dark');
    expect(getComputedStyle(root).getPropertyValue('--page-bg').trim()).toBe('#1e1c1a');
    applyAppearance(root, { ...DEFAULT_SETTINGS, appearance: 'light' }, true);
    expect(root.dataset.appearance).toBe('light');
  });

  /**
   * The high-contrast paper is dark inside a light window (design 11),
   * so the code on it takes the dark palette while the chrome stays
   * light — which is the reason the page and the window are two
   * questions and not one.
   */
  it('gives the black paper the dark palette in a light window', () => {
    const root = document.documentElement;
    applyAppearance(root, { ...DEFAULT_SETTINGS, paper: 'black' }, false);
    const styles = getComputedStyle(root);
    expect(styles.getPropertyValue('--page-bg').trim()).toBe('#121212');
    expect(styles.getPropertyValue('--tok-keyword').trim()).toBe('#d98cc9');
    expect(styles.getPropertyValue('--bar-bg').trim()).toBe('#f1efec');
  });

  it('tells the live editor which paper it is on', async () => {
    await workspace.openPath('/a/one.md');
    workspace.setMode('source');
    workspace.mount(host);
    const view = workspace.view as EditorView;
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    workspace.updateSettings({ paper: 'black' });
    expect(workspace.darkPage).toBe(true);
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    workspace.unmount();
  });
});

describe('zoom', () => {
  it('steps the reading size and writes it down', async () => {
    shell.registry.run('view.zoomIn');
    expect(workspace.settings.size).toBe(17);
    shell.registry.run('view.zoomOut');
    shell.registry.run('view.zoomOut');
    expect(workspace.settings.size).toBe(15);
    shell.registry.run('view.zoomReset');
    expect(workspace.settings.size).toBe(DEFAULT_SIZE);
    await settle();
    expect(ipc.settings.size).toBe(DEFAULT_SIZE);
  });

  it('stops at the ends of the scale and says so', () => {
    workspace.updateSettings({ size: SIZES.at(-1) });
    workspace.zoom(1);
    expect(workspace.settings.size).toBe(SIZES.at(-1));
    expect(workspace.status).toContain('as large as it goes');
    workspace.updateSettings({ size: SIZES[0] });
    workspace.zoom(-1);
    expect(workspace.settings.size).toBe(SIZES[0]);
    expect(workspace.status).toContain('as small as it goes');
  });
});

describe('the settings tab', () => {
  it('is a tab, and only ever one', async () => {
    await workspace.openPath('/a/one.md');
    const first = workspace.openSettings();
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.activeId).toBe(first.id);
    // A document command has nothing to act on while it is in front.
    expect(workspace.activeDoc).toBeNull();
    expect(shell.registry.run('edit.highlight')).toBe(false);
    expect(shell.registry.isEnabled(shell.registry.get('file.close'))).toBe(true);

    workspace.activate(workspace.tabs[0]?.id ?? null);
    expect(workspace.openSettings().id).toBe(first.id);
    expect(workspace.tabs).toHaveLength(2);
  });

  it('is not a file, so quick open does not offer it', async () => {
    await workspace.openPath('/a/one.md');
    workspace.openSettings();
    expect(workspace.fileChoices().map((choice) => choice.label)).toEqual(['one.md']);
  });

  it('closes, and comes back with the reopened tabs', async () => {
    workspace.openSettings();
    workspace.closeActive();
    expect(workspace.settingsTab).toBeNull();
    expect(workspace.status).toBe('Closed Settings');
    workspace.reopenClosed();
    expect(workspace.settingsTab).not.toBeNull();
  });

  it('comes back with the session, in its place', async () => {
    await workspace.openPath('/a/one.md');
    workspace.openSettings();
    await workspace.openPath('/a/two.md');
    workspace.activate(workspace.tabs[1]?.id ?? null);

    const next = new Workspace({ commands: ipc.commands });
    extra.push(next);
    await next.restore(workspace.sessionState());
    expect(next.tabs.map((tab) => tab.kind)).toEqual(['document', 'settings', 'document']);
    expect(next.tabs[1]?.id).toBe(next.settingsTab?.id);
    expect(next.activeTab?.kind).toBe('settings');
    expect(next.labels).toEqual(['one.md', 'Settings', 'two.md']);
  });

  it('remembers what the reader chose', async () => {
    workspace.updateSettings({ paper: 'pad', family: 'serif', measure: 80 });
    await settle();
    const next = new Workspace({ commands: ipc.commands });
    extra.push(next);
    const restore = await ipc.commands.loadWindow();
    next.applySettings(restore.settings);
    expect(next.settings).toEqual({
      ...DEFAULT_SETTINGS,
      paper: 'pad',
      family: 'serif',
      measure: 80,
    });
  });
});
