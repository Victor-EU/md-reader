import { invertedEffects } from '@codemirror/commands';
import {
  type ChangeDesc,
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from '@codemirror/state';

/**
 * A hunk both sides changed, kept beside the document rather than in it.
 *
 * The buffer holds our version, as it did before the write arrived;
 * `theirs` is what the file now says about the same lines. It is never
 * text in the document, and that is the point of the whole module: a
 * conflict is a question, and a question must not reach the disk as if
 * it were prose. Nothing here can be saved by accident because there is
 * nothing here to save (design 7.2, plan WP 2.1).
 */
export interface ConflictRegion {
  /** Names one region for as long as it is unsettled, edits and all. */
  id: string;
  /** Our version, in document offsets, mapped through every edit. */
  from: number;
  to: number;
  /** Their version of the same hunk, as the lines it would put there. */
  theirs: string;
}

let counter = 0;

/**
 * Stamp a hunk the merge returned with the id the widget and the
 * commands use to name it. Offsets are the document's, so a caller
 * applying the merge's other hunks in the same transaction maps these
 * through that change set first.
 */
export function conflictRegion(from: number, to: number, theirs: string): ConflictRegion {
  counter += 1;
  return { id: `conflict-${counter}`, from, to, theirs };
}

/**
 * Where a region sits after an edit.
 *
 * Both ends associate to the left, so text typed at the start of the
 * conflicting lines joins the region -- it is more of our version, and
 * taking theirs should replace it -- while text typed at the start of
 * the line after it stays outside, where it belongs to the document and
 * nothing here may delete it.
 */
function mapRegion(region: ConflictRegion, changes: ChangeDesc): ConflictRegion {
  const from = changes.mapPos(region.from, -1);
  return { ...region, from, to: Math.max(from, changes.mapPos(region.to, -1)) };
}

/** Hunks the merge found, in document offsets. */
export const addConflicts = StateEffect.define<readonly ConflictRegion[]>({
  map: (regions, changes) => regions.map((region) => mapRegion(region, changes)),
});

/** One region settled, by id: the reader chose, or an undo took it back. */
export const resolveConflict = StateEffect.define<string>();

/**
 * Whether two regions are about the same text. A region emptied by the
 * reader deleting their whole side has no width to overlap with, so it
 * counts as touching whatever it sits inside.
 */
function collide(a: ConflictRegion, b: ConflictRegion): boolean {
  if (a.from === a.to) return a.from >= b.from && a.from <= b.to;
  if (b.from === b.to) return b.from >= a.from && b.from <= a.to;
  return a.from < b.to && b.from < a.to;
}

/**
 * Newer regions win where they meet older ones.
 *
 * An unsettled region from an earlier write offers a version of the file
 * that is no longer on disk. Where a newer write covers the same lines,
 * that offer has been overtaken and taking it would put back text the
 * writer has since replaced. Elsewhere the older question stands: a
 * second write to another part of the file does not answer it, and the
 * merge will not report it again, because by then both sides agree on
 * what the base says there.
 *
 * Nothing is lost either way. Every write that arrives is an `external`
 * snapshot before any of this runs (design 4.4).
 */
function add(
  existing: readonly ConflictRegion[],
  incoming: readonly ConflictRegion[],
): readonly ConflictRegion[] {
  const kept = existing.filter((region) => !incoming.some((other) => collide(region, other)));
  return [...kept, ...incoming].sort((a, b) => a.from - b.from);
}

/** The unsettled regions of one document, in document order. */
export const conflictsField = StateField.define<readonly ConflictRegion[]>({
  create: () => [],
  update(regions, transaction) {
    let next = transaction.docChanged
      ? regions.map((region) => mapRegion(region, transaction.changes))
      : regions;
    for (const effect of transaction.effects) {
      if (effect.is(addConflicts)) next = add(next, effect.value);
      else if (effect.is(resolveConflict))
        next = next.filter((region) => region.id !== effect.value);
    }
    return next;
  },
});

/** The regions in a state, whether or not the extension is loaded. */
export function conflicts(state: EditorState): readonly ConflictRegion[] {
  return state.field(conflictsField, false) ?? [];
}

/** Whether this document has a question outstanding, which holds its save. */
export function hasConflicts(state: EditorState): boolean {
  return conflicts(state).length > 0;
}

/** The region a position falls in, ends included, or null. */
export function conflictAt(state: EditorState, pos: number): ConflictRegion | null {
  return conflicts(state).find((region) => pos >= region.from && pos <= region.to) ?? null;
}

/** Whether a transaction settled or raised anything, for a caller watching. */
export function conflictsChanged(transaction: Transaction): boolean {
  return transaction.effects.some(
    (effect) => effect.is(addConflicts) || effect.is(resolveConflict),
  );
}

/**
 * Undo puts a settled conflict back, and takes back one that has just
 * arrived.
 *
 * Keeping mine changes no text at all, so without this there is no way
 * back from it: our version is already what the buffer says, and theirs
 * would be left only in the history panel, which is WP 2.3. A choice
 * with no way back is one a reader makes slowly, and this one should be
 * cheap to make. Taking theirs is a change undo reverts on its own, but
 * reverting the text and not the question would leave the reader looking
 * at their own version again with nothing offering the other one.
 *
 * The effects carry the regions as the transaction found them, which is
 * the convention the history maps from.
 */
const undoResolution = invertedEffects.of((transaction) => {
  const before = transaction.startState.field(conflictsField, false);
  if (!before) return [];
  const after = transaction.state.field(conflictsField);
  const settled = before.filter((region) => !after.some((other) => other.id === region.id));
  const raised = after.filter((region) => !before.some((other) => other.id === region.id));
  return [
    ...(settled.length > 0 ? [addConflicts.of(settled)] : []),
    ...raised.map((region) => resolveConflict.of(region.id)),
  ];
});

/** The field and its undo handler, without anything that draws. */
export const conflictState = [conflictsField, undoResolution];
