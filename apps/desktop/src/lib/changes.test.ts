import { Text } from '@codemirror/state';
import { fakeAlign } from '@mdreader/ipc/fake';
import { flattenBlocks, parser } from '@mdreader/markdown';
import { describe, expect, it } from 'vitest';
import { blockChanges } from './changes.ts';

function blocks(text: string) {
  return flattenBlocks(parser.parse(text), text);
}

/**
 * What the shell does end to end, with the fake's alignment standing in
 * for Rust's: flatten both sides, align them, turn that into runs. The
 * fake pairs by position and finds no moves, so the cases here are the
 * ones the mapping decides rather than the ones the engine does.
 */
function runs(before: string, after: string) {
  const old = blocks(before);
  const fresh = blocks(after);
  return blockChanges(fakeAlign(old, fresh), fresh, Text.of(after.split('\n')));
}

describe('blockChanges', () => {
  it('says nothing about a document that has not changed', () => {
    expect(runs('one\n\ntwo\n', 'one\n\ntwo\n')).toEqual([]);
  });

  it('marks every line of a changed block', () => {
    expect(runs('one\n\nthe cat\nsat down\n', 'one\n\nthe cat\nstood up\n')).toEqual([
      { from: 3, to: 5, kind: 'changed' },
    ]);
  });

  it('marks an inserted block as added', () => {
    expect(runs('one\n', 'one\n\ntwo\n')).toEqual([{ from: 3, to: 4, kind: 'added' }]);
  });

  /** Nothing of it is left to draw beside, so it is a notch on what closed over it. */
  it('puts a deletion on the line that took its place', () => {
    expect(runs('one\n\ntwo\n\nthree\n', 'one\n\nthree\n')).toEqual([
      { from: 3, to: 3, kind: 'removed' },
    ]);
  });

  it('puts a deletion at the end of the document when it was the last block', () => {
    expect(runs('one\n\ntwo\n', 'one\n')).toEqual([{ from: 2, to: 2, kind: 'removed' }]);
  });

  /**
   * A block gone and another arrived in its place is one thing having
   * happened, and the mark on what arrived already says it.
   */
  it('does not draw a notch where something took the deleted block’s place', () => {
    const ops = [
      { op: 'deleted' as const, old: 1 },
      { op: 'inserted' as const, new: 1 },
    ];
    const after = 'one\n\ntwo\n';
    expect(blockChanges(ops, blocks(after), Text.of(after.split('\n')))).toEqual([
      { from: 3, to: 4, kind: 'added' },
    ]);
  });

  it('draws a block that arrived from elsewhere as a move', () => {
    const after = 'one\n\ntwo\n';
    const ops = [
      { op: 'moved' as const, old: 3, new: 0 },
      { op: 'equal' as const, old: 0, new: 1 },
    ];
    expect(blockChanges(ops, blocks(after), Text.of(after.split('\n')))).toEqual([
      { from: 1, to: 2, kind: 'moved' },
    ]);
  });

  it('joins two runs of the same kind that touch', () => {
    expect(runs('- one\n- two\n', '- ONE\n- TWO\n')).toEqual([{ from: 1, to: 3, kind: 'changed' }]);
  });

  /** A line neither of them touched is what keeps two changes two. */
  it('keeps two runs apart when there is an untouched line between them', () => {
    expect(runs('one\n\ntwo\n', 'ONE\n\nTWO\n')).toEqual([
      { from: 1, to: 2, kind: 'changed' },
      { from: 3, to: 4, kind: 'changed' },
    ]);
  });

  it('keeps two runs of different kinds apart', () => {
    expect(runs('one\n\ntwo\n\nthree\n', 'ONE\n\ntwo\n\nthree\n\nfour\n')).toEqual([
      { from: 1, to: 2, kind: 'changed' },
      { from: 7, to: 8, kind: 'added' },
    ]);
  });

  it('is silent about a paragraph that was only rewrapped', () => {
    expect(runs('one two three four five\n', 'one two\nthree four\nfive\n')).toEqual([]);
  });
});
