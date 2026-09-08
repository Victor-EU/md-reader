import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App.svelte';
// The real stylesheet: layout, and the scrolling the read pane depends on.
import './app.css';
import { createShell, type Shell } from './lib/shell.svelte.ts';

let target: HTMLDivElement;
let app: Record<string, unknown>;
let shell: Shell;
let ipc: FakeIpc;
let picked: string[] = [];

/** The shell as the user meets it: the real components over the fake IPC. */
function start(files: Record<string, string> = {}) {
  ipc = createFakeIpc(files);
  shell = createShell({
    commands: ipc.commands,
    mac: true,
    pickFiles: async () => picked,
    pickSaveTarget: async () => '/new/untitled.md',
  });
  app = mount(App, { target, props: { shell } });
}

/** Let effects, and any IPC call a command started, settle. */
async function settle() {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function press(code: string, modifiers: { shift?: boolean; alt?: boolean } = {}) {
  const key = code.startsWith('Key')
    ? (code.slice(3).toLowerCase() as string)
    : code.startsWith('Digit')
      ? code.slice(5)
      : code;
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code,
      metaKey: true,
      shiftKey: modifiers.shift ?? false,
      altKey: modifiers.alt ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
}

const tabs = () => [...target.querySelectorAll('.tab')];
/** Click something, and fail the test rather than the null check if it is missing. */
function click(selector: string, root: ParentNode = target) {
  const button = root.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`nothing matches ${selector}`);
  button.click();
}
const tabAt = (index: number): Element => {
  const tab = tabs()[index];
  if (!tab) throw new Error(`no tab ${index}`);
  return tab;
};
const labels = () => tabs().map((tab) => tab.querySelector('.label')?.textContent?.trim() ?? '');
const activeLabel = () =>
  target.querySelector('.tab.active .label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const rows = () => [...target.querySelectorAll('.palette .row')];
const status = () => target.querySelector('.status .message')?.textContent ?? '';

beforeEach(() => {
  target = document.createElement('div');
  document.body.appendChild(target);
  picked = [];
});

afterEach(async () => {
  await unmount(app, { outro: false });
  shell.workspace.destroy();
  target.remove();
});

describe('the window', () => {
  it('starts empty and says what to do', () => {
    start();
    expect(target.querySelector('.blank')?.textContent).toMatch(/Open a markdown file/);
    expect(tabs()).toEqual([]);
  });

  it('opens files through the OS panel, in Read mode', async () => {
    start({ '/a/one.md': '# One\n', '/a/two.md': 'two\n' });
    picked = ['/a/one.md', '/a/two.md'];
    await press('KeyO');
    expect(labels()).toEqual(['one.md •', 'two.md •']);
    expect(activeLabel()).toBe('two.md •');
    // A file opens rendered (design 4.2), and Edit is one shortcut away.
    expect(target.querySelector('.read p')?.textContent).toBe('two');
    expect(target.querySelector('.cm-editor')).toBeNull();

    await press('KeyE', { alt: true });
    expect(target.querySelector('.cm-editor')).not.toBeNull();
    expect(target.querySelector('.read')).toBeNull();
  });

  it('opens a file dropped on the window', async () => {
    start({ '/a/dropped.md': 'dropped\n' });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        getData: (type: string) => (type === 'text/uri-list' ? 'file:///a/dropped.md' : ''),
      },
    });
    target.querySelector('.frame')?.dispatchEvent(event);
    await settle();
    expect(labels()).toEqual(['dropped.md •']);
  });
});

describe('tab interactions', () => {
  beforeEach(async () => {
    start({ '/a.md': 'a\n', '/b.md': 'b\n', '/c.md': 'c\n' });
    picked = ['/a.md', '/b.md', '/c.md'];
    await press('KeyO');
  });

  it('activates a tab on click and closes one on the close button', async () => {
    click('.label', tabAt(0));
    await settle();
    expect(activeLabel()).toBe('a.md •');

    click('.close', tabAt(0));
    await settle();
    expect(labels()).toEqual(['b.md •', 'c.md •']);
    expect(status()).toBe('Closed a.md');
  });

  it('closes with the keyboard and reopens where it was', async () => {
    await press('KeyW');
    expect(labels()).toEqual(['a.md •', 'b.md •']);
    await press('KeyT', { shift: true });
    expect(labels()).toEqual(['a.md •', 'b.md •', 'c.md •']);
    expect(activeLabel()).toBe('c.md •');
  });

  it('jumps by number and cycles', async () => {
    await press('Digit1');
    expect(activeLabel()).toBe('a.md •');
    await press('Digit9');
    expect(activeLabel()).toBe('c.md •');
    await press('BracketLeft', { shift: true });
    expect(activeLabel()).toBe('b.md •');
    await press('BracketRight', { shift: true });
    expect(activeLabel()).toBe('c.md •');
  });

  it('pins a tab on double click and moves it to the front', async () => {
    tabs()[2]
      ?.querySelector('.label')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    expect(labels()).toEqual(['▪ c.md •', 'a.md •', 'b.md •']);
  });

  it('shows the dirty dot until the document is saved', async () => {
    await press('KeyE', { alt: true });
    shell.workspace.view?.dispatch({ changes: { from: 0, insert: 'more ' } });
    await settle();
    expect(target.querySelector('.tab.active .dot.dirty')).not.toBeNull();

    await press('KeyS');
    expect(ipc.files.get('/c.md')?.content).toBe('more c\n');
    expect(target.querySelector('.tab.active .dot.dirty')).toBeNull();
    expect(status()).toBe('Saved c.md');
  });
});

describe('the palette', () => {
  beforeEach(async () => {
    start({ '/notes/alpha.md': 'alpha\n', '/notes/beta.md': 'beta\n' });
    picked = ['/notes/alpha.md', '/notes/beta.md'];
    await press('KeyO');
  });

  it('filters files and opens the one that is chosen', async () => {
    await press('KeyP');
    expect(rows().map((row) => row.querySelector('.row-label')?.textContent?.trim())).toEqual([
      'alpha.md',
      'beta.md',
    ]);

    const input = target.querySelector('.palette .query') as HTMLInputElement;
    input.value = 'al';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(rows().length).toBe(1);
    expect(rows()[0]?.querySelector('mark')?.textContent).toBe('al');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(target.querySelector('.palette')).toBeNull();
    expect(activeLabel()).toBe('alpha.md •');
  });

  it('lists commands with their shortcuts and greys out the ones that cannot run', async () => {
    await press('KeyP', { shift: true });
    const rowFor = (title: string) =>
      rows().find((row) => row.querySelector('.row-label')?.textContent?.trim() === title);
    expect(rowFor('Save')?.querySelector('kbd')?.textContent).toBe('⌘S');
    expect(rowFor('Read Mode')?.querySelector('kbd')?.textContent).toBe('⌥⌘R');
    // Nothing here is in a foreign encoding, so there is nothing to convert.
    expect(rowFor('Convert to UTF-8')?.getAttribute('disabled')).not.toBeNull();
    expect(rowFor('Tab 1')).toBeUndefined();

    (rowFor('Source Mode') as HTMLButtonElement | undefined)?.click();
    await settle();
    expect(target.querySelector('.modes button[aria-pressed="true"]')?.textContent?.trim()).toBe(
      'Source',
    );
  });

  it('closes on Escape without changing the tab', async () => {
    await press('KeyP');
    const input = target.querySelector('.palette .query') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(target.querySelector('.palette')).toBeNull();
    expect(activeLabel()).toBe('beta.md •');
  });
});

describe('read mode', () => {
  const DOC = '# Title\n\nA paragraph.\n\n## Second\n\nMore words here.\n';

  beforeEach(async () => {
    start({ '/a.md': DOC });
    picked = ['/a.md'];
    await press('KeyO');
  });

  it('switches between the three modes from the toolbar and the keyboard', async () => {
    const pressed = () =>
      target.querySelector('.modes button[aria-pressed="true"]')?.textContent?.trim();
    expect(pressed()).toBe('Read');

    await press('KeyE', { alt: true });
    expect(pressed()).toBe('Edit');
    expect(target.querySelector('.cm-editor')).not.toBeNull();

    await press('KeyR', { alt: true });
    expect(pressed()).toBe('Read');
    expect(target.querySelector('.read h1')?.textContent).toContain('Title');

    click('.modes button:last-child');
    await settle();
    expect(pressed()).toBe('Source');
  });

  it('opens the sidebar on the outline and scrolls to a heading', async () => {
    expect(target.querySelector('.sidebar')).toBeNull();
    await press('KeyB', { shift: true });
    expect(
      [...target.querySelectorAll('.outline-entry')].map((el) => el.textContent?.trim()),
    ).toEqual(['Title', 'Second']);

    const pane = target.querySelector('.page-read') as HTMLElement;
    pane.style.height = '40px';
    target.style.height = '200px';
    const entries = [...target.querySelectorAll<HTMLButtonElement>('.outline-entry')];
    entries[1]?.click();
    await settle();
    expect(pane.scrollTop).toBeGreaterThan(0);
  });

  it('keeps the outline in the sidebar when the mode changes', async () => {
    await press('KeyB', { shift: true });
    await press('KeyE', { alt: true });
    await settle();
    expect(
      [...target.querySelectorAll('.outline-entry')].map((el) => el.textContent?.trim()),
    ).toEqual(['Title', 'Second']);
  });
});

describe('the status bar', () => {
  it('counts words, names the format, and shows the cursor in Source mode', async () => {
    start({ '/a.md': '# One two three\n' });
    picked = ['/a.md'];
    await press('KeyO');
    const cells = () => [...target.querySelectorAll('.status .cell')].map((c) => c.textContent);
    expect(cells()).toEqual(['3 words', 'UTF-8 · LF', 'Saved']);

    await press('KeyS', { alt: true });
    shell.workspace.view?.dispatch({ selection: { anchor: 4 } });
    await settle();
    expect(cells()).toEqual(['3 words', 'Ln 1, Col 5', 'UTF-8 · LF', 'Saved']);
  });
});
