import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { toHtml } from './html.ts';
import { headings } from './outline.ts';
import { referenceDefinitions } from './references.ts';
import { renderDocument } from './render.ts';
import { Slugger } from './slug.ts';

describe('Slugger', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['  Trimmed  ', 'trimmed'],
    ['What? Really!', 'what-really'],
    ['Two   spaces', 'two-spaces'],
    ['snake_case-and-dash', 'snake_case-and-dash'],
    ['Über Straße', 'über-straße'],
    ['日本語', '日本語'],
    ['!!!', 'section'],
  ])('%j', (text, expected) => {
    expect(new Slugger().slug(text)).toBe(expected);
  });

  it('numbers repeats, and steps over an id a heading already took', () => {
    const slugger = new Slugger();
    expect(slugger.slug('Notes')).toBe('notes');
    expect(slugger.slug('Notes 1')).toBe('notes-1');
    expect(slugger.slug('Notes')).toBe('notes-2');
    expect(slugger.slug('Notes')).toBe('notes-3');
  });
});

describe('headings', () => {
  const source = '# One\n\n## Two *emphasized*\n\n> ### Quoted\n\ntext\n\n# One\n';

  it('lists every heading in document order with its level and text', () => {
    expect(headings(parser.parse(source), source).map((h) => [h.level, h.text, h.id])).toEqual([
      [1, 'One', 'one'],
      [2, 'Two emphasized', 'two-emphasized'],
      [3, 'Quoted', 'quoted'],
      [1, 'One', 'one-1'],
    ]);
  });

  it('gives the same ids the rendered document carries', () => {
    const html = toHtml(renderDocument(parser.parse(source), source), { ranges: false });
    for (const heading of headings(parser.parse(source), source)) {
      expect(html).toContain(`id="${heading.id}"`);
    }
  });

  it('points at the source of its heading', () => {
    const found = headings(parser.parse(source), source);
    expect(source.slice(found[1]?.from, found[1]?.to)).toBe('## Two *emphasized*');
  });
});

describe('referenceDefinitions', () => {
  it('reads labels, urls and titles', () => {
    const defs = referenceDefinitions('[A Label]: http://x.test "Title"\n[b]: <http://y.test>\n');
    expect(defs.get('a label')).toEqual({ url: 'http://x.test', title: 'Title' });
    expect(defs.get('b')).toEqual({ url: 'http://y.test', title: null });
  });

  it('keeps the first definition of a label, as CommonMark does', () => {
    const defs = referenceDefinitions('[a]: http://first.test\n[a]: http://second.test\n');
    expect(defs.get('a')?.url).toBe('http://first.test');
  });

  it('skips what only looks like one inside a fence', () => {
    expect(referenceDefinitions('```\n[a]: http://x.test\n```\n').size).toBe(0);
    expect(referenceDefinitions('~~~\n[a]: http://x.test\n~~~\n').size).toBe(0);
  });
});
