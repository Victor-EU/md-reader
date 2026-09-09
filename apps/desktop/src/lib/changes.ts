import type { Text } from '@codemirror/state';
import type { LineChange } from '@mdreader/editor-core';
import type { BlockOp } from '@mdreader/ipc';
import type { DocBlock } from '@mdreader/markdown';

/**
 * The alignment of two block lists, as the runs of lines the gutter
 * draws (design 4.4, plan WP 2.2).
 *
 * The engine answers in blocks, because that is the unit a reader means
 * by "this changed". The margin draws lines, because that is what a
 * document is made of on the screen. This is the one place the two meet.
 *
 * The ops arrive in the order the two documents read, which is what lets
 * a deletion — the one kind with nothing left in the buffer to point at
 * — be placed: it belongs on whatever line closed over it, and that is
 * the next block on the new side.
 */
export function blockChanges(
  ops: readonly BlockOp[],
  fresh: readonly DocBlock[],
  doc: Text,
): LineChange[] {
  const runs: LineChange[] = [];
  const lineOf = (at: number) => doc.lineAt(Math.max(0, Math.min(at, doc.length))).number;
  const mark = (index: number, kind: LineChange['kind']): void => {
    const block = fresh[index];
    if (!block) return;
    runs.push({
      from: lineOf(block.from),
      to: lineOf(Math.max(block.to - 1, block.from)) + 1,
      kind,
    });
  };
  // A deletion waits to find out whether anything took its place.
  // Where something did, that something is already marked, and a second
  // mark on the same line would say the same thing twice.
  let deleted = false;
  for (const op of ops) {
    switch (op.op) {
      case 'deleted':
        deleted = true;
        continue;
      case 'equal':
        if (deleted) {
          const at = lineOf(fresh[op.new]?.from ?? doc.length);
          runs.push({ from: at, to: at, kind: 'removed' });
        }
        break;
      case 'changed':
        mark(op.new, 'changed');
        break;
      case 'moved':
        mark(op.new, 'moved');
        break;
      case 'inserted':
        mark(op.new, 'added');
        break;
    }
    deleted = false;
  }
  if (deleted) {
    // It was the last thing in the document, so the notch goes at the end.
    const at = doc.lines;
    runs.push({ from: at, to: at, kind: 'removed' });
  }
  return merge(runs);
}

/**
 * Runs of the same kind with no untouched line between them are one run.
 * The blocks under them are separate paragraphs; what the reader is
 * being told is that this part of the document changed.
 */
function merge(runs: LineChange[]): LineChange[] {
  const sorted = [...runs].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: LineChange[] = [];
  for (const run of sorted) {
    const last = out[out.length - 1];
    if (last && last.kind === run.kind && run.from <= last.to) {
      last.to = Math.max(last.to, run.to);
      continue;
    }
    out.push({ ...run });
  }
  return out;
}
