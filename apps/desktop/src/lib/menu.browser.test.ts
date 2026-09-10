import type { MenuSection } from '@markdown/ipc';
import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchMenu } from './menu.svelte.ts';
import { createShell, type Shell } from './shell.svelte.ts';

let ipc: FakeIpc;
let shell: Shell;
let stop: (() => void) | null = null;
let host: HTMLDivElement;

const FILES = { '/a/one.md': '# One\n\nFirst file.\n', '/a/two.md': '# Two\n' };

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  ipc = createFakeIpc(FILES);
  shell = createShell({ commands: ipc.commands, mac: true });
});

afterEach(() => {
  stop?.();
  stop = null;
  shell.workspace.destroy();
  host.remove();
});

/** The item in the menu of that name, whatever it is called today. */
function item(sections: MenuSection[], menu: string, id: string) {
  const items = sections.find((section) => section.title === menu)?.items ?? [];
  return items.find((entry) => entry.kind === 'command' && entry.id === id) ?? null;
}

async function settle() {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

describe('the menu bar follows the window', () => {
  it('is redrawn when what a command can do changes', async () => {
    const drawn: MenuSection[][] = [];
    stop = watchMenu(shell.registry, (sections) => drawn.push(sections));
    await settle();
    expect(drawn.length).toBe(1);
    expect(item(drawn.at(-1) as MenuSection[], 'File', 'file.save')).toMatchObject({
      enabled: false,
    });

    await shell.workspace.openPaths(['/a/one.md']);
    await settle();
    shell.workspace.view?.dispatch({ changes: { from: 0, insert: 'x' } });
    await settle();

    expect(drawn.length).toBeGreaterThan(1);
    expect(item(drawn.at(-1) as MenuSection[], 'File', 'file.save')).toMatchObject({
      enabled: true,
      title: 'Save',
    });
  });

  it('stops being redrawn once it is stopped', async () => {
    const drawn: MenuSection[][] = [];
    stop = watchMenu(shell.registry, (sections) => drawn.push(sections));
    await settle();
    const was = drawn.length;
    stop();
    stop = null;
    await shell.workspace.openPaths(['/a/one.md']);
    await settle();
    expect(drawn.length).toBe(was);
  });
});

describe('the commands the menu bar needed', () => {
  it('undoes and redoes the document', async () => {
    await shell.workspace.openPaths(['/a/one.md']);
    await settle();
    shell.workspace.setMode('edit');
    shell.workspace.mount(host);
    const view = shell.workspace.view;
    if (!view) throw new Error('no editor');
    view.dispatch({ changes: { from: 0, insert: 'typed ' } });
    expect(view.state.doc.toString().startsWith('typed ')).toBe(true);

    expect(shell.registry.run('edit.undo')).toBe(true);
    expect(view.state.doc.toString()).toBe(FILES['/a/one.md']);
    expect(shell.registry.run('edit.redo')).toBe(true);
    expect(view.state.doc.toString().startsWith('typed ')).toBe(true);
  });

  it('does nothing, rather than throwing, with no document open', () => {
    expect(shell.workspace.undo()).toBe(false);
    expect(shell.workspace.redo()).toBe(false);
  });

  it('leaves a plain text field the undo the browser keeps for it', async () => {
    await shell.workspace.openPaths(['/a/one.md']);
    await settle();
    shell.workspace.setMode('edit');
    shell.workspace.mount(host);
    const view = shell.workspace.view;
    if (!view) throw new Error('no editor');
    view.dispatch({ changes: { from: 0, insert: 'typed ' } });
    const typed = view.state.doc.toString();

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    try {
      // The find bar and the settings are fields like this one. Undo
      // there is the browser's, not the document's — otherwise a reader
      // correcting a search term would silently undo their own writing.
      shell.workspace.undo();
      expect(view.state.doc.toString()).toBe(typed);
    } finally {
      field.remove();
    }
  });

  it('pins and unpins the tab in front, and says which it would do', async () => {
    await shell.workspace.openPaths(['/a/one.md', '/a/two.md']);
    await settle();
    const pin = shell.registry.get('go.pin');
    expect(pin.label?.()).toBe('Pin Tab');
    expect(shell.workspace.activeTab?.pinned).toBe(false);

    shell.registry.run('go.pin');
    expect(shell.workspace.activeTab?.pinned).toBe(true);
    expect(pin.label?.()).toBe('Unpin Tab');
    // A pinned tab moves to the front of the strip, as a double-click on
    // one has always done.
    expect(shell.workspace.tabs[0]?.id).toBe(shell.workspace.activeId);

    shell.registry.run('go.pin');
    expect(shell.workspace.activeTab?.pinned).toBe(false);
    expect(pin.label?.()).toBe('Pin Tab');
  });
});
