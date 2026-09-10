import { ChangeSet, type ChangeSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../../test-helpers.ts';
import {
  deleteColumn,
  deleteRow,
  displayWidth,
  escapePipes,
  formatTable,
  insertColumnAfter,
  insertRowBelow,
  materializeCell,
  rebaseCellChanges,
} from './commands.ts';
import { tableModelAt, tableNodeAt } from './model.ts';

const doc = ['intro', '', '| a | b |', '|---|:-:|', '| 1 | 2 |', '| 3 |', '', 'after'].join('\n');

function apply(source: string, spec: ChangeSpec | null): string {
  if (spec === null) return source;
  const state = parsedState(source, 0);
  return state.update({ changes: spec }).state.doc.toString();
}

function tableFrom(source: string): number {
  const state = parsedState(source, 0);
  return tableNodeAt(state, source.indexOf('| a'))?.from ?? -1;
}

/** Columns of the table starting the source, or 0 when the parse no longer finds one there. */
function columnsOf(source: string): number {
  const state = parsedState(source, 0);
  const node = tableNodeAt(state, 0);
  return (node && tableModelAt(state, node.from)?.columns) ?? 0;
}

describe('table commands', () => {
  it('inserts a row below the header and below a body row, keeping any line prefix', () => {
    const state = parsedState(doc, 0);
    const from = tableFrom(doc);
    expect(apply(doc, insertRowBelow(state, from, 0))).toContain('|---|:-:|\n|  |  |\n| 1 | 2 |');
    expect(apply(doc, insertRowBelow(state, from, 2))).toContain('| 3 |\n|  |  |\n');
    const quoted = '> | a | b |\n> |---|---|\n> | 1 | 2 |';
    const qs = parsedState(quoted, 0);
    expect(apply(quoted, insertRowBelow(qs, tableFrom(quoted), 1))).toBe(`${quoted}\n> |  |  |`);
  });

  it('deletes a body row but never the header', () => {
    const state = parsedState(doc, 0);
    const from = tableFrom(doc);
    expect(apply(doc, deleteRow(state, from, 1))).toBe(doc.replace('\n| 1 | 2 |', ''));
    expect(deleteRow(state, from, 0)).toBeNull();
  });

  it('inserts and deletes columns in every row and the delimiter', () => {
    const state = parsedState(doc, 0);
    const from = tableFrom(doc);
    const wider = apply(doc, insertColumnAfter(state, from, 0));
    expect(wider).toContain('| a |  | b |');
    expect(wider).toContain('|---| --- |:-:|');
    expect(wider).toContain('| 1 |  | 2 |');
    expect(wider).toContain('| 3 |  |');
    const narrower = apply(doc, deleteColumn(state, from, 1));
    expect(narrower).toContain('| a |\n|---|\n| 1 |\n| 3 |');
  });

  it('formats with padding, alignment, and East Asian widths', () => {
    const messy = ['| name | 値 |', '|:--|--:|', '| 日本語 | 1 |', '|x|22|'].join('\n');
    const state = parsedState(messy, 0);
    const formatted = apply(messy, formatTable(state, 0));
    expect(formatted).toBe(
      ['| name   |  値 |', '| :----- | --: |', '| 日本語 |   1 |', '| x      |  22 |'].join('\n'),
    );
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('abc')).toBe(3);
  });

  /**
   * GFM draws a row only as wide as the header and ignores the rest, but
   * ignoring is not deleting: a format that dropped those cells would take
   * text out of the file that the reader put there and can no longer see.
   */
  it('formats a row wider than the header without losing the cells past it', () => {
    const ragged = ['| a | b |', '|---|---|', '| 1 | 2 | 3 |'].join('\n');
    const state = parsedState(ragged, 0);
    expect(apply(ragged, formatTable(state, 0))).toBe(
      ['| a   | b   |', '| --- | --- |', '| 1   | 2   | 3 |'].join('\n'),
    );
  });

  /**
   * Outer pipes are optional in GFM, and every one of these has to hold
   * the table together without them: a column added straight onto the end
   * of `--- | ---` gives `--- | --- ---`, which is not a delimiter row, and
   * the parse loses the table rather than gaining a column.
   */
  it('adds a column to a table whose rows have no outer pipes', () => {
    const bare = ['a | b', '--- | ---', '1 | 2'].join('\n');
    const state = parsedState(bare, 0);
    const wider = apply(bare, insertColumnAfter(state, 0, 1));
    expect(wider).toBe(['a | b |  |', '--- | --- | --- |', '1 | 2 |  |'].join('\n'));
    expect(columnsOf(wider)).toBe(3);
    const inside = apply(bare, insertColumnAfter(state, 0, 0));
    expect(inside).toBe(['a |  | b', '--- | --- | ---', '1 |  | 2'].join('\n'));
    expect(columnsOf(inside)).toBe(3);
  });

  /**
   * A row the old code skipped -- one with no pipe in front of the cell --
   * kept a cell the header had lost, which slides that column of the
   * reader's data under the heading next to it.
   */
  it('takes a column out of rows that open without a pipe', () => {
    const mixed = ['| a | b |', '|---|---|', '1 | 2'].join('\n');
    const ms = parsedState(mixed, 0);
    expect(apply(mixed, deleteColumn(ms, 0, 0))).toBe(['| b |', '|---|', '| 2 |'].join('\n'));
    const bare = ['a | b | c', '--- | --- | ---', '1 | 2 | 3'].join('\n');
    const bs = parsedState(bare, 0);
    const narrower = apply(bare, deleteColumn(bs, 0, 0));
    expect(narrower).toBe(['| b | c', '| --- | ---', '| 2 | 3'].join('\n'));
    expect(columnsOf(narrower)).toBe(2);
    // Down to one column the kept pipe has to close the row as well as
    // open it, or the delimiter row stops being one.
    const last = apply(narrower, deleteColumn(parsedState(narrower, 0), 0, 0));
    expect(last).toBe(['| c |', '| --- |', '| 3 |'].join('\n'));
    expect(columnsOf(last)).toBe(1);
  });

  it('materializes a missing cell so it can be edited', () => {
    const state = parsedState(doc, 0);
    const from = tableFrom(doc);
    expect(apply(doc, materializeCell(state, from, 2, 1))).toContain('| 3 |  |');
    expect(materializeCell(state, from, 1, 1)).toBeNull();
    const open = '| a | b |\n|---|---|\n| 3';
    const os = parsedState(open, 0);
    expect(apply(open, materializeCell(os, 0, 1, 1))).toBe('| a | b |\n|---|---|\n| 3 |  |');
  });

  it('rebases cell changes by the cell start and escapes pipes', () => {
    const changes = ChangeSet.of([{ from: 1, to: 2, insert: 'xy' }], 3);
    expect(rebaseCellChanges(10, changes)).toEqual([{ from: 11, to: 12, insert: 'xy' }]);
    expect(escapePipes('a|b')).toBe('a\\|b');
    expect(escapePipes('a\\|b')).toBe('a\\|b');
    expect(escapePipes('||')).toBe('\\|\\|');
  });

  /**
   * The backslashes in front of a pipe decide whether it is a delimiter,
   * and they are usually text the reader typed before this keystroke. A
   * `|` escaped against the keystroke alone becomes `\\|` after a `\` they
   * already typed, which is an escaped backslash and a live delimiter.
   */
  it('escapes a pipe against the text it lands after', () => {
    // A pipe after `a\` is escaped already; after `a\\`, the backslash is
    // the escaped one and the pipe is not.
    expect(escapePipes('|', 'a\\')).toBe('|');
    expect(escapePipes('|', 'a\\\\')).toBe('\\|');
    expect(escapePipes('|', 'a')).toBe('\\|');
    expect(escapePipes('b|c', 'a\\')).toBe('b\\|c');
  });
});
