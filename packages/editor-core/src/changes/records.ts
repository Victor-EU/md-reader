import type { ChangeDesc } from '@codemirror/state';

/**
 * What happened to a block between two versions of a document.
 * `removed` marks a place rather than a range: the text that was there is
 * not in the buffer to point at. `moved` is the same words somewhere
 * else, which the semantic engine can tell from a rewrite (design 7.3).
 */
export type ChangeKind = 'added' | 'changed' | 'removed' | 'moved';

/**
 * One piece of the track-changes line a change is shown as (design 4.4).
 *
 * `gap` stands for untouched text that was left out: a changed word in
 * the middle of a long paragraph is easier to see with a few words of
 * context around it than with three hundred.
 */
export interface ChangePart {
  kind: 'same' | 'gone' | 'new' | 'gap';
  text: string;
}

/** One edit of the transaction that puts a change back. */
export interface ChangeEdit {
  from: number;
  to: number;
  insert: string;
}

/**
 * One change, as the gutter draws it and Review mode walks it.
 *
 * `from` and `to` are the block's range in the buffer, mapped through
 * every edit the reader makes so that a record stays beside its text
 * between one scan and the next. A `removed` record has no text of its
 * own, so its range is the point the deleted block used to be in front
 * of.
 *
 * The record carries what it takes to show the change and to undo it,
 * and nothing else: the shell works both out once, where it has both
 * versions in hand, and the editor never asks it a second question.
 */
export interface ChangeRecord {
  /** Names this change for as long as it stands, edits and all. */
  id: string;
  kind: ChangeKind;
  from: number;
  to: number;
  /** The change as old and new words, for the Review panel. */
  parts: readonly ChangePart[];
  /**
   * The edits that put this change back, against the document the record
   * was made for and mapped forward with it. Sorted, and never
   * overlapping, so they apply as one transaction.
   *
   * Empty where there is nothing to put back: a block that moved out of
   * a document that no longer holds anything to put it beside.
   */
  revert: readonly ChangeEdit[];
}

/**
 * Where a record sits after an edit.
 *
 * Both ends associate to the left, as a conflict region's do: text typed
 * at the start of a changed block is more of that block, and reverting
 * it should take the typing with it.
 */
export function mapRecord(record: ChangeRecord, changes: ChangeDesc): ChangeRecord {
  const from = changes.mapPos(record.from, -1);
  return {
    ...record,
    from,
    to: Math.max(from, changes.mapPos(record.to, -1)),
    revert: record.revert.map((edit) => {
      const at = changes.mapPos(edit.from, -1);
      return { ...edit, from: at, to: Math.max(at, changes.mapPos(edit.to, -1)) };
    }),
  };
}
