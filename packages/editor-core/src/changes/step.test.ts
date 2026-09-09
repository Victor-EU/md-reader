import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { changesField, type LineChange, setChanges } from './markers.ts';
import { changeRuns, nextChange, previousChange } from './step.ts';

const doc = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');

/** A state with `changes` marked and the cursor at the start of line `line`. */
function marked(changes: readonly LineChange[], line = 1): EditorState {
  const base = EditorState.create({ doc, extensions: [changesField] });
  return base.update({
    effects: setChanges.of(changes),
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
  it('treats consecutive marked lines as one change', () => {
    const state = marked([
      { from: 2, to: 5, kind: 'changed' },
      { from: 7, to: 8, kind: 'added' },
    ]);
    expect(changeRuns(state).map((pos) => state.doc.lineAt(pos).number)).toEqual([2, 7]);
  });

  it('goes to the next run and then the one after it', () => {
    const changes: LineChange[] = [
      { from: 2, to: 3, kind: 'changed' },
      { from: 5, to: 6, kind: 'added' },
    ];
    expect(land(nextChange, marked(changes, 1))).toBe(2);
    expect(land(nextChange, marked(changes, 2))).toBe(5);
    expect(land(previousChange, marked(changes, 5))).toBe(2);
  });

  /** Find wraps, and a reader who starts in the middle wants the ones above. */
  it('wraps at both ends', () => {
    const changes: LineChange[] = [
      { from: 2, to: 3, kind: 'changed' },
      { from: 5, to: 6, kind: 'added' },
    ];
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
