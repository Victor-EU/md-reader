import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from '@codemirror/state';

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

/**
 * The part of a range a mark should actually cover: the whitespace at its
 * edges left outside. Null when there is nothing but whitespace to mark.
 *
 * Trimming matters more than it looks. A selection dragged to the end of a
 * line takes the line break with it, and a marker either side of a line
 * break is not a mark. `**` becomes four asterisks the reader has to
 * delete. `==` is worse: alone on the line after a paragraph it is a Setext
 * heading underline, so highlighting a whole paragraph turns it into an H1
 * and puts it in the outline.
 */
export function trimmed(state: EditorState, range: SelectionRange): SelectionRange | null {
  const text = state.doc.sliceString(range.from, range.to);
  const lead = /^\s*/.exec(text)?.[0].length ?? 0;
  const trail = /\s*$/.exec(text)?.[0].length ?? 0;
  if (lead + trail >= text.length) return null;
  return EditorSelection.range(range.from + lead, range.to - trail);
}
