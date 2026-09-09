import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Banner from '../components/Banner.svelte';
import { Workspace } from './workspace.svelte.ts';

/**
 * Design 8's ceilings, and the window Read mode draws through (plan WP
 * 2.7).
 *
 * Two halves of one promise. A file up to ten megabytes opens like any
 * other; past that the app will show it but not edit it, and past a
 * hundred it says no. And the showing has to hold: what the page costs
 * is a screenful of blocks, whether the file is a page or a hundred of
 * them, without the ids, the numbers or the outline depending on where
 * the reader happened to start.
 */
let ipc: FakeIpc;
let workspace: Workspace;
let host: HTMLDivElement;
let mounted: Record<string, unknown> | null = null;

/** A file the fake reports the size of, without holding that many bytes. */
function sized(content: string, bytes: number) {
  return { content, byte_len: bytes };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

beforeEach(() => {
  ipc = createFakeIpc({});
  ipc.files.set('/w/small.md', { content: '# Small\n\nA file of the usual size.\n' });
  ipc.files.set('/w/big.md', sized('# Big\n\nA paragraph of it.\n', 42_000_000));
  ipc.files.set('/w/huge.md', sized('# Huge\n', 120_000_000));
  ipc.files.set('/w/latin.md', {
    content: 'caf\n',
    format: { encoding: 'windows-1252' },
  });
  workspace = new Workspace({ commands: ipc.commands });
  host = document.createElement('div');
  host.style.cssText = 'width: 460px; height: 320px; overflow: auto; position: relative;';
  document.body.appendChild(host);
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  workspace.destroy();
  host.remove();
});

describe('a file the app will not edit', () => {
  it('opens a file over ten megabytes for reading, and says why', async () => {
    expect(await workspace.openPath('/w/big.md')).toBe(true);
    expect(workspace.activeDoc?.meta?.read_only).toBe('size');
    expect(workspace.activeTab?.mode).toBe('read');
    expect(workspace.status).toContain('42 MB');
    expect(workspace.status).toContain('10 MB');
    // It is a whole document, and reading it is the point of opening it.
    expect(workspace.activeDoc?.text).toContain('A paragraph of it.');
  });

  it('keeps a very large document out of an editor', async () => {
    await workspace.openPath('/w/big.md');
    workspace.setMode('edit');
    expect(workspace.activeTab?.mode).toBe('read');
    expect(workspace.status).toContain('reading only');
    workspace.setMode('source');
    expect(workspace.activeTab?.mode).toBe('read');
    // A click in the page is the other way into Edit (design 4.2), and
    // it stays where it is too.
    workspace.mountRead(host);
    workspace.editAt(4);
    expect(workspace.activeTab?.mode).toBe('read');
    // The find bar draws its matches with an editor extension, so there
    // is none to open; it says so rather than reporting no matches in a
    // document full of them.
    workspace.openFind(false);
    expect(workspace.find.open).toBe(false);
  });

  /** And the same document under the limit does all of it. */
  it('leaves a file under the limit alone', async () => {
    await workspace.openPath('/w/small.md');
    workspace.setMode('edit');
    expect(workspace.activeTab?.mode).toBe('edit');
    expect(workspace.canSave).toBe(true);
  });

  it('refuses a file over a hundred megabytes, and opens nothing', async () => {
    expect(await workspace.openPath('/w/huge.md')).toBe(false);
    expect(workspace.tabs).toHaveLength(0);
    expect(workspace.status).toContain('120 MB');
    expect(workspace.status).toContain('100 MB');
  });

  /**
   * Nothing in the app can change it, so there is never a second version
   * to compare the first with -- and a snapshot would send the whole of a
   * very large document over the IPC and into the store on every open.
   */
  it('takes no history of a document nothing can change', async () => {
    await workspace.openPath('/w/small.md');
    await workspace.openPath('/w/big.md');
    await settled();
    const snapshots = ipc.calls
      .filter((call) => call.command === 'snapshot')
      .map((call) => call.args[0]);
    expect(snapshots).toContain('/w/small.md');
    expect(snapshots).not.toContain('/w/big.md');
  });

  it('says so over the page, and offers the way out where there is one', async () => {
    mounted = mount(Banner, { target: host, props: { workspace } });
    // Nothing open, nothing to say.
    expect(host.textContent).toBe('');

    await workspace.openPath('/w/big.md');
    await settled();
    expect(host.textContent).toContain('42 MB');
    // There is nothing to be done about a file's size, so nothing is
    // offered; the encoding is the one with a way out.
    expect(host.querySelector('button')).toBeNull();

    await workspace.openPath('/w/latin.md');
    await settled();
    expect(host.textContent).toContain('WINDOWS-1252');
    const convert = host.querySelector('button') as HTMLButtonElement;
    expect(convert.textContent).toContain('Convert to UTF-8');
    convert.click();
    await settled();
    expect(workspace.activeDoc?.meta?.read_only).toBeNull();
    expect(workspace.status).toContain('Converted');
  });
});

/**
 * A document long enough that only part of it can be on screen, with the
 * things that must not depend on which part.
 */
const LONG = [
  '# Report[^why]',
  '',
  ...Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\n${'word '.repeat(80)}`),
  '## Notes',
  '',
  'The first one.',
  '',
  ...Array.from({ length: 200 }, (_, i) => `## Later ${i}\n\n${'word '.repeat(80)}`),
  '## Notes',
  '',
  'The second one, mentioning the note again[^why] and one of its own[^also].',
  '',
  '[^why]: Because the file says so.',
  '',
  '[^also]: A second note.',
  '',
].join('\n');

describe('the window onto a document', () => {
  beforeEach(() => {
    ipc.files.set('/w/long.md', { content: LONG });
  });

  /** Walked to the end -- the outline needs that -- and built as it is read. */
  async function open(): Promise<void> {
    await workspace.openPath('/w/long.md');
    workspace.mountRead(host);
    const deadline = Date.now() + 10_000;
    while (!workspace.outlineComplete && Date.now() < deadline) await settled();
    expect(workspace.outlineComplete).toBe(true);
  }

  const page = () => host.querySelector('.read') as HTMLElement;

  it('names every heading without building one of them', async () => {
    await open();
    expect(workspace.outline).toHaveLength(403);
    expect(page().children.length).toBeLessThan(60);
  });

  /**
   * The reader jumps to the second "Notes" before the first has ever
   * been in the page. Which of the two is `#notes` is decided by the
   * document, so it cannot be decided by the order they are drawn in.
   */
  it('gives two headings of one name the ids the document decides', async () => {
    await open();
    const entries = workspace.outline.filter((entry) => entry.text === 'Notes');
    expect(entries.map((entry) => entry.id)).toEqual(['notes', 'notes-1']);
    workspace.goToHeading(entries[1] as (typeof entries)[number]);
    await frame();
    expect(page().querySelector('#notes-1')).not.toBeNull();
    expect(page().querySelector('#notes')).toBeNull();

    workspace.goToHeading(entries[0] as (typeof entries)[number]);
    await frame();
    expect(page().querySelector('#notes')?.textContent).toContain('Notes');
  });

  it('numbers a footnote by the document, not by what was drawn first', async () => {
    await open();
    // The bottom first: the paragraph there refers to both notes, and
    // the one it mentions second was mentioned first at the top.
    const last = workspace.outline.at(-1);
    workspace.goToHeading(last as NonNullable<typeof last>);
    await frame();
    const refs = [...page().querySelectorAll('a.mdr-fnref')].map((a) => a.textContent);
    expect(refs).toEqual(['1', '2']);

    workspace.readView?.scrollToOffset(0);
    await frame();
    expect(page().querySelector('a.mdr-fnref')?.textContent).toBe('1');
  });

  /** A link to a heading the page has not built yet still leads there. */
  it('follows an anchor into a part of the document it has not drawn', async () => {
    await open();
    expect(workspace.readView?.scrollToId('later-150')).toBe(true);
    await frame();
    expect(page().querySelector('#later-150')).not.toBeNull();
    expect(host.scrollTop).toBeGreaterThan(0);
    // And a footnote, whose id no heading knows about.
    expect(workspace.readView?.scrollToId('fn-1')).toBe(true);
    await frame();
    expect(page().querySelector('#fn-1')?.textContent).toContain('Because the file says so');
  });

  /**
   * A comment is in the page and hidden (design 4.3), so it has no box
   * at all: it is worth nothing, and nothing can be measured from it.
   * Measuring the block above one against it put a document of a few
   * hundred kilobytes on a scrollbar of thirty-three million pixels.
   */
  it('measures a page whose comments are folded away', async () => {
    const commented = Array.from(
      { length: 200 },
      (_, i) => `## Part ${i}\n\n<!-- note: nobody sees this -->\n\n${'word '.repeat(60)}`,
    ).join('\n\n');
    ipc.files.set('/w/notes.md', { content: commented });
    await workspace.openPath('/w/notes.md');
    workspace.mountRead(host);
    const deadline = Date.now() + 10_000;
    while (!workspace.outlineComplete && Date.now() < deadline) await settled();
    const walked = host.scrollHeight;
    expect(walked).toBeGreaterThan(host.clientHeight);

    // Down the whole document, which is where every estimate is replaced
    // by what the block actually measured.
    for (let i = 0; i < 200 && host.scrollTop + host.clientHeight < host.scrollHeight - 1; i++) {
      host.scrollTop += host.clientHeight;
      await frame();
    }
    // The measurements may correct the guesses, but they cannot invent a
    // document ten times the size of the one that was walked.
    expect(host.scrollHeight).toBeLessThan(walked * 2);
    expect(host.querySelector('.mdr-comment')).not.toBeNull();
  });

  /**
   * The sidebar opening narrows the page under the reader, which changes
   * the height of every block in the document at once.
   */
  it('keeps the reader in place when the page narrows under them', async () => {
    await open();
    workspace.readView?.scrollToId('section-100');
    await frame();
    const heading = page().querySelector('#section-100') as HTMLElement;
    const before = heading.getBoundingClientRect().top;
    const height = host.scrollHeight;

    host.style.width = '300px';
    for (let i = 0; i < 8; i++) await frame();
    // The same block, still on screen and about where it was, in a
    // document that is taller than it was because the lines are shorter.
    // About, and not exactly: what is above it are guesses at what those
    // blocks would measure, and the guesses change with the measure.
    expect(page().querySelector('#section-100')).toBe(heading);
    expect(Math.abs(heading.getBoundingClientRect().top - before)).toBeLessThan(120);
    expect(host.scrollHeight).toBeGreaterThan(height);
    expect(host.scrollHeight).toBeLessThan(height * 4);
  });

  /**
   * The scrollbar is the promise that the rest of the document is there.
   * It is built out of estimates until each block has been on screen, so
   * what it must not do is move the reader while they are standing still.
   */
  it('keeps the reader in place as the estimates are replaced', async () => {
    await open();
    workspace.readView?.scrollToId('section-100');
    await frame();
    const heading = page().querySelector('#section-100') as HTMLElement;
    const before = heading.getBoundingClientRect().top;
    for (let i = 0; i < 5; i++) await frame();
    expect(page().querySelector('#section-100')).toBe(heading);
    expect(Math.abs(heading.getBoundingClientRect().top - before)).toBeLessThan(4);
  });
});
