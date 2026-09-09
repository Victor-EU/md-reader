import { EditorSelection, type StateCommand } from '@codemirror/state';
import type { CommandTarget } from '../preview/widgets.ts';
import { conflictAt, conflicts, resolveConflict } from './state.ts';

/**
 * Keep our version (design 7.2). The text is already what the buffer
 * says, so nothing is written: the question goes and the document is
 * left exactly as the reader had it.
 */
export function keepMine(target: CommandTarget, id: string): boolean {
  if (!conflicts(target.state).some((region) => region.id === id)) return false;
  target.dispatch(
    target.state.update({ effects: resolveConflict.of(id), userEvent: 'conflict.keep' }),
  );
  return true;
}

/**
 * Take their version: their lines replace ours in one change, so the
 * cursor, the marks and the undo history all map through it the way they
 * do for any other edit.
 */
export function takeTheirs(target: CommandTarget, id: string): boolean {
  const region = conflicts(target.state).find((other) => other.id === id);
  if (!region) return false;
  target.dispatch(
    target.state.update({
      changes: { from: region.from, to: region.to, insert: region.theirs },
      effects: resolveConflict.of(id),
      userEvent: 'conflict.take',
    }),
  );
  return true;
}

/** The same two choices from the keyboard, about the region the cursor is in. */
function here(take: boolean): StateCommand {
  return ({ state, dispatch }) => {
    const region = conflictAt(state, state.selection.main.head);
    if (!region) return false;
    return (take ? takeTheirs : keepMine)({ state, dispatch }, region.id);
  };
}

export const keepMineHere = here(false);
export const takeTheirsHere = here(true);

/**
 * Put the cursor at the next unsettled region, wrapping at the end.
 *
 * There is no command for the previous one. Stepping wraps, and a
 * document has a handful of these at most -- one write by one agent over
 * one edit -- so going round is a keypress or two rather than the
 * scrolling that made Previous Change worth having.
 */
export const nextConflict: StateCommand = ({ state, dispatch }) => {
  const regions = conflicts(state);
  const first = regions[0];
  if (!first) return false;
  const head = state.selection.main.head;
  const at = regions.find((region) => region.from > head) ?? first;
  dispatch(
    state.update({
      selection: EditorSelection.cursor(at.from),
      scrollIntoView: true,
      userEvent: 'select.conflict',
    }),
  );
  return true;
};
