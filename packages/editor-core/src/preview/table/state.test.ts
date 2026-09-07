import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../../test-helpers.ts';
import { changedRegion, tableWidgetsField } from './state.ts';

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

function widgets(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  const iter = state.field(tableWidgetsField).deco.iter();
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

describe('tableWidgetsField', () => {
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
    expect(state.field(tableWidgetsField).deco.iter(53).value).toBe(
      shifted.field(tableWidgetsField).deco.iter(56).value,
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
