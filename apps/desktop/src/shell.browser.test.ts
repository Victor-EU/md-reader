import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App.svelte';
// The real stylesheet: layout, and the scrolling the read pane depends on.
import './app.css';
import { createShell, type Shell } from './lib/shell.svelte.ts';
import type { Updater } from './lib/update.ts';
import type { WorkspaceOptions } from './lib/workspace.svelte.ts';

let target: HTMLDivElement;
let app: Record<string, unknown>;
let shell: Shell;
let ipc: FakeIpc;
let picked: string[] = [];

/** The shell as the user meets it: the real components over the fake IPC. */
function start(files: Record<string, string> = {}, extra: Partial<WorkspaceOptions> = {}) {
  ipc = createFakeIpc(files);
  shell = createShell({
    commands: ipc.commands,
    mac: true,
    pickFiles: async () => picked,
    pickSaveTarget: async () => '/new/untitled.md',
    ...extra,
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
  // The window dresses the root element, which outlives the component.
  const root = document.documentElement;
  root.removeAttribute('data-appearance');
  root.removeAttribute('data-paper');
  for (const name of ['--read-family', '--read-size', '--read-measure']) {
    root.style.removeProperty(name);
  }
});

describe('the window', () => {
  it('starts empty and says what to do', () => {
    start();
    expect(target.querySelector('.blank')?.textContent).toMatch(/Open a markdown file/);
    expect(tabs()).toEqual([]);
  });

  /**
   * The blank window offers a new file in words, so it offers one to
   * click. Cmd+N and the command palette are the other two ways in
   * until the sidebar arrives in Phase 2 (plan WP 1.11).
   */
  it('starts a new file from the blank window', async () => {
    start();
    click('.blank .start');
    await settle();
    expect(labels()).toEqual(['Untitled 1 •']);
    expect(target.querySelector('.cm-editor')).not.toBeNull();
    expect(target.querySelector('.blank')).toBeNull();
    // Nowhere to be yet, which is not the same as having unsaved changes.
    const cells = [...target.querySelectorAll('.status .cell')].map((cell) => cell.textContent);
    expect(cells).toEqual(['0 words', 'UTF-8 · LF', 'Not saved yet']);
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

describe('autosave', () => {
  /**
   * The switch, the setting that is written down, and the status bar
   * field design 4.1 puts autosave state in (plan WP 1.11).
   */
  it('is turned off from the settings tab, and the status bar says so', async () => {
    start({ '/a/one.md': '# One\n' });
    picked = ['/a/one.md'];
    await press('KeyO');
    await press('Comma');

    const page = target.querySelector('.settings') as HTMLElement;
    const group = page.querySelector('[aria-labelledby="autosave-heading"]') as HTMLElement;
    const options = [...group.querySelectorAll<HTMLButtonElement>('.choice')];
    expect(options.map((choice) => choice.textContent?.trim())).toEqual(['On', 'Off']);
    expect(options.map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false']);

    options[1]?.click();
    await settle();
    expect(shell.workspace.settings.autosave).toBe(false);
    expect(ipc.settings.autosave).toBe(false);
    expect(options.map((choice) => choice.getAttribute('aria-checked'))).toEqual(['false', 'true']);

    shell.workspace.activate(shell.workspace.tabs[0]?.id ?? null);
    await press('KeyE', { alt: true });
    shell.workspace.view?.dispatch({ changes: { from: 0, insert: 'typed ' } });
    await settle();
    const cells = [...target.querySelectorAll('.status .cell')].map((cell) => cell.textContent);
    expect(cells).toEqual(['1 words', 'UTF-8 · LF', 'Unsaved changes', 'Autosave off']);
    expect(ipc.files.get('/a/one.md')?.content).toBe('# One\n');
  });
});

describe('the settings tab', () => {
  /**
   * Settings are a tab, not a modal (plan WP 1.9), and the page is
   * dressed by the settings it is editing — so a choice shows itself the
   * moment it is made.
   */
  it('opens on the keyboard and dresses the window from what is chosen', async () => {
    start({ '/a/one.md': '# One\n' });
    picked = ['/a/one.md'];
    await press('KeyO');
    await press('Comma');

    expect(labels()).toEqual(['one.md •', 'Settings']);
    expect(activeLabel()).toBe('Settings');
    const page = target.querySelector('.settings') as HTMLElement;
    expect(page.querySelector('h1')?.textContent).toBe('Settings');

    const paper = (name: string) =>
      page.querySelector<HTMLButtonElement>(`.paper[data-swatch="${name}"]`);
    expect(paper('white')?.getAttribute('aria-checked')).toBe('true');
    paper('pad')?.click();
    await settle();
    expect(document.documentElement.dataset.paper).toBe('pad');
    expect(paper('pad')?.getAttribute('aria-checked')).toBe('true');
    expect(shell.workspace.settings.paper).toBe('pad');

    // And the reading size is the zoom, so the two cannot disagree.
    await press('Equal');
    await settle();
    expect(document.documentElement.style.getPropertyValue('--read-size')).toBe('17px');
    expect(page.querySelector('.stepper .value')?.textContent).toBe('17px');
  });
});

describe('the find bar', () => {
  /**
   * Typing into the field must not re-select it. The whole find state is
   * replaced on every keystroke, so an effect watching it would select
   * the query back and the next character would replace it rather than
   * follow it (plan WP 1.10).
   */
  it('opens on Cmd+F and takes a query one character at a time', async () => {
    start({ '/a/one.md': '# One\n\nOne two one.\n' });
    picked = ['/a/one.md'];
    await press('KeyO');
    await press('KeyE', { alt: true });
    await press('KeyF');

    const field = target.querySelector<HTMLInputElement>('.find input[type=search]');
    if (!field) throw new Error('the find bar has no field');
    expect(document.activeElement).toBe(field);

    for (const character of 'one') {
      field.value += character;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }
    expect(field.value).toBe('one');
    expect(shell.workspace.find.query).toBe('one');
    // Three: the heading's One, the paragraph's One, and its one. The
    // search is case-insensitive until the Aa button says otherwise.
    expect(target.querySelector('.find .summary')?.textContent).toBe('3 matches');

    // And Escape gives the keyboard back.
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(target.querySelector('.find')).toBeNull();
    expect(shell.workspace.find.query).toBe('one');
  });
});

describe('the marks on the keyboard', () => {
  /**
   * Pressed on the editor itself, not on the window: that is the path
   * that broke. CodeMirror's own keymap sees the key first, and until
   * `Mod-i` was taken out of it Cmd+I selected the parent block and
   * `preventDefault` kept italic from ever running (plan WP 1.10).
   */
  async function pressInEditor(key: string, code: string) {
    const content = target.querySelector('.cm-content');
    if (!content) throw new Error('no editor is mounted');
    content.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, metaKey: true, bubbles: true, cancelable: true }),
    );
    await settle();
  }

  it('bolds and italicises the word under the cursor', async () => {
    start({ '/a/one.md': 'One two three.\n' });
    picked = ['/a/one.md'];
    await press('KeyO');
    await press('KeyE', { alt: true });
    const doc = shell.workspace.activeDoc;
    if (!doc) throw new Error('no document');
    const at = doc.text.indexOf('two') + 1;
    shell.workspace.view?.dispatch({ selection: { anchor: at } });

    await pressInEditor('b', 'KeyB');
    expect(doc.text).toBe('One **two** three.\n');
    await pressInEditor('i', 'KeyI');
    expect(doc.text).toBe('One ***two*** three.\n');
  });
});

describe('the updater in the chrome', () => {
  const updater: Updater = {
    check: async () => ({ version: '0.2.0' }),
    install: async (onProgress) => onProgress(1),
    relaunch: async () => {},
  };

  /** The status bar's update cell, when there is one. */
  function cell(): HTMLElement | null {
    return target.querySelector('.status .cell.update');
  }

  it('is a cell in the status bar that installs, then restarts', async () => {
    start({}, { updater });
    expect(cell()).toBeNull();

    await shell.registry.get('help.checkUpdates').run();
    await settle();
    const found = cell();
    expect(found?.textContent?.trim()).toBe('Version 0.2.0 is available');
    // Pressable, because there is something to do about it.
    expect(found?.tagName).toBe('BUTTON');

    (found as HTMLButtonElement).click();
    await settle();
    expect(cell()?.textContent?.trim()).toBe('Version 0.2.0 is ready — restart to finish');
  });

  it('says nothing in the chrome when there is nothing to say', async () => {
    start({}, { updater: { ...updater, check: async () => null } });
    await shell.registry.get('help.checkUpdates').run();
    await settle();
    expect(cell()).toBeNull();
    // The transient line still answers, because the reader asked.
    expect(shell.workspace.status).toBe('MD Reader is up to date');
  });

  it('offers install and restart only when they are possible', async () => {
    start({}, { updater });
    const install = shell.registry.get('help.installUpdate');
    const restart = shell.registry.get('help.restart');
    expect(shell.registry.isEnabled(install)).toBe(false);
    expect(shell.registry.isEnabled(restart)).toBe(false);

    await shell.workspace.checkForUpdates();
    expect(shell.registry.isEnabled(install)).toBe(true);
    expect(shell.registry.isEnabled(restart)).toBe(false);

    await shell.workspace.installUpdate();
    expect(shell.registry.isEnabled(install)).toBe(false);
    expect(shell.registry.isEnabled(restart)).toBe(true);
  });

  it('puts the version on the Settings tab', async () => {
    start({}, { updater });
    shell.workspace.version = '0.1.0';
    shell.workspace.openSettings();
    await settle();
    const about = target.querySelector('.page-settings');
    expect(about?.textContent).toContain('MD Reader 0.1.0');
    expect(about?.textContent).toContain('Check for updates');
  });
});
