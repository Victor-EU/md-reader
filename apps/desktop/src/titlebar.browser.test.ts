import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App.svelte';
// The real stylesheet: the strip's geometry is most of what is under test.
import './app.css';
import { createShell, type Shell } from './lib/shell.svelte.ts';
import type { WorkspaceOptions } from './lib/workspace.svelte.ts';

let target: HTMLDivElement;
let app: Record<string, unknown>;
let shell: Shell;
let ipc: FakeIpc;
let named: string[] = [];

/** The shell in a window of a known width, so the strip has to make choices. */
function start(files: Record<string, string> = {}, extra: Partial<WorkspaceOptions> = {}) {
  ipc = createFakeIpc(files);
  shell = createShell({
    commands: ipc.commands,
    mac: true,
    setTitle: (title) => named.push(title),
    ...extra,
  });
  app = mount(App, { target, props: { shell } });
}

async function settle() {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function one<T extends Element>(selector: string): T {
  const found = target.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

const strip = () => one<HTMLElement>('.titlebar');
const scroller = () => one<HTMLElement>('.tabs');
const widths = () =>
  [...target.querySelectorAll('.tab')].map((tab) => tab.getBoundingClientRect().width);
const leftGap = () => Number.parseFloat(getComputedStyle(strip()).paddingLeft);
const paint = (selector: string) => getComputedStyle(one(selector)).backgroundColor;

/** A file whose name is longer than a tab is wide, so tabs have to give. */
const wide = (n: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`/w/chapter-${i}-a-name-of-some-length.md`, `# ${i}\n`]),
  );

beforeEach(() => {
  target = document.createElement('div');
  target.style.width = '520px';
  document.body.appendChild(target);
  named = [];
});

afterEach(async () => {
  await unmount(app, { outro: false });
  shell.workspace.destroy();
  target.remove();
  const root = document.documentElement;
  root.removeAttribute('data-appearance');
  root.removeAttribute('data-paper');
  for (const name of ['--read-family', '--read-size', '--read-measure']) {
    root.style.removeProperty(name);
  }
});

/**
 * The strip is the window's title bar on macOS (plan WP 2.8), which is
 * two obligations: keep clear the corner the system draws its own three
 * buttons in, and let the window be picked up by everything that is not
 * a tab.
 */
describe('the title bar', () => {
  it('keeps the corner the window buttons are drawn in', async () => {
    start();
    shell.workspace.titleBar = true;
    await settle();
    // The third button ends 60 points from the window's left edge, so
    // anything short of that would have a tab under it.
    expect(leftGap()).toBeGreaterThan(60);
    const first = one('.tabs').getBoundingClientRect().left;
    expect(first - strip().getBoundingClientRect().left).toBeCloseTo(leftGap(), 0);
  });

  it('keeps none of it where the window has a title bar of its own', async () => {
    start();
    await settle();
    expect(shell.workspace.titleBar).toBe(false);
    expect(leftGap()).toBe(0);
  });

  /**
   * Full screen is macOS drawing the buttons over the top of the screen
   * itself. They are not in the strip for the duration, so the room kept
   * for them goes back to the tabs.
   */
  it('gives the corner back in full screen', async () => {
    start();
    shell.workspace.titleBar = true;
    await settle();
    const kept = leftGap();
    shell.workspace.fullScreen = true;
    await settle();
    expect(leftGap()).toBe(0);
    expect(kept).toBeGreaterThan(0);
  });

  /**
   * `data-tauri-drag-region` is the whole of the drag and the
   * double-click zoom: Tauri reads it, so what this checks is which
   * elements carry it. Bare rather than `deep`, so a press on a tab is
   * the tab's.
   */
  it('is somewhere to pick the window up by, except where a tab is', async () => {
    start({ '/w/one.md': '# one\n' });
    await shell.workspace.openPaths(['/w/one.md']);
    await settle();
    expect(strip().hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(one('.rest').hasAttribute('data-tauri-drag-region')).toBe(true);
    for (const selector of ['.tabs', '.tab', '.tab .label', '.tab .close', '.new-tab']) {
      expect(one(selector).hasAttribute('data-tauri-drag-region'), selector).toBe(false);
    }
  });

  it('opens a tab from the strip itself', async () => {
    start();
    await settle();
    one<HTMLButtonElement>('.new-tab').click();
    await settle();
    expect(shell.workspace.tabs).toHaveLength(1);
    expect(one('.tab.active .label').textContent).toContain('Untitled');
  });

  /**
   * The tab in front and the bar under it are one surface, which is what
   * makes the tab read as the front of the page rather than a button on
   * the strip. The strip behind them is the chrome's own colour.
   */
  it('draws the tab in front and the bar below it as one surface', async () => {
    start({ '/w/one.md': '# one\n' });
    await shell.workspace.openPaths(['/w/one.md']);
    await settle();
    expect(paint('.tab.active')).toBe(paint('.bar.toolbar'));
    expect(paint('.titlebar')).not.toBe(paint('.bar.toolbar'));
  });

  /**
   * A tab gives way before the strip does (design 4.1): they shrink to a
   * floor that still holds a few letters and the close button, and only
   * past that does the strip start scrolling.
   */
  it('shrinks tabs before it scrolls', async () => {
    const files = wide(9);
    const paths = Object.keys(files);
    start(files);
    await shell.workspace.openPaths(paths.slice(0, 3));
    await settle();
    const roomy = widths();
    expect(roomy).toHaveLength(3);
    for (const width of roomy) {
      expect(width).toBeLessThan(220);
      expect(width).toBeGreaterThan(96);
    }
    expect(scroller().scrollWidth).toBeLessThanOrEqual(scroller().clientWidth + 1);

    await shell.workspace.openPaths(paths.slice(3));
    await settle();
    const tight = widths();
    expect(tight).toHaveLength(9);
    for (const width of tight) expect(width).toBeLessThan(roomy[0] as number);
    expect(scroller().scrollWidth).toBeGreaterThan(scroller().clientWidth);
  });

  /**
   * A tab does not have to move to end up out of sight: the strip
   * getting narrower under it will do, once the tabs are at their floor
   * and it has started scrolling.
   */
  it('brings the tab in front back into view when the strip narrows', async () => {
    const files = wide(9);
    start(files);
    await shell.workspace.openPaths(Object.keys(files));
    await settle();
    const active = one<HTMLElement>('.tab.active');
    expect(active.getBoundingClientRect().right).toBeLessThanOrEqual(
      scroller().getBoundingClientRect().right + 1,
    );
    target.style.width = '360px';
    // A frame for the observer to see the new width, and one for the
    // scroll it asks for.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await settle();
    const box = one<HTMLElement>('.tab.active').getBoundingClientRect();
    const strip = scroller().getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(strip.right + 1);
    expect(box.left).toBeGreaterThanOrEqual(strip.left - 1);
  });

  /**
   * Nothing draws the window's name now, but macOS still lists windows
   * by it. A window with two documents open should not answer to the
   * same thing in the Window menu as the one beside it.
   */
  it('names the window after the tab in front', async () => {
    start({ '/w/one.md': '# one\n', '/w/two.md': '# two\n' });
    await settle();
    expect(named.at(-1)).toBe('Markdown');
    await shell.workspace.openPaths(['/w/one.md', '/w/two.md']);
    await settle();
    expect(named.at(-1)).toBe('two.md');
    shell.workspace.activate(shell.workspace.tabs[0]?.id ?? '');
    await settle();
    expect(named.at(-1)).toBe('one.md');
  });
});
