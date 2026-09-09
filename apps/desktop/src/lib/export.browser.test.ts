import { createFakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Reading } from './appearance.ts';
import { describeExport, exportPage } from './export.ts';
import { createEnhancer } from './read/enhance.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * A document as a page of its own (plan WP 3.2): what comes out, what
 * the reader's settings do to it, and what it leaves behind.
 */

/** Eight bytes that sniff as a PNG, which is all any of this asks of them. */
const PNG = '\x89PNG\r\n\x1a\n';

const SAMPLE = `# A brief

A paragraph with a ==highlight==<!-- rewrite: too strong --> in it.

- [x] done
- [ ] not done

\`\`\`js
const answer = 42;
\`\`\`

$$
x^2
$$

![local](pictures/a.png)

![again](pictures/a.png)

![remote](https://example.test/a.png)
`;

function options(over: Partial<Parameters<typeof exportPage>[0]> = {}) {
  return {
    source: SAMPLE,
    title: 'brief.md',
    images: { path: '/notes/brief.md', remote: false },
    comments: false,
    reading: DEFAULT_SETTINGS as Reading,
    appearance: 'light' as const,
    ...over,
  };
}

/** The page as a document, which is how every question here is asked. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('an exported page', () => {
  it('is a whole document, with the read stylesheet inside it', async () => {
    const { html } = await exportPage(options());

    expect(html.startsWith('<!doctype html>')).toBe(true);
    const page = parse(html);
    expect(page.title).toBe('brief.md');
    expect(page.querySelector('meta[charset]')).not.toBeNull();
    expect(page.querySelector('article')?.className).toBe('read');
    expect(page.querySelector('h1')?.textContent).toBe('A brief');
    const style = page.querySelector('style')?.textContent ?? '';
    // The stylesheet Read mode wears, not a second copy of it.
    expect(style).toContain('.read blockquote');
    expect(style).toContain('--family-mono:');
    // And the theme, with the choice already made rather than left to
    // an attribute a script would have to write.
    expect(style).toContain(':root {');
    expect(style).not.toContain('[data-theme=');
    // Read mode leaves half a screen under the last line; a page that
    // ends does not. Which of the two wins is decided by their order.
    expect(style.indexOf('padding-bottom: 64px')).toBeGreaterThan(
      style.indexOf('padding: 32px 24px 50vh'),
    );
  });

  it('carries nothing the window kept for itself', async () => {
    const { html } = await exportPage(options());

    expect(html).not.toContain('data-from=');
    expect(html).not.toContain('data-to=');
    const page = parse(html);
    // The stylesheet still dresses a fence's copy button; the page has none.
    expect(page.querySelector('.mdr-copy')).toBeNull();
    expect(page.querySelector('.mdr-fold')).toBeNull();
    // A task box with no document behind it cannot be ticked.
    const box = page.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
  });

  it('is dressed in the settings the reader is reading in', async () => {
    const { html } = await exportPage(
      options({
        reading: { ...DEFAULT_SETTINGS, paper: 'black', family: 'serif', size: 20, measure: 90 },
        appearance: 'light',
      }),
    );

    const style = parse(html).querySelector('style')?.textContent ?? '';
    expect(style).toContain('--read-family: var(--family-serif);');
    expect(style).toContain('--read-size: 20px;');
    expect(style).toContain('--read-measure: 90ch;');
    // The high-contrast paper is a dark page in a light window: the
    // window stays light, the paper is the light palette's black, and
    // the code on it is coloured for a dark ground.
    expect(style).toContain('color-scheme: light;');
    expect(style).toContain('--page-bg: #121212;');
    expect(style).toContain('--tok-keyword: #d98cc9;');
  });

  it('shows the comments when the reader has them shown', async () => {
    const folded = await exportPage(options());
    expect(parse(folded.html).querySelector('article')?.className).toBe('read');

    const shown = await exportPage(options({ comments: true }));
    const page = parse(shown.html);
    expect(page.querySelector('article')?.className).toBe('read mdr-show-comments');
    expect(page.querySelector('.mdr-comment[data-kind="rewrite"]')?.textContent).toContain(
      'too strong',
    );
  });

  it('names each local image once and leaves the answer to Rust', async () => {
    const { html, images } = await exportPage(options());

    expect(images).toEqual(['/notes/pictures/a.png']);
    const page = parse(html);
    const srcs = [...page.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    // The same file twice is one image, named twice.
    expect(srcs).toEqual(['mdr-export-image-0', 'mdr-export-image-0']);
    // Blocked, as it is in the window, and it says which case it is.
    expect(page.querySelector('.mdr-image[data-blocked="remote"]')).not.toBeNull();
  });

  it('keeps a remote image the reader has allowed', async () => {
    const { html, images } = await exportPage(
      options({ images: { path: '/notes/brief.md', remote: true } }),
    );

    expect(images).toEqual(['/notes/pictures/a.png']);
    const srcs = [...parse(html).querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(srcs).toContain('https://example.test/a.png');
  });

  it('leaves nothing of itself in the window', async () => {
    const before = document.body.childElementCount;
    await exportPage(options());
    expect(document.body.childElementCount).toBe(before);
  });
});

describe('an exported page, enhanced', () => {
  it('colours its fences and sets its formulas without a stylesheet to lean on', async () => {
    const enhancer = createEnhancer();
    const { html } = await exportPage(options({ enhancer }));
    enhancer.destroy();
    const page = parse(html);

    // Shiki names the tokens; the theme's variables colour them, and
    // those are in the page.
    const fence = page.querySelector('pre.mdr-code') as HTMLElement;
    expect(fence.querySelector('code .tok-keyword')?.textContent).toBe('const');
    expect(fence.querySelector('.mdr-code-lang')?.textContent).toBe('js');
    expect(fence.textContent).toContain('const answer = 42;');

    // MathML, because KaTeX's HTML output needs its own stylesheet and
    // its own fonts, and a page that stands on its own has neither.
    const math = page.querySelector('.mdr-math-block') as HTMLElement;
    expect(math.querySelector('math')).not.toBeNull();
    expect(math.querySelector('.katex-html')).toBeNull();
    expect(math.textContent).toContain('x');
  });

  /**
   * The one thing about building the document off-screen that could have
   * gone wrong: Mermaid measures text to lay a diagram out, and a
   * detached fragment has nothing to measure.
   */
  it('draws its diagrams, which needed the document to be in a page at all', async () => {
    const enhancer = createEnhancer();
    const { html } = await exportPage(
      options({ enhancer, source: '```mermaid\ngraph LR\n  A[Read] --> B[Edit]\n```\n' }),
    );
    enhancer.destroy();

    const diagram = parse(html).querySelector('.mdr-mermaid') as HTMLElement;
    expect(diagram.classList.contains('mdr-mermaid-done')).toBe(true);
    const svg = diagram.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('viewBox')).not.toBeNull();
    expect(svg.textContent).toContain('Read');
    // Loading Mermaid is most of this, and under a full run it is more
    // than the default budget -- as it is next door in `enhance`.
  }, 60_000);
});

describe('what the status bar says about an export', () => {
  const write = {
    path: '/notes/brief.html',
    embedded: true,
    images: 0,
    missing: 0,
    folder: null,
  };

  it('says where the images went, because the reader is about to move the file', () => {
    expect(describeExport(write, 'brief.html')).toBe('Exported brief.html');
    expect(describeExport({ ...write, images: 3 }, 'brief.html')).toBe(
      'Exported brief.html · 3 images inside it',
    );
    expect(
      describeExport(
        { ...write, embedded: false, images: 1, folder: '/notes/brief-images' },
        'brief.html',
      ),
    ).toBe('Exported brief.html · 1 image in brief-images');
    expect(describeExport({ ...write, images: 2, missing: 2 }, 'brief.html')).toBe(
      'Exported brief.html · 2 images could not be read',
    );
  });
});

describe('exporting from the window', () => {
  let workspace: Workspace;
  let asked: string[];

  afterEach(() => {
    workspace.destroy();
  });

  beforeEach(() => {
    asked = [];
  });

  function start(files: Record<string, string>, target: string | null) {
    const ipc = createFakeIpc(files);
    workspace = new Workspace({
      commands: ipc.commands,
      assetUrl: (path) => `asset://localhost/${path}`,
      pickExportTarget: (suggested) => {
        asked.push(suggested);
        return Promise.resolve(target);
      },
    });
    return ipc;
  }

  it('offers the page beside the document, under the document’s name', async () => {
    const ipc = start(
      { '/notes/brief.md': SAMPLE, '/notes/pictures/a.png': PNG },
      '/notes/brief.html',
    );
    await workspace.openPath('/notes/brief.md');
    await workspace.exportHtml();

    expect(asked).toEqual(['/notes/brief.html']);
    expect(workspace.status).toBe('Exported brief.html · 1 image inside it');
    const page = ipc.files.get('/notes/brief.html')?.content ?? '';
    expect(page).toContain('<article class="read">');
    expect(page).toContain('A brief');
    // The sentinels are gone, and what stands in their place is the file.
    expect(page).not.toContain('mdr-export-image-');
    expect(page).toContain('src="data:image/png;base64,');
  });

  it('writes nothing when the reader changes their mind', async () => {
    const ipc = start({ '/notes/brief.md': SAMPLE }, null);
    await workspace.openPath('/notes/brief.md');
    await workspace.exportHtml();

    expect(ipc.calls.some((call) => call.command === 'export_html')).toBe(false);
  });

  it('says which images it could not read', async () => {
    start({ '/notes/brief.md': SAMPLE }, '/notes/brief.html');
    await workspace.openPath('/notes/brief.md');
    await workspace.exportHtml();

    expect(workspace.status).toBe('Exported brief.html · 1 image could not be read');
  });
});
