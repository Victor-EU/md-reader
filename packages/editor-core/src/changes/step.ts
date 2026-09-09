import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state';
import { changes } from './markers.ts';

/**
 * Stepping through the external changes (design scenario S4): "the human
 * presses a key to step through the changes, then marks reviewed".
 *
 * The stops are the change records, which are mapped through every edit
 * the reader makes, so they stay beside their text while the reader
 * types and the next scan catches up. One stop per change and not per
 * run of marked lines: three revised list items are three things that
 * happened, three panels in Review mode, and three things to step
 * through, even though the margin draws them as one bar.
 */

/** Where each change begins, in document order. */
export function changeStops(state: EditorState): number[] {
  return [...changes(state)].map((record) => record.from).sort((a, b) => a - b);
}

/**
 * Put the cursor at the next change after it, or the previous one before
 * it.
 *
 * Stepping wraps, as find does: a reader who starts in the middle of the
 * document still wants to see what changed above them, and a step that
 * stopped at the last change would leave them to scroll for the rest.
 */
function step(forward: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const starts = changeStops(state);
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
