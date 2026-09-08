import { EditorSelection, type StateCommand } from '@codemirror/state';

/**
 * Wrap every non-empty selection range in `marker` on both sides and keep
 * the text selected. Two insertions per range and nothing else; the
 * round-trip corpus checks exactly that.
 *
 * The annotation marks toggle instead of only wrapping, and live in
 * `annotate.ts` beside the rest of design 4.3.
 */
export function wrapSelection(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.selection.ranges.every((r) => r.empty)) return false;
    const changes = state.changeByRange((range) => {
      if (range.empty) return { range };
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    });
    dispatch(state.update(changes, { userEvent: 'input.format', scrollIntoView: true }));
    return true;
  };
}

export const wrapBold = wrapSelection('**');
