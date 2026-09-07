import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../../test-helpers.ts';
import { cellText, rowCells, tableModelAt, tableNodeAt } from './model.ts';

function cells(line: string): (string | { at: number })[] {
  const doc = Text.of([line]);
  return rowCells(doc, 0, line.length).map((c) =>
    c.from === c.to ? { at: c.from } : cellText(doc, c),
  );
}

describe('rowCells', () => {
  it.each([
    ['| a | b |', ['a', 'b']],
    ['|a|b|', ['a', 'b']],
    ['a | b', ['a', 'b']],
    ['| a | b', ['a', 'b']],
    ['a | b |', ['a', 'b']],
    ['| a \\| b | c |', ['a \\| b', 'c']],
    ['| 日本語 | b |', ['日本語', 'b']],
    ['| **x** | `y|z` |', ['**x**', '`y', 'z`']],
    ['|  | x |', [{ at: 2 }, 'x']],
    ['|| x |', [{ at: 1 }, 'x']],
    ['| x |  |', ['x', { at: 6 }]],
    ['| a |', ['a']],
    ['plain', ['plain']],
    ['|', [{ at: 1 }]],
  ])('%j -> %j', (line, expected) => {
    expect(cells(line)).toEqual(expected);
  });
});

describe('tableModel', () => {
  const doc = [
    '# T',
    '',
    '| a | b | c |',
    '|:--|:-:|--:|',
    '| 1 | 2 |',
    '| x | y | z | extra |',
    '',
    'after',
  ].join('\n');

  it('reads rows, alignment, and pads or truncates ragged rows', () => {
    const state = parsedState(doc, doc.length);
    const node = tableNodeAt(state, doc.indexOf('| 1'));
    expect(node?.name).toBe('Table');
    const model = tableModelAt(state, node?.from ?? -1);
    expect(model).not.toBeNull();
    if (!model) return;
    expect(model.columns).toBe(3);
    expect(model.align).toEqual(['left', 'center', 'right']);
    expect(
      model.rows.map((r) => r.cells.map((c) => (c.missing ? null : cellText(state.doc, c)))),
    ).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', null],
      ['x', 'y', 'z'],
    ]);
    const missing = model.rows[1]?.cells[2];
    expect(missing?.from).toBe(model.rows[1]?.to);
  });

  it('returns null outside a table and for a wrong start', () => {
    const state = parsedState(doc, 0);
    expect(tableNodeAt(state, 1)).toBeNull();
    expect(tableModelAt(state, doc.indexOf('| 1'))).toBeNull();
  });
});
