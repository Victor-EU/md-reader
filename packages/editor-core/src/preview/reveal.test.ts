import { describe, expect, it } from 'vitest';
import { parsedState } from '../test-helpers.ts';
import { revealRanges } from './reveal.ts';

function reveal(doc: string, selection: number | { anchor: number; head: number }) {
  return revealRanges(parsedState(doc, selection)).map((r) => [
    r.from,
    r.to,
    r.block ? 'block' : 'inline',
  ]);
}

describe('revealRanges', () => {
  it.each([
    ['cursor inside strong', '**bold** text', 3, [[0, 8, 'inline']]],
    ['cursor at the end edge touches', '**bold** text', 8, [[0, 8, 'inline']]],
    ['cursor at the start edge touches', 'x **bold**', 2, [[2, 10, 'inline']]],
    ['cursor one past the edge does not', '**bold** text', 9, []],
    ['plain text reveals nothing', 'just words', 4, []],
    ['outermost inline unit wins', '*a **b** c*', 5, [[0, 11, 'inline']]],
    ['heading is a block unit', '# Title', 3, [[0, 7, 'block']]],
    [
      'heading plus the inline unit under the cursor',
      '# Ti *em* x',
      6,
      [
        [0, 11, 'block'],
        [5, 9, 'inline'],
      ],
    ],
    ['heading without touching its inline marks', '# Ti *em* x', 2, [[0, 11, 'block']]],
    ['fenced code is one block unit, no descent', '```\n*x*\n```', 5, [[0, 11, 'block']]],
    ['link', 'see [text](http://u)', 6, [[4, 20, 'inline']]],
    ['inline code', 'a `b` c', 3, [[2, 5, 'inline']]],
    ['escape', 'a \\* b', 3, [[2, 4, 'inline']]],
    ['bullets and checkboxes are never units', '- [ ] task', 3, []],
    ['blockquote marks are not hidden, so not a unit', '> quote', 3, []],
    ['block math', '$$\nx\n$$', 3, [[0, 7, 'block']]],
    ['next line after a heading is not touching', '# T\ntext', 4, []],
  ])('%s', (_name, doc, cursor, expected) => {
    expect(reveal(doc, cursor)).toEqual(expected);
  });

  it('reveals every unit a selection overlaps, in document order', () => {
    expect(reveal('a *b* c\n\nd **e** f', { anchor: 1, head: 15 })).toEqual([
      [2, 5, 'inline'],
      [11, 16, 'inline'],
    ]);
    expect(reveal('# H\n\n*x*', { anchor: 0, head: 8 })).toEqual([
      [0, 3, 'block'],
      [5, 8, 'inline'],
    ]);
  });

  it('is stable for the same selection', () => {
    const state = parsedState('**a** *b*', 2);
    expect(revealRanges(state)).toEqual(revealRanges(state));
  });
});
