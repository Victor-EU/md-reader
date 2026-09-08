import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { type LineChange, lineChanges } from './lines.ts';

const text = (source: string) => Text.of(source.split('\n'));
const changes = (before: string, after: string): LineChange[] =>
  lineChanges(text(before), text(after));

describe('lineChanges', () => {
  it('finds nothing in a document that did not change', () => {
    expect(changes('one\ntwo\n', 'one\ntwo\n')).toEqual([]);
    const same = text('one\ntwo\n');
    expect(lineChanges(same, same)).toEqual([]);
  });

  it('marks a changed line', () => {
    expect(changes('one\ntwo\nthree\n', 'one\nTWO\nthree\n')).toEqual([
      { from: 2, to: 3, kind: 'changed' },
    ]);
  });

  it('marks added lines over the lines that are new', () => {
    expect(changes('one\ntwo\n', 'one\nnew\nalso new\ntwo\n')).toEqual([
      { from: 2, to: 4, kind: 'added' },
    ]);
  });

  it('marks a deletion at the line that closed over it', () => {
    expect(changes('one\ntwo\nthree\nfour\n', 'one\nfour\n')).toEqual([
      { from: 2, to: 2, kind: 'removed' },
    ]);
  });

  it('marks a deletion at the end on the last line', () => {
    const found = changes('one\ntwo\nthree\n', 'one\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('removed');
    expect(found[0]?.from).toBeLessThanOrEqual(text('one\n').lines);
  });

  it('keeps separate changes separate', () => {
    expect(changes('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n')).toEqual([
      { from: 1, to: 2, kind: 'changed' },
      { from: 5, to: 6, kind: 'changed' },
    ]);
  });

  it('reads a replacement as one run, not a delete beside an insert', () => {
    expect(changes('a\nold one\nold two\nb\n', 'a\nnew\nb\n')).toEqual([
      { from: 2, to: 3, kind: 'changed' },
    ]);
  });

  /**
   * The lines a document shares at its ends are matched off before the
   * diff, so a change at the end of a long file costs what the change
   * costs. Without that this test would run a diff of ten thousand lines
   * by ten thousand lines.
   */
  it('finds a change at the end of a long document', () => {
    const body = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n');
    expect(changes(`${body}\nlast\n`, `${body}\nLAST\n`)).toEqual([
      { from: 10_001, to: 10_002, kind: 'changed' },
    ]);
  });

  /**
   * A document with nothing in common with its old self is one change to
   * a reader, whatever a line diff would say about it.
   */
  it('calls a rewrite past the limit a single change', () => {
    const before = Array.from({ length: 3_000 }, (_, i) => `was ${i}`).join('\n');
    const after = Array.from({ length: 3_000 }, (_, i) => `is ${i}`).join('\n');
    expect(changes(before, after)).toEqual([{ from: 1, to: 3_001, kind: 'changed' }]);
  });

  it('marks an empty document filled in as added', () => {
    expect(changes('', 'one\ntwo\n')).toEqual([{ from: 1, to: 3, kind: 'added' }]);
  });
});
