import type { EditorView } from '@codemirror/view';
import { changeAt, changes, dropChange } from './markers.ts';

/**
 * Put one change back (design 4.4: "each change can be reverted
 * individually").
 *
 * The edits were worked out where both versions were in hand and have
 * been mapped through everything the reader has typed since, so this is
 * a transaction and not a second diff. It is one transaction, so undo
 * takes the whole revert back — including the two halves of a move,
 * which are one thing having been undone and not two.
 */
export function revertChange(view: EditorView, id: string): boolean {
  const record = changes(view.state).find((entry) => entry.id === id);
  if (!record || record.revert.length === 0) return false;
  view.dispatch({
    // `ChangeSet.of` composes rather than combines when it meets an edit
    // behind the one before it, which would read the second against a
    // document the first had already moved.
    changes: [...record.revert].sort((a, b) => a.from - b.from),
    effects: dropChange.of(id),
    userEvent: 'revert.change',
    scrollIntoView: true,
  });
  return true;
}

/**
 * Revert whatever the cursor is standing in. A view command rather than
 * a state one, because the revert dispatches its own transaction.
 */
export function revertChangeAtCursor(view: EditorView): boolean {
  const record = changeAt(view.state, view.state.selection.main.head);
  return record === null ? false : revertChange(view, record.id);
}
