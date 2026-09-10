import { ChangeSet, Text } from '@codemirror/state';
import type { ChangeRecord } from '@markdown/editor-core';
import type { BlockOp } from '@markdown/ipc';
import { fakeAlign } from '@markdown/ipc/fake';
import { flattenBlocks, parser } from '@markdown/markdown';
import { describe, expect, it } from 'vitest';
import { blockChanges, type Side, shorten, tracked } from './changes.ts';

function side(source: string): Side {
  return { blocks: flattenBlocks(parser.parse(source), source), text: Text.of(source.split('\n')) };
}

/**
 * What the shell does end to end, with the fake's alignment standing in
 * for Rust's: flatten both sides, align them, turn that into records.
 * The fake pairs by position and finds no moves, so the cases here are
 * the ones the mapping decides rather than the ones the engine does.
 */
function records(before: string, after: string): ChangeRecord[] {
  const old = side(before);
  const fresh = side(after);
  return blockChanges(fakeAlign([...old.blocks], [...fresh.blocks]), old, fresh);
}

/** The records as the runs the margin draws, which is what they were before. */
function runs(before: string, after: string) {
  return records(before, after).map((record) => ({
    kind: record.kind,
    from: record.from,
    to: record.to,
  }));
}

/**
 * Revert every change, one transaction at a time and mapping what is
 * left through each, exactly as the editor does. Putting all of them
 * back has to give the document they were measured against.
 */
function reverted(before: string, after: string, ops?: readonly BlockOp[]): string {
  const old = side(before);
  const fresh = side(after);
  const all = blockChanges(ops ?? fakeAlign([...old.blocks], [...fresh.blocks]), old, fresh);
  let doc = fresh.text;
  let mapping: ChangeSet | null = null;
  for (const record of all) {
    const edits = [...record.revert]
      .map((edit) =>
        mapping === null
          ? edit
          : {
              from: mapping.mapPos(edit.from, -1),
              to: Math.max(mapping.mapPos(edit.from, -1), mapping.mapPos(edit.to, -1)),
              insert: edit.insert,
            },
      )
      .sort((a, b) => a.from - b.from);
    const set = ChangeSet.of(edits, doc.length);
    doc = set.apply(doc);
    mapping = mapping === null ? set : mapping.compose(set);
  }
  return doc.toString();
}

describe('blockChanges', () => {
  it('says nothing about a document that has not changed', () => {
    expect(records('one\n\ntwo\n', 'one\n\ntwo\n')).toEqual([]);
  });

  it('covers the whole of a changed block', () => {
    expect(runs('one\n\nthe cat\nsat down\n', 'one\n\nthe cat\nstood up\n')).toEqual([
      { kind: 'changed', from: 5, to: 21 },
    ]);
  });

  it('marks an inserted block as added', () => {
    expect(runs('one\n', 'one\n\ntwo\n')).toEqual([{ kind: 'added', from: 5, to: 8 }]);
  });

  /** Nothing of it is left to point at, so it sits on what closed over it. */
  it('puts a deletion at the start of the block that took its place', () => {
    expect(runs('one\n\ntwo\n\nthree\n', 'one\n\nthree\n')).toEqual([
      { kind: 'removed', from: 5, to: 5 },
    ]);
  });

  it('puts a deletion at the end of the document when it was the last block', () => {
    expect(runs('one\n\ntwo\n', 'one\n')).toEqual([{ kind: 'removed', from: 4, to: 4 }]);
  });

  /**
   * A block gone and another arrived in its place is one thing having
   * happened: a rewrite, told as one change with both versions in it.
   */
  it('tells a block replaced by another as one change', () => {
    const after = 'one\n\ntwo\n';
    const ops: BlockOp[] = [
      { op: 'equal', old: 0, new: 0 },
      { op: 'deleted', old: 1 },
      { op: 'inserted', new: 1 },
    ];
    const found = blockChanges(ops, side('one\n\nold\n'), side(after));
    expect(found.map((record) => record.kind)).toEqual(['changed']);
    expect(found[0]?.parts).toEqual([
      { kind: 'gone', text: 'old' },
      { kind: 'new', text: 'two' },
    ]);
  });

  it('draws a block that arrived from elsewhere as a move', () => {
    const before = 'one\n\ntwo\n\nthree\n';
    const after = 'three\n\none\n\ntwo\n';
    const ops: BlockOp[] = [
      { op: 'moved', old: 2, new: 0 },
      { op: 'equal', old: 0, new: 1 },
      { op: 'equal', old: 1, new: 2 },
    ];
    const found = blockChanges(ops, side(before), side(after));
    expect(found.map((record) => record.kind)).toEqual(['moved']);
    expect(reverted(before, after, ops)).toBe(before);
  });

  /**
   * A section that moved is one thing that happened. Four panels and
   * four Revert buttons for one movement is the block granularity
   * showing through where the reader should not have to see it.
   */
  it('tells a run of blocks that moved together as one move', () => {
    const before = 'one\n\ntwo\n\nthree\n\nfour\n';
    const after = 'three\n\nfour\n\none\n\ntwo\n';
    const ops: BlockOp[] = [
      { op: 'moved', old: 2, new: 0 },
      { op: 'moved', old: 3, new: 1 },
      { op: 'equal', old: 0, new: 2 },
      { op: 'equal', old: 1, new: 3 },
    ];
    const found = blockChanges(ops, side(before), side(after));
    expect(found.map((record) => record.kind)).toEqual(['moved']);
    expect(reverted(before, after, ops)).toBe(before);
  });

  /** Two blocks that were not beside each other are two moves. */
  it('keeps two unrelated blocks that arrived together as two moves', () => {
    const before = 'one\n\ntwo\n\nthree\n\nfour\n';
    const after = 'two\n\nfour\n\none\n\nthree\n';
    const ops: BlockOp[] = [
      { op: 'moved', old: 1, new: 0 },
      { op: 'moved', old: 3, new: 1 },
      { op: 'equal', old: 0, new: 2 },
      { op: 'equal', old: 2, new: 3 },
    ];
    const found = blockChanges(ops, side(before), side(after));
    expect(found.map((record) => record.kind)).toEqual(['moved', 'moved']);
    expect(reverted(before, after, ops)).toBe(before);
  });

  /** The text is in the buffer under the panel; saying it twice is noise. */
  it('gives an addition no body of its own', () => {
    const found = records('one\n', 'one\n\ntwo\n');
    expect(found[0]?.parts).toEqual([]);
  });

  /** Two list items are two things that happened, however they are drawn. */
  it('keeps two changed list items as two records', () => {
    expect(runs('- one\n- two\n', '- ONE\n- TWO\n')).toEqual([
      { kind: 'changed', from: 2, to: 5 },
      { kind: 'changed', from: 8, to: 11 },
    ]);
  });

  it('is silent about a paragraph that was only rewrapped', () => {
    expect(records('one two three four five\n', 'one two\nthree four\nfive\n')).toEqual([]);
  });
});

/**
 * The other half of a change record: putting it back. Every case here
 * reverts everything and asks for the document it started from, because
 * that is the promise — a change the reader did not want leaves no trace
 * of having been offered.
 */
describe('reverting', () => {
  it('puts a changed paragraph back word for word', () => {
    expect(reverted('one\n\nthe cat sat\n', 'one\n\nthe cat stood\n')).toBe('one\n\nthe cat sat\n');
  });

  it('takes an added block out with the blank line it brought', () => {
    expect(reverted('one\n', 'one\n\ntwo\n')).toBe('one\n');
  });

  it('takes an added first block out', () => {
    expect(reverted('two\n', 'one\n\ntwo\n')).toBe('two\n');
  });

  it('puts a deleted block back between its neighbours', () => {
    expect(reverted('one\n\ntwo\n\nthree\n', 'one\n\nthree\n')).toBe('one\n\ntwo\n\nthree\n');
  });

  it('puts a deleted first block back at the head of the document', () => {
    expect(reverted('one\n\ntwo\n', 'two\n')).toBe('one\n\ntwo\n');
  });

  it('puts a deleted last block back at the end', () => {
    expect(reverted('one\n\ntwo\n', 'one\n')).toBe('one\n\ntwo\n');
  });

  /** A list item is its marker too, which the block's own range is not. */
  it('takes an added list item out with its marker', () => {
    expect(reverted('- one\n- three\n', '- one\n- two\n- three\n')).toBe('- one\n- three\n');
  });

  it('puts a deleted list item back with its marker', () => {
    expect(reverted('- one\n- two\n- three\n', '- one\n- three\n')).toBe('- one\n- two\n- three\n');
  });

  it('puts several changes back at once', () => {
    expect(reverted('one\n\ntwo\n\nthree\n', 'ONE\n\ntwo\n\nTHREE\n\nfour\n')).toBe(
      'one\n\ntwo\n\nthree\n',
    );
  });
});

describe('tracked', () => {
  it('reads as the words that went and the words that came', () => {
    expect(
      tracked('the quick brown fox', 'the quick red fox', [
        { old_from: 10, old_to: 15, new_from: 10, new_to: 13 },
      ]),
    ).toEqual([
      { kind: 'same', text: 'the quick ' },
      { kind: 'gone', text: 'brown' },
      { kind: 'new', text: 'red' },
      { kind: 'same', text: ' fox' },
    ]);
  });

  it('shows a word that was only taken out', () => {
    expect(
      tracked('the quick fox', 'the fox', [{ old_from: 4, old_to: 9, new_from: 4, new_to: 4 }]),
    ).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'gone', text: 'quick' },
      { kind: 'same', text: 'fox' },
    ]);
  });

  it('says nothing about two blocks with no run between them', () => {
    expect(tracked('same', 'same', [])).toEqual([{ kind: 'same', text: 'same' }]);
  });
});

describe('shorten', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('leaves a short change as it is', () => {
    const parts = [{ kind: 'same' as const, text: 'a b c' }];
    expect(shorten(parts)).toEqual(parts);
  });

  it('gives up the middle of a long untouched run', () => {
    const found = shorten([
      { kind: 'same', text: many(40) },
      { kind: 'new', text: 'here' },
      { kind: 'same', text: many(40) },
    ]);
    expect(found.map((part) => part.kind)).toEqual(['gap', 'same', 'new', 'same', 'gap']);
    // The words nearest the change are the ones that survive.
    expect(found[1]?.text).toBe('w34 w35 w36 w37 w38 w39');
    expect(found[3]?.text).toBe('w0 w1 w2 w3 w4 w5');
  });

  it('cuts a very long run of removed text short', () => {
    const found = shorten([{ kind: 'gone', text: many(200) }]);
    expect(found.map((part) => part.kind)).toEqual(['gone', 'gap']);
    expect(found[0]?.text.split(' ')).toHaveLength(60);
  });
});
