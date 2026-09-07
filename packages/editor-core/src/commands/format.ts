import { EditorSelection, type StateCommand } from '@codemirror/state';
import type { AnnotationKind } from '@mdreader/markdown';

/**
 * Wrap every non-empty selection range in `marker` on both sides and keep
 * the text selected. Two insertions per range and nothing else; the
 * round-trip corpus checks exactly that.
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
export const wrapHighlight = wrapSelection('==');
export const wrapStrikethrough = wrapSelection('~~');

/**
 * Insert `<!-- kind: text -->` right after the main selection, which
 * anchors it to the selected span (design 4.3). A space is added only
 * when the character before is not whitespace, so the comment never
 * glues onto a word; the extractor accepts that one space.
 */
export function insertCommentAfterSelection(kind: AnnotationKind, text: string): StateCommand {
  return ({ state, dispatch }) => {
    const at = state.selection.main.to;
    const before = at > 0 ? state.doc.sliceString(at - 1, at) : '';
    const space = before === '' || /\s/.test(before) ? '' : ' ';
    const insert = `${space}<!-- ${kind}: ${text} -->`;
    dispatch(
      state.update({
        changes: { from: at, insert },
        selection: EditorSelection.cursor(at + insert.length),
        userEvent: 'input.comment',
        scrollIntoView: true,
      }),
    );
    return true;
  };
}

/** The exact text `insertCommentAfterSelection` writes at `at`, for expectations computed outside the editor. */
export function commentInsertion(
  docBefore: string,
  at: number,
  kind: AnnotationKind,
  text: string,
): string {
  const before = at > 0 ? docBefore.slice(at - 1, at) : '';
  const space = before === '' || /\s/.test(before) ? '' : ' ';
  return `${space}<!-- ${kind}: ${text} -->`;
}
