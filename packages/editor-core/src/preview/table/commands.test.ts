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
import { tableNodeAt } from './model.ts';

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

describe('table commands', () => {
  it('inserts a row below the header and below a body row, keeping any line prefix', () => {
    const state = parsedState(doc, 0);
    const from = tableFrom(doc);
    expect(apply(doc, insertRowBelow(state, from, 0))).toContain('|---|:-:|\n| | |\n| 1 | 2 |');
    expect(apply(doc, insertRowBelow(state, from, 2))).toContain('| 3 |\n| | |\n');
    const quoted = '> | a | b |\n> |---|---|\n> | 1 | 2 |';
    const qs = parsedState(quoted, 0);
    expect(apply(quoted, insertRowBelow(qs, tableFrom(quoted), 1))).toBe(`${quoted}\n> | | |`);
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
});
