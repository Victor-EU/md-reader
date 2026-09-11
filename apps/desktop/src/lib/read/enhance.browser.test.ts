import { parser, renderDocument, resolveOffset, toDom } from '@markdown/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnhancer, type Enhancer } from './enhance.ts';
// The stylesheet is part of the feature: Shiki emits both themes as custom
// properties and the page is what turns them into colour.
import '../../app.css';

/**
 * The three renderers Read mode hands work to, against the real libraries:
 * Shiki, KaTeX and Mermaid. They are loaded on demand, so this is also the
 * test that the dynamic imports resolve in a browser build.
 */
const DOC = `\`\`\`js
const answer = compute(everything);
\`\`\`

Inline $E = mc^2$ and a block:

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$

\`\`\`mermaid
graph LR
  A[Read] --> B[Edit]
\`\`\`

\`\`\`not-a-language
plain text stays plain
\`\`\`
`;

let host: HTMLElement;
let enhancer: Enhancer;
let offsets: WeakMap<Text, number>;

/** Wait for an asynchronous renderer to land, or give up and let the test say so. */
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'read';
  host.style.cssText = 'width: 600px;';
  document.body.appendChild(host);
  const mounted = toDom(renderDocument(parser.parse(DOC), DOC));
  offsets = mounted.offsets;
  host.appendChild(mounted.fragment);
  enhancer = createEnhancer();
});

afterEach(() => {
  enhancer.destroy();
  host.remove();
});

describe('enhancers', () => {
  it('highlights a fence without changing a character of the code', async () => {
    const code = host.querySelector('pre[data-lang="js"] code') as HTMLElement;
    const before = code.textContent ?? '';
    const from = Number(code.getAttribute('data-from'));
    enhancer.run([host]);
    await until(() => code.querySelector('span') !== null);

    const token = code.querySelector('span.tok-keyword') as HTMLElement;
    expect(token).not.toBeNull();
    expect(code.textContent).toBe(before);
    // A token is named rather than coloured (plan WP 2.6), and the name
    // is what the stylesheet paints: no inline colour anywhere in the
    // fence, or a change of theme would leave the old one behind.
    expect(token.getAttribute('style')).toBeNull();
    expect(getComputedStyle(token).color).not.toBe(getComputedStyle(code).color);
    // Click-to-edit still lands on the character under the pointer, because
    // the highlighted subtree still holds the source verbatim.
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode() as Text;
    expect(resolveOffset(first, 2, offsets)).toBe(from + 2);
  });

  it('leaves a fence whose language is not one alone', async () => {
    const code = host.querySelector('pre[data-lang="not-a-language"] code') as HTMLElement;
    enhancer.run([host]);
    await until(() => host.querySelector('pre[data-lang="js"] code span') !== null);
    expect(code.querySelector('span')).toBeNull();
    expect(code.textContent).toBe('plain text stays plain');
  });

  it('renders inline and block math with KaTeX', async () => {
    const inline = host.querySelector('.mdr-math') as HTMLElement;
    const block = host.querySelector('.mdr-math-block') as HTMLElement;
    enhancer.run([host]);
    await until(
      () => inline.querySelector('.katex') !== null && block.querySelector('.katex') !== null,
    );

    expect(inline.querySelector('.katex')).not.toBeNull();
    expect(block.querySelector('.katex-display')).not.toBeNull();
    // The source is still on the element, so Edit mode can go back to it.
    expect(inline.dataset.tex).toBe('E = mc^2');
  });

  it('renders a mermaid fence into a diagram', async () => {
    const diagram = host.querySelector('.mdr-mermaid') as HTMLElement;
    enhancer.run([host]);
    await until(() => diagram.querySelector('svg') !== null, 40_000);
    expect(diagram.querySelector('svg'), diagram.getAttribute('title') ?? '').not.toBeNull();
    expect(diagram.classList.contains('mdr-mermaid-done')).toBe(true);
  }, 60_000);

  it('does nothing to a chunk it has already done', async () => {
    const code = host.querySelector('pre[data-lang="js"] code') as HTMLElement;
    enhancer.run([host]);
    await until(() => code.querySelector('span') !== null);
    const html = code.innerHTML;
    enhancer.run([host]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(code.innerHTML).toBe(html);
  });

  /**
   * Read mode keeps a block it has scrolled past, and later puts the same
   * element back without handing it here again. A block that leaves the
   * page before its renderer gets to it has to be finished all the same,
   * or it stays plain code, TeX or diagram source for good.
   */
  it('finishes a block that left the page before its renderer got to it', async () => {
    const code = host.querySelector('pre[data-lang="js"] code') as HTMLElement;
    const inline = host.querySelector('.mdr-math') as HTMLElement;
    const diagram = host.querySelector('.mdr-mermaid') as HTMLElement;
    const done = enhancer.run([host]);
    // Out of the page at once, which is before any of the three renderers
    // can have reached it: even a library already loaded is waited for.
    host.remove();
    await done;
    document.body.appendChild(host);
    expect(code.querySelector('span.tok-keyword')).not.toBeNull();
    expect(inline.querySelector('.katex')).not.toBeNull();
    expect(diagram.querySelector('svg'), diagram.getAttribute('title') ?? '').not.toBeNull();
  }, 60_000);
});

describe('highlighting on a busy machine', () => {
  /** A fence of its own, inside the host so the suite's cleanup takes it too. */
  function mountFence(source: string): HTMLElement {
    const root = document.createElement('div');
    root.appendChild(toDom(renderDocument(parser.parse(source), source)).fragment);
    host.appendChild(root);
    return root;
  }

  it('colours a line the same however long it took to colour', async () => {
    const fence = '```js\nconst answer = compute(everything); // and why\nlet n = 42;\n```\n';
    // The first block through the grammar loads it and compiles it.
    const calm = mountFence(fence);
    await enhancer.run([calm]);
    // Then the same block again, with every read of the clock a second
    // later than the last: no line can be finished inside any time limit.
    // Shiki's default limit hands back the rest of a line as one token
    // in whatever it was in, which is a line in the wrong colour.
    const hurried = mountFence(fence);
    const real = Date.now;
    let reads = 0;
    Date.now = () => real.call(Date) + reads++ * 1000;
    try {
      await enhancer.run([hurried]);
    } finally {
      Date.now = real;
    }
    const code = (root: HTMLElement) => root.querySelector('pre code') as HTMLElement;
    expect(code(calm).querySelectorAll('span').length).toBeGreaterThan(3);
    expect(code(hurried).innerHTML).toBe(code(calm).innerHTML);
  });
});
