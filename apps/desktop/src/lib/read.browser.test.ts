import { createFakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace.svelte.ts';

/**
 * Read mode as the workspace drives it: what is mounted, what the outline
 * says, what folding hides, and where a click puts the cursor.
 */
const SAMPLE = `# Title

<!-- note: folded away in Read mode -->

An opening paragraph with a [link](https://example.test/page) in it.

## Section one

Some words in the first section.

- one item
- another item

## Section two

The second section has its own paragraph of words.

\`\`\`js
const answer = 42;
\`\`\`
`;

let host: HTMLDivElement;
let workspace: Workspace;
let opened: string[] = [];
let copied: string[] = [];
let calls: { command: string; args: unknown[] }[] = [];

function start(files: Record<string, string>) {
  const ipc = createFakeIpc(files);
  opened = [];
  copied = [];
  calls = ipc.calls;
  workspace = new Workspace({
    commands: ipc.commands,
    openExternal: (url) => opened.push(url),
    assetUrl: (path) => `asset://localhost/${path}`,
    clipboard: {
      writeText: async (text) => {
        copied.push(text);
      },
    },
  });
}

/** What ReadPane's effect does, by hand. */
function mountRead() {
  workspace.mountRead(host);
}

const read = () => host.querySelector('.read') as HTMLElement;
const shown = (el: Element) =>
  !(el as HTMLElement).hidden && !el.classList.contains('mdr-folded-away');
const blocks = () => [...read().children].filter(shown).map((el) => el.tagName.toLowerCase());

beforeEach(() => {
  host = document.createElement('div');
  host.style.cssText = 'width: 420px; height: 300px; overflow: auto; position: relative;';
  document.body.appendChild(host);
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

/** A document that exercises the constructs WP 1.5 added. */
const DIALECT = `# Dialect

A claim with a note[^why] and a <mark>marked</mark> phrase.

> [!TLDR] The short of it
> An alias of abstract.

> [!example]- Folded
> Hidden until opened.

![local](pictures/a.png)

![remote](https://example.test/a.png)

[^why]: Because the file says so.
`;

describe('the rest of the dialect in Read mode', () => {
  it('renders footnotes, callout types, folding, and the HTML whitelist', async () => {
    start({ '/d.md': DIALECT });
    await workspace.openPath('/d.md');
    mountRead();
    const page = read();

    const ref = page.querySelector('.mdr-fnref') as HTMLAnchorElement;
    expect(ref.textContent).toBe('1');
    expect(ref.getAttribute('href')).toBe('#fn-1');
    expect(page.querySelector('#fn-1')?.textContent).toContain('Because the file says so.');

    expect(page.querySelector('mark')?.textContent).toBe('marked');

    // `tldr` is an alias; the page carries the canonical type.
    const callout = page.querySelector('blockquote.mdr-callout') as HTMLElement;
    expect(callout.dataset.callout).toBe('abstract');
    expect(callout.querySelector('.mdr-callout-title')?.textContent).toBe('The short of it');

    const folded = page.querySelector('details.mdr-callout') as HTMLDetailsElement;
    expect(folded.dataset.callout).toBe('example');
    expect(folded.open).toBe(false);
  });

  it('loads a local image through the asset protocol and blocks a remote one', async () => {
    start({ '/notes/d.md': DIALECT });
    await workspace.openPath('/notes/d.md');
    mountRead();
    expect(calls.map((call) => call.command)).toContain('allow_document_images');

    const local = read().querySelector('img') as HTMLImageElement;
    expect(local.getAttribute('src')).toBe('asset://localhost//notes/pictures/a.png');
    const blocked = read().querySelector('.mdr-image[data-blocked]') as HTMLElement;
    expect(blocked.dataset.blocked).toBe('remote');
    expect(blocked.textContent).toBe('remote');
  });

  it('loads remote images once the reader allows this document', async () => {
    start({ '/notes/d.md': DIALECT });
    await workspace.openPath('/notes/d.md');
    mountRead();
    workspace.toggleRemoteImages();
    mountRead();
    const sources = [...read().querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toContain('https://example.test/a.png');
    expect(workspace.status).toContain('Loading remote images');

    workspace.toggleRemoteImages();
    mountRead();
    expect(read().querySelector('.mdr-image[data-blocked="remote"]')).not.toBeNull();
  });
});

describe('read mode', () => {
  it('renders the document and reports its outline', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    expect(workspace.activeTab?.mode).toBe('read');
    mountRead();

    expect(read().querySelector('h1')?.textContent).toContain('Title');
    expect(read().querySelector('a')?.getAttribute('href')).toBe('https://example.test/page');
    expect(workspace.outline.map((entry) => entry.text)).toEqual([
      'Title',
      'Section one',
      'Section two',
    ]);
    expect(workspace.outlineComplete).toBe(true);
  });

  it('folds a section, and the tab remembers it', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    mountRead();
    const before = blocks();
    expect(before).toContain('ul');

    const fold = read().querySelector('button[data-fold="section-one"]') as HTMLButtonElement;
    fold.click();
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    // The heading stays; its section is hidden down to the next heading.
    expect(blocks()).toEqual(['h1', 'p', 'h2', 'h2', 'p', 'pre']);
    expect(workspace.activeTab?.folded).toEqual(['section-one']);
    // Folding must not bring back what the renderer hid: the comment stays
    // out of the page (design 4.3).
    expect((read().querySelector('.mdr-comment') as HTMLElement).hidden).toBe(true);

    workspace.unmountRead();
    mountRead();
    expect(blocks()).toEqual(['h1', 'p', 'h2', 'h2', 'p', 'pre']);
  });

  it('switches to Edit at the word that was clicked', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    mountRead();
    const paragraph = read().querySelector('p') as HTMLElement;
    const node = paragraph.firstChild as Text;
    const at = (node.nodeValue ?? '').indexOf('opening');
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + 7);
    const rect = range.getBoundingClientRect();
    paragraph.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
    );

    expect(workspace.activeTab?.mode).toBe('edit');
    const head = workspace.activeTab?.selection.main.head ?? -1;
    expect(SAMPLE.slice(head - 7, head + 7)).toContain('opening');
  });

  /**
   * Design 11: a fence says what language it is in and offers to copy
   * itself. Both go inside the `pre` and out of flow, so the block's
   * text is still exactly the code — which is what a selection across
   * the page picks up, and what the button copies.
   */
  it('gives a fence its language and a button that copies it', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    mountRead();
    const pre = read().querySelector('pre.mdr-code') as HTMLElement;
    expect(pre.querySelector('.mdr-code-lang')?.textContent).toBe('js');
    expect(pre.querySelector('code')?.textContent).toBe('const answer = 42;');

    const button = pre.querySelector('button.mdr-copy') as HTMLButtonElement;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copied).toEqual(['const answer = 42;']);
    // The button says so itself rather than borrowing the status line.
    expect(button.textContent).toBe('Copied');
    expect(workspace.status).not.toContain('clipboard');
  });

  it('opens an external link in the system browser instead of navigating', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    mountRead();
    (read().querySelector('a') as HTMLElement).click();
    expect(opened).toEqual(['https://example.test/page']);
    expect(workspace.activeTab?.mode).toBe('read');
  });

  it('keeps the reader in the same place across a mode switch', async () => {
    // Long enough that the second section is a real scroll away.
    start({ '/a.md': `${SAMPLE}\n${'Filler paragraph.\n\n'.repeat(60)}` });
    await workspace.openPath('/a.md');
    mountRead();
    const second = read().querySelector('#section-two') as HTMLElement;
    host.scrollTop = second.offsetTop;
    workspace.setMode('edit');
    // The switch hands the editor a source offset, not a pixel position.
    expect(SAMPLE.slice(workspace.activeTab?.anchor?.offset ?? 0)).toMatch(/^## Section two/);
  });

  it('scrolls to a heading chosen in the outline', async () => {
    start({ '/a.md': SAMPLE });
    await workspace.openPath('/a.md');
    mountRead();
    const entry = workspace.outline.find((heading) => heading.id === 'section-two');
    workspace.goToHeading(entry as (typeof workspace.outline)[number]);
    expect(host.scrollTop).toBeGreaterThan(0);
  });

  it('renders a long document in chunks and finishes in the background', async () => {
    const long = Array.from(
      { length: 400 },
      (_, i) => `## Heading ${i}\n\n${'word '.repeat(60)}`,
    ).join('\n\n');
    start({ '/long.md': long });
    await workspace.openPath('/long.md');
    mountRead();
    const first = read().children.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(800);
    expect(workspace.outlineComplete).toBe(false);

    const deadline = Date.now() + 5000;
    while (!workspace.outlineComplete && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(workspace.outlineComplete).toBe(true);
    expect(read().children.length).toBe(800);
    expect(workspace.outline.length).toBe(400);
  });
});
