import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../../test-helpers.ts';
import { setActiveCell } from '../table/state.ts';
import type { TableWidget } from '../table/widget.ts';
import { blockWidgetsField, changedRegion } from './state.ts';

const doc = [
  'para one',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'para three',
  '',
  '| c |',
  '|---|',
  '| 3 |',
  '',
].join('\n');

function edited(state: EditorState, from: number, to: number, insert: string): EditorState {
  return state.update({ changes: { from, to, insert } }).state;
}

/** The table widget whose block starts at or after `pos`. */
function tableAt(state: EditorState, pos: number): TableWidget | undefined {
  return state.field(blockWidgetsField).deco.iter(pos).value?.spec.widget as
    | TableWidget
    | undefined;
}

/**
 * Run `fn` on a clock that jumps a second at every reading: a machine that
 * loses the CPU while a time budget is being spent, made repeatable.
 * CodeMirror's 20 ms parse after a transaction stops after its first step.
 */
function starved<T>(fn: () => T): T {
  const real = Date.now;
  let reads = 0;
  Date.now = () => real.call(Date) + reads++ * 1000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function widgets(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  const iter = state.field(blockWidgetsField).deco.iter();
  while (iter.value) {
    out.push([iter.from, iter.to]);
    iter.next();
  }
  return out;
}

describe('changedRegion', () => {
  it('bounds the reparsed blocks and reports null when every block was reused', () => {
    const state = parsedState(doc, doc.length);
    const inParagraph = edited(state, 5, 5, 'X');
    expect(changedRegion(syntaxTree(state), syntaxTree(inParagraph))).toEqual({ from: 0, to: 11 });
    // Lezer reparses a margin around the change, so the blank line before the table still
    // touches the paragraph; what matters is that the tables below are not in the region.
    const blankLine = edited(state, 9, 9, '\n');
    expect(changedRegion(syntaxTree(state), syntaxTree(blankLine))?.to).toBeLessThanOrEqual(12);
    expect(changedRegion(syntaxTree(state), syntaxTree(state))).toBeNull();
    const fence = edited(state, 0, 0, '```\n');
    expect(changedRegion(syntaxTree(state), syntaxTree(fence))).toEqual({
      from: 0,
      to: doc.length + 4,
    });
  });
});

describe('blockWidgetsField', () => {
  it('keeps both tables as widgets and maps them through edits elsewhere', () => {
    const state = parsedState(doc, doc.length);
    expect(widgets(state)).toEqual([
      [10, 39],
      [53, 70],
    ]);
    const shifted = edited(state, 5, 5, 'XYZ');
    expect(widgets(shifted)).toEqual([
      [13, 42],
      [56, 73],
    ]);
    expect(state.field(blockWidgetsField).deco.iter(53).value).toBe(
      shifted.field(blockWidgetsField).deco.iter(56).value,
    );
  });

  it('drops a widget while the selection touches its table and restores it after', () => {
    const state = parsedState(doc, doc.length);
    const inside = state.update({ selection: { anchor: 12 } }).state;
    expect(widgets(inside)).toEqual([[53, 70]]);
    const outside = inside.update({ selection: { anchor: 0 } }).state;
    expect(widgets(outside)).toEqual([
      [10, 39],
      [53, 70],
    ]);
  });

  it('removes widgets for tables a fence swallows and rebuilds after the fence closes', () => {
    const state = parsedState(doc, doc.length);
    const fenced = edited(state, 0, 0, '```\n');
    expect(widgets(fenced)).toEqual([]);
    const closed = edited(fenced, 4, 4, '```\n');
    expect(widgets(closed)).toEqual([
      [18, 47],
      [61, 78],
    ]);
  });
});

describe('blockWidgetsField over a parse cut short', () => {
  const table = doc.indexOf('| a |');
  const open = (state: EditorState) =>
    state.update({ effects: setActiveCell.of({ table, row: 1, col: 0, cursor: 'end' }) }).state;

  it('reaches the open table and leaves the one below it alone', () => {
    const before = open(parsedState(doc, 0));
    const below = tableAt(before, 53);
    // A keystroke in the open cell, on a machine that loses the CPU for it.
    const typed = starved(
      () =>
        before.update({
          changes: { from: doc.indexOf('| 1 |') + 3, insert: 'x' },
          effects: setActiveCell.of({ table, row: 1, col: 0, cursor: 'keep' }),
        }).state,
    );
    // The transaction's own parse stopped short of both tables, and neither
    // table went anywhere for it.
    expect(syntaxTree(typed).length).toBeLessThan(table);
    expect(widgets(typed)).toEqual([
      [10, 40],
      [54, 71],
    ]);
    // The open one is parsed the rest of the way, so the cell being typed in
    // is drawn where the letter just went.
    expect(tableAt(typed, table)?.source).toContain('| 1x |');
    // The one below is nobody's open cell; it keeps the widget it had until
    // the background parse gets there.
    expect(tableAt(typed, 54)).toBe(below);
  });

  /**
   * Tab off the last cell writes a row, and the parse that would put it in a
   * tree can be cut short like any other. The widget has to gain the row
   * anyway: the cell editor mounts in it, and a letter typed into a row that
   * is not drawn is a letter the reader loses.
   */
  it('gains a row added past where the parse stopped', () => {
    const before = open(parsedState(doc, 0));
    const row = 1;
    const grown = starved(
      () =>
        before.update({
          changes: { from: doc.indexOf('| 1 | 2 |') + '| 1 | 2 |'.length, insert: '\n|  |  |' },
          effects: setActiveCell.of({ table, row: row + 1, col: 0, cursor: 'end' }),
        }).state,
    );
    expect(syntaxTree(grown).length).toBeLessThan(table);
    expect(tableAt(grown, table)?.model.rows).toHaveLength(3);
    expect(tableAt(grown, table)?.active).toEqual({ table, row: 2, col: 0, cursor: 'end' });
  });

  it('moves the open cell in a table the parse has not reached yet', () => {
    const write = 'A line from elsewhere\n\n';
    const before = open(parsedState(doc, 0));
    const written = starved(() => before.update({ changes: { from: 0, insert: write } }).state);
    const moved = table + write.length;
    expect(syntaxTree(written).length).toBeLessThan(moved);
    const next = written.update({
      effects: setActiveCell.of({ table: moved, row: 1, col: 1, cursor: 'end' }),
    }).state;
    expect(tableAt(next, moved)?.active).toEqual({ table: moved, row: 1, col: 1, cursor: 'end' });
  });
});
