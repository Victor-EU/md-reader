import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state';
import { changesField } from './markers.ts';

/**
 * Stepping through the external changes (design scenario S4): "the human
 * presses a key to step through the changes, then marks reviewed".
 *
 * The runs are read back off the marks rather than kept beside them. The
 * marks are already mapped through every edit the reader makes, so they
 * are the only description of where the changes are that stays true while
 * the reader types and the next diff catches up.
 */

/** The first position of each run of marked lines, in document order. */
export function changeRuns(state: EditorState): number[] {
  const marked = state.field(changesField, false);
  if (!marked) return [];
  const starts: number[] = [];
  let last = -2;
  for (const iter = marked.iter(); iter.value !== null; iter.next()) {
    const line = state.doc.lineAt(iter.from).number;
    // Consecutive marked lines are one change, not one each.
    if (line !== last + 1) starts.push(iter.from);
    last = line;
  }
  return starts;
}

/**
 * Put the cursor at the next run after it, or the previous one before it.
 *
 * Stepping wraps, as find does: a reader who starts in the middle of the
 * document still wants to see what changed above them, and a step that
 * stopped at the last change would leave them to scroll for the rest.
 */
function step(forward: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const starts = changeRuns(state);
    const first = starts[0];
    const final = starts.at(-1);
    if (first === undefined || final === undefined) return false;
    const head = state.selection.main.head;
    const before = starts.filter((pos) => pos < head);
    const at = forward ? (starts.find((pos) => pos > head) ?? first) : (before.at(-1) ?? final);
    dispatch(
      state.update({
        selection: EditorSelection.cursor(at),
        scrollIntoView: true,
        userEvent: 'select.change',
      }),
    );
    return true;
  };
}

export const nextChange = step(true);
export const previousChange = step(false);
