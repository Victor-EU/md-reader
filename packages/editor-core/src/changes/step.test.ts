import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { changesField, setChanges } from './markers.ts';
import type { ChangeKind, ChangeRecord } from './records.ts';
import { changeStops, nextChange, previousChange } from './step.ts';

const doc = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
const base = EditorState.create({ doc, extensions: [changesField] });

/** A change covering whole lines, as the shell's records do. */
function over(first: number, last: number, kind: ChangeKind = 'changed'): ChangeRecord {
  const from = base.doc.line(first).from;
  const to = base.doc.line(last).to;
  return { id: `${kind}:${from}:${to}`, kind, from, to, parts: [], revert: [] };
}

/** A state with `records` set and the cursor at the start of line `line`. */
function marked(records: readonly ChangeRecord[], line = 1): EditorState {
  return base.update({
    effects: setChanges.of(records),
    selection: EditorSelection.cursor(base.doc.line(line).from),
  }).state;
}

/** The line the command lands the cursor on, or false when it did not run. */
function land(command: StateCommand, state: EditorState): number | false {
  let after = state;
  const handled = command({
    state,
    dispatch: (tr) => {
      after = tr.state;
    },
  });
  return handled ? after.doc.lineAt(after.selection.main.head).number : false;
}

describe('stepping through changes', () => {
  it('stops once at each change, wherever it starts', () => {
    const state = marked([over(2, 4), over(7, 7, 'added')]);
    expect(changeStops(state).map((pos) => state.doc.lineAt(pos).number)).toEqual([2, 7]);
  });

  /**
   * Two changed list items are drawn as one bar in the margin and are
   * still two things that happened, so the walk stops at both.
   */
  it('stops at two touching changes separately', () => {
    const state = marked([over(2, 2), over(3, 3)]);
    expect(changeStops(state).map((pos) => state.doc.lineAt(pos).number)).toEqual([2, 3]);
  });

  it('goes to the next change and then the one after it', () => {
    const changes = [over(2, 2), over(5, 5, 'added')];
    expect(land(nextChange, marked(changes, 1))).toBe(2);
    expect(land(nextChange, marked(changes, 2))).toBe(5);
    expect(land(previousChange, marked(changes, 5))).toBe(2);
  });

  /** Find wraps, and a reader who starts in the middle wants the ones above. */
  it('wraps at both ends', () => {
    const changes = [over(2, 2), over(5, 5, 'added')];
    expect(land(nextChange, marked(changes, 6))).toBe(2);
    expect(land(previousChange, marked(changes, 1))).toBe(5);
  });

  it('does not take the key when nothing has changed', () => {
    expect(land(nextChange, marked([]))).toBe(false);
    expect(land(previousChange, marked([]))).toBe(false);
  });

  it('does not take the key in a view with no change marks at all', () => {
    const bare = EditorState.create({ doc });
    expect(land(nextChange, bare)).toBe(false);
  });
});
