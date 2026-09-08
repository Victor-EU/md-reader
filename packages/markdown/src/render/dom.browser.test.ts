/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { goldenSet } from '../corpus.ts';
import { parser } from '../parser.ts';
import { readDom, toDom } from './dom.ts';
import { toHtml } from './html.ts';
import { renderDocument } from './render.ts';

/**
 * The rendering goldens as DOM, on Chromium and WebKit (plan 7.2).
 *
 * The golden files are written from the HTML adapter in Node; this mounts
 * the same nodes through the DOM adapter, reads the mounted tree back, and
 * writes it with the same writer. A pass means both adapters and both
 * engines produced one document, which is why there is one golden file
 * rather than one per engine.
 */
const goldens = import.meta.glob('/corpus/goldens/read/**/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('dom adapter', () => {
  const files = goldenSet();

  it('has a golden for every file in the set', () => {
    const missing = files.filter(
      (file) =>
        goldens[`/corpus/goldens/read/${file.name.replace(/\.md$/, '.html')}`] === undefined,
    );
    expect(missing.map((file) => file.name)).toEqual([]);
  });

  it(`mounts ${files.length} documents as the goldens say`, () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const wrong: string[] = [];
    for (const file of files) {
      host.replaceChildren();
      const nodes = renderDocument(parser.parse(file.text), file.text);
      host.appendChild(toDom(nodes).fragment);
      const golden = goldens[`/corpus/goldens/read/${file.name.replace(/\.md$/, '.html')}`];
      if (`${toHtml(readDom(host))}\n` !== golden) wrong.push(file.name);
    }
    host.remove();
    expect(wrong).toEqual([]);
  });

  it('records where every verbatim run starts', () => {
    const source = 'a *b* `c`\n\n    code\n';
    const { fragment, offsets } = toDom(renderDocument(parser.parse(source), source));
    const host = document.createElement('div');
    host.appendChild(fragment);
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = offsets.get(node as Text);
      if (at === undefined) continue;
      seen += 1;
      expect(source.slice(at, at + (node as Text).length)).toBe(node.nodeValue);
    }
    expect(seen).toBeGreaterThan(3);
  });
});
