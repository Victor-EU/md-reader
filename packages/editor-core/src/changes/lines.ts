import type { Text } from '@codemirror/state';

/**
 * What happened to a run of lines between two versions of a document.
 * `removed` marks a place rather than a range: the text that was there is
 * not in the buffer to point at.
 */
export type ChangeKind = 'added' | 'changed' | 'removed';

/** A run of lines that differ, in the buffer's own 1-based line numbers. */
export interface LineChange {
  from: number;
  /** The line after the run, so `to === from` is a deletion. */
  to: number;
  kind: ChangeKind;
}

/**
 * Past this the diff stops earning its time and the whole differing
 * middle is reported as one run. A rewrite of an entire document is one
 * change to a reader whatever the algorithm says about it.
 */
const MAX_LINES = 2_000;
const MAX_CELLS = 250_000;

/**
 * Which lines of `after` differ from `before`, for the gutter and the
 * Changes badge (design 4.4).
 *
 * Line based for Phase 1. The semantic engine of WP 2.2 replaces what is
 * behind this function, not the shape of what comes out of it: a list of
 * runs in buffer line numbers is what the gutter draws either way.
 *
 * The lines both versions share at the start and the end are matched off
 * before anything else, so typing a word costs a diff of one line by one
 * line however long the document is.
 */
export function lineChanges(before: Text, after: Text): LineChange[] {
  if (before.eq(after)) return [];
  const old = before.toString().split('\n');
  const fresh = after.toString().split('\n');
  let head = 0;
  while (head < old.length && head < fresh.length && old[head] === fresh[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < fresh.length - head &&
    old[old.length - 1 - tail] === fresh[fresh.length - 1 - tail]
  )
    tail += 1;
  const wasMid = old.slice(head, old.length - tail);
  const isMid = fresh.slice(head, fresh.length - tail);
  if (wasMid.length === 0 && isMid.length === 0) return [];
  if (
    wasMid.length > MAX_LINES ||
    isMid.length > MAX_LINES ||
    wasMid.length * isMid.length > MAX_CELLS
  ) {
    return [run(head, 0, isMid.length, wasMid.length > 0, isMid.length > 0, fresh.length)];
  }
  return runs(wasMid, isMid, head, fresh.length);
}

/** One run, turned into buffer line numbers. */
function run(
  head: number,
  start: number,
  end: number,
  deleted: boolean,
  inserted: boolean,
  lines: number,
): LineChange {
  if (!inserted) {
    // Nothing of it is left to point at, so the marker goes on the line
    // that took its place, or on the last line when it was the tail.
    const at = Math.min(head + start + 1, lines);
    return { from: at, to: at, kind: 'removed' };
  }
  return {
    from: head + start + 1,
    to: head + end + 1,
    kind: deleted ? 'changed' : 'added',
  };
}

/**
 * The longest common subsequence of two line lists, as the runs that are
 * not in it. Quadratic, which is why the caller bounds what it is given.
 */
function runs(was: string[], is: string[], head: number, lines: number): LineChange[] {
  const rows = was.length;
  const columns = is.length;
  const table = new Int32Array((rows + 1) * (columns + 1));
  const cell = (at: number) => table[at] ?? 0;
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const at = row * (columns + 1) + column;
      table[at] =
        was[row] === is[column]
          ? cell(at + columns + 2) + 1
          : Math.max(cell(at + columns + 1), cell(at + 1));
    }
  }
  const out: LineChange[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && was[row] === is[column]) {
      row += 1;
      column += 1;
      continue;
    }
    const fromRow = row;
    const fromColumn = column;
    while (row < rows || column < columns) {
      if (row < rows && column < columns && was[row] === is[column]) break;
      const at = row * (columns + 1) + column;
      // Prefer the deletion when both sides are open, so a replacement
      // reads as one run rather than a delete beside an insert.
      if (row < rows && (column >= columns || cell(at + columns + 1) >= cell(at + 1))) row += 1;
      else column += 1;
    }
    out.push(run(head, fromColumn, column, row > fromRow, column > fromColumn, lines));
  }
  return out;
}
