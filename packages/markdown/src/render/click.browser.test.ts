import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { offsetFromPoint, resolveOffset } from './click.ts';
import { toDom } from './dom.ts';
import { renderDocument } from './render.ts';

/**
 * Click-to-edit, the way design 7.1 promises it: a click anywhere in the
 * rendered document resolves to the source offset under the pointer. The
 * test clicks every word of a fixture and checks the offset lands inside
 * that word, which is the check the build plan asks for in WP 1.4.
 */
const fixture = `# The title

A paragraph with *emphasis*, **strong words**, \`inline code\`, a
[link](https://example.test/page), and ==a highlight== in it.

- a list item with a longer sentence in it
- [ ] a task that is not done yet

| column one | column two |
|---|---|
| first cell | second cell |

\`\`\`js
const answer = compute(everything);
\`\`\`

> A quotation that runs on for a while so it wraps.

$$
a^2 + b^2 = c^2
$$
`;

let host: HTMLElement;
let offsets: WeakMap<Text, number>;

beforeEach(() => {
  host = document.createElement('div');
  // Narrow enough that every line fits the runner's viewport: a point
  // outside it has no caret to find, in either engine.
  host.style.cssText = 'width: 340px; font: 16px/1.6 serif; padding: 8px;';
  document.body.appendChild(host);
  const mounted = toDom(renderDocument(parser.parse(fixture), fixture));
  offsets = mounted.offsets;
  host.appendChild(mounted.fragment);
});

afterEach(() => {
  host.remove();
});

interface Word {
  text: string;
  node: Text;
  start: number;
  end: number;
}

/** Every word of the mounted document that the reader can actually see. */
function words(): Word[] {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const found: Word[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    if (textNode.parentElement?.closest('[hidden]')) continue;
    if (offsets.get(textNode) === undefined) continue;
    for (const match of (textNode.nodeValue ?? '').matchAll(/[\p{L}\p{N}]+/gu)) {
      const start = match.index;
      found.push({ text: match[0], node: textNode, start, end: start + match[0].length });
    }
  }
  return found;
}

function center(word: Word): { x: number; y: number } | null {
  const range = document.createRange();
  range.setStart(word.node, word.start);
  range.setEnd(word.node, word.end);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const inside = point.x > 0 && point.y > 0 && point.x < innerWidth && point.y < innerHeight;
  return inside ? point : null;
}

describe('click to edit', () => {
  it('resolves every word to its own source range', () => {
    const all = words();
    expect(all.length).toBeGreaterThan(60);
    const wrong: string[] = [];
    for (const word of all) {
      const point = center(word);
      if (!point) continue;
      const base = offsets.get(word.node) as number;
      const offset = offsetFromPoint(point.x, point.y, offsets);
      if (offset === null || offset < base + word.start || offset > base + word.end) {
        wrong.push(
          `${JSON.stringify(word.text)} resolved to ${offset}, wanted ${base + word.start}-${base + word.end}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('resolves a caret inside a text node character for character', () => {
    const paragraph = host.querySelector('p') as HTMLElement;
    const first = paragraph.firstChild as Text;
    const base = offsets.get(first) as number;
    expect(resolveOffset(first, 5, offsets)).toBe(base + 5);
    expect(fixture.slice(base, base + 2)).toBe('A ');
  });

  it('resolves inside a code block whose text another renderer rewrote', () => {
    const code = host.querySelector('code[data-verbatim]') as HTMLElement;
    const from = Number(code.getAttribute('data-from'));
    // Shiki wraps the same text in spans; the mapping must survive that.
    const source = code.textContent ?? '';
    code.replaceChildren();
    for (const line of source.split(/(?<=\n)/)) {
      const span = document.createElement('span');
      span.textContent = line;
      code.appendChild(span);
    }
    const rewritten = code.querySelector('span')?.firstChild as Text;
    expect(resolveOffset(rewritten, 6, offsets)).toBe(from + 6);
    expect(fixture.slice(from, from + 5)).toBe('const');
  });

  it('falls back to the start of the block when the point is not in text', () => {
    const rule = host.querySelector('table') as HTMLElement;
    const from = Number(rule.getAttribute('data-from'));
    expect(resolveOffset(rule, 0, offsets)).toBe(from);
  });
});
