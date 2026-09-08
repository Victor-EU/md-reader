import type { ChangeSpec, EditorSelection, EditorState, StateCommand } from '@codemirror/state';

/**
 * One planned edit: the bytes it changes and where the selection lands
 * afterwards, in the coordinates of the document it produces.
 *
 * Every editing command in this folder is written as a pure function of
 * the state that returns one of these. That is what lets the round-trip
 * corpus state the bytes it expects without running the editor, and what
 * keeps the commands usable from Read mode, where there is no editor view
 * to dispatch through.
 */
export interface Edit {
  changes: ChangeSpec;
  selection: EditorSelection;
}

/** Turn a plan into a command. Null means the command does not apply here. */
export function command(
  plan: (state: EditorState) => Edit | null,
  userEvent: string,
): StateCommand {
  return ({ state, dispatch }) => {
    const edit = plan(state);
    if (!edit) return false;
    dispatch(state.update({ ...edit, userEvent, scrollIntoView: true }));
    return true;
  };
}
