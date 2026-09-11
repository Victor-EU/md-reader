import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
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
  // The folder events, wired exactly as `main.ts` wires the real ones.
  ipc.onFolderChange((change) => shell.workspace.folderChanged(change));
  ipc.onSearchProgress((progress) => shell.workspace.searchProgress(progress));
  ipc.onSearchDone((done) => shell.workspace.searchDone(done));
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
   * click (plan WP 1.11). Beside it is the other way in: a folder to
   * work in (design 4.1).
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
    expect(labels()).toEqual(['c.md •', 'a.md •', 'b.md •']);
    expect(tabAt(0).querySelector('.pin')).not.toBeNull();
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

  /**
   * A panel of rows is a flex column, and a flex column shrinks its
   * children to fit rather than letting them overflow. At a hundred rows
   * that is a pixel off each of them; at the thousands of headings a
   * very large document has (plan WP 2.7) it is a panel that looks empty
   * — which is what it did, in the app, on a twelve megabyte file.
   */
  it('gives every heading of a long document a row to itself', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `## Heading ${i}\n\nWords.`).join('\n\n');
    ipc.files.set('/long.md', { content: long });
    picked = ['/long.md'];
    await press('KeyO');
    target.style.height = '300px';
    await press('KeyB', { shift: true });
    for (let i = 0; i < 40 && shell.workspace.outline.length < 400; i++) await settle();

    const entries = [...target.querySelectorAll<HTMLElement>('.outline-entry')];
    expect(entries).toHaveLength(400);
    expect((entries[0] as HTMLElement).offsetHeight).toBeGreaterThan(10);
    // And the panel is what scrolls, rather than the rows being squeezed
    // into it.
    const panel = target.querySelector('.outline') as HTMLElement;
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight * 4);
  });

  it('keeps the outline in the sidebar when the mode changes', async () => {
    await press('KeyB', { shift: true });
    await press('KeyE', { alt: true });
    await settle();
    expect(
      [...target.querySelectorAll('.outline-entry')].map((el) => el.textContent?.trim()),
    ).toEqual(['Title', 'Second']);
  });

  /** The sidebar's three panels (design 4.1, 4.4). */
  it('switches between the files, the outline and the history', async () => {
    await press('KeyB', { shift: true });
    click('.sidebar-head button:last-child');
    await settle();
    expect(target.querySelector('.outline')).toBeNull();
    const rows = [...target.querySelectorAll('.version .when')];
    expect(rows).toHaveLength(1);
    click('.sidebar-head button:first-child');
    await settle();
    // No folder is open, so Files is the recent files (design 4.1).
    expect(target.querySelector('.files')).not.toBeNull();
    expect([...target.querySelectorAll('.tree .row-name')].map((el) => el.textContent)).toEqual([
      'a.md',
    ]);
    click('.sidebar-head button:nth-child(2)');
    await settle();
    expect(target.querySelector('.outline')).not.toBeNull();
  });

  it('marks what changed since a version the reader picks in the history', async () => {
    await press('KeyB', { shift: true });
    click('.sidebar-head button:last-child');
    await settle();
    // The file is written under us, which is a second version.
    await shell.workspace.externalChange(ipc.externalWrite('/a.md', '# Title\n\nrewritten\n'));
    await shell.workspace.refreshHistory();
    await settle();
    shell.workspace.markReviewed();
    await settle();
    expect(target.querySelector('.version.against')).toBeNull();
    click('.version:last-child .pick');
    await settle();
    expect(target.querySelector('.version.against')).not.toBeNull();
    expect(target.textContent).toContain('Comparing');
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
    expect(shell.workspace.status).toBe('Markdown is up to date');
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
    expect(about?.textContent).toContain('Markdown 0.1.0');
    expect(about?.textContent).toContain('Check for updates');
  });

  it('says who built it, and its links leave for the browser', async () => {
    const opened: string[] = [];
    start({}, { openExternal: (url) => opened.push(url) });
    shell.workspace.openSettings();
    await settle();
    const about = target.querySelector('.settings .about') as HTMLElement;
    expect(about.textContent).toContain('Built by Victor Zhang.');
    expect(about.textContent).toContain('which John Gruber created in 2004');
    const links = [...about.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([
      'https://victorzhang.io/',
      'https://www.linkedin.com/in/victor-yuchi-zhang/',
      'https://github.com/Victor-EU/markdown',
    ]);
    // The webview never navigates (design 6.2): the click is taken over
    // and handed to the system browser, and the page is still here.
    const source = about.querySelector('a[href*="github"]') as HTMLAnchorElement;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    source.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual(['https://github.com/Victor-EU/markdown']);
    expect(target.querySelector('.settings .about')).not.toBeNull();
  });
});

/**
 * The folder workspace, through the components (design 4.1, scenario
 * S6). What the folder contains is `crates/core`'s answer and the state
 * behind these panels is covered in `folder.browser.test.ts`; this is
 * the sidebar itself: a tree that opens files, and a search that shows
 * what it found.
 */
describe('the files panel', () => {
  const FOLDER = {
    '/w/plan.md': '# Plan\n\nthe cat sat\n',
    '/w/notes/cats.md': '# Cats\n\nthe cat again\n',
  };

  const names = (selector: string) =>
    [...target.querySelectorAll(selector)].map((el) => el.textContent?.trim() ?? '');

  async function openFolder() {
    start(FOLDER, { pickFolder: async () => '/w' });
    await shell.registry.get('file.openFolder').run();
    await settle();
  }

  it('opens a folder from the blank window and shows its tree', async () => {
    start(FOLDER, { pickFolder: async () => '/w' });
    click('.blank .start:last-child');
    await settle();
    expect(names('.tree .row-name')).toEqual(['notes', 'plan.md']);
    expect(target.querySelector('.folder-name')?.textContent).toBe('w');
  });

  it('opens a file by clicking it, and folds a folder open', async () => {
    await openFolder();
    click('.tree .row');
    await settle();
    expect(names('.tree .row-name')).toEqual(['notes', 'cats.md', 'plan.md']);
    const rows = [...target.querySelectorAll<HTMLButtonElement>('.tree .row')];
    rows[1]?.click();
    await settle();
    expect(activeLabel()).toBe('cats.md •');
  });

  it('searches the folder from the sidebar and opens a result', async () => {
    await openFolder();
    await press('KeyF', { shift: true });
    const field = target.querySelector<HTMLInputElement>('.find-in-folder input');
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    shell.workspace.search.query = 'cat again';
    await shell.workspace.search.run();
    await settle();
    expect(names('.result-file .row-name')).toEqual(['cats.md']);
    expect(target.querySelector('.result mark')?.textContent).toBe('cat again');
    click('.result');
    await settle();
    expect(activeLabel()).toBe('cats.md •');
    // Read mode has no cursor, so the tab carries where to look: the
    // words that matched, on the third line, ready for a switch to Edit.
    const found = shell.workspace.activeTab?.selection.main;
    expect([found?.from, found?.to]).toEqual([12, 21]);
  });

  it('makes a new file in the tree and names it in place', async () => {
    await openFolder();
    click('.folder-head .act');
    await settle();
    const field = target.querySelector<HTMLInputElement>('.naming');
    expect(field).not.toBeNull();
    expect(field?.value).toBe('Untitled.md');
    if (!field) return;
    field.value = 'brief.md';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(names('.tree .row-name')).toEqual(['notes', 'brief.md', 'plan.md']);
    expect(activeLabel()).toBe('brief.md •');
  });
});

describe('a second window', () => {
  it('opens on the shortcut design 4.1 gives it', async () => {
    start();
    await press('KeyN', { shift: true });
    expect(ipc.windows).toEqual(['main', 'window-2']);
    expect(status()).toBe('New window');
  });

  it('is where the palette sends the tab in front', async () => {
    start({ '/a/one.md': '# One\n' });
    await shell.workspace.openPath('/a/one.md');
    await settle();
    await press('KeyP', { shift: true });
    const row = rows().find(
      (item) => item.querySelector('.row-label')?.textContent?.trim() === 'Move Tab to New Window',
    );
    (row as HTMLButtonElement | undefined)?.click();
    await settle();
    expect(ipc.moved.map((move) => move.path)).toEqual(['/a/one.md']);
    expect(labels()).toEqual([]);
    expect(status()).toBe('Moved one.md to a new window');
  });

  it('takes a torn-off tab by the drag that tore it', async () => {
    start({ '/a/one.md': '# One\n' });
    await shell.workspace.openPath('/a/one.md');
    await settle();
    const tab = tabAt(0);
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    // Let go of it somewhere that is not the strip, which is the
    // gesture design 4.1 asks for.
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await settle();
    expect(
      ipc.calls.filter((call) => call.command === 'move_tab').map((call) => call.args[1]),
      // Dropped rather than commanded, which is what tells Rust to
      // look at where the pointer is.
    ).toEqual([true]);
    expect(labels()).toEqual([]);
  });

  it('does not tear a tab that was dropped back on the strip', async () => {
    start({ '/a/one.md': '# One\n', '/a/two.md': '# Two\n' });
    await shell.workspace.openPath('/a/one.md');
    await shell.workspace.openPath('/a/two.md');
    await settle();
    const tab = tabAt(1);
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    tabAt(0).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    await settle();
    expect(ipc.moved).toEqual([]);
    // Reordered rather than torn off. The dot is every tab's, dirty or not.
    expect(labels()).toEqual(['two.md •', 'one.md •']);
  });
});
