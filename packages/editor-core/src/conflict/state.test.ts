import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { keepMine, nextConflict, takeTheirs } from './commands.ts';
import {
  addConflicts,
  type ConflictRegion,
  conflictAt,
  conflictRegion,
  conflictState,
  conflicts,
  hasConflicts,
} from './state.ts';

/** A document with the regions raised on it, as an external write does. */
function withConflicts(doc: string, ...regions: ConflictRegion[]): EditorState {
  const base = EditorState.create({ doc, extensions: conflictState });
  return base.update({ effects: addConflicts.of(regions) }).state;
}

/** Run a command against a state and return where it left the document. */
function run(state: EditorState, command: (target: Target) => boolean): EditorState {
  let after = state;
  const handled = command({
    state,
    dispatch: (transaction) => {
      after = transaction.state;
    },
  });
  expect(handled).toBe(true);
  return after;
}

interface Target {
  state: EditorState;
  dispatch: (transaction: Transaction) => void;
}

const where = (state: EditorState) => conflicts(state).map((region) => [region.from, region.to]);

describe('conflict regions', () => {
  it('holds what the merge found, in document order', () => {
    const state = withConflicts(
      'one\ntwo\nthree\n',
      conflictRegion(8, 14, 'THREE\n'),
      conflictRegion(0, 4, 'ONE\n'),
    );
    expect(where(state)).toEqual([
      [0, 4],
      [8, 14],
    ]);
    expect(hasConflicts(state)).toBe(true);
  });

  it('follows its text when something is inserted above it', () => {
    const state = withConflicts('one\ntwo\n', conflictRegion(4, 8, 'TWO\n'));
    const after = state.update({ changes: { from: 0, to: 0, insert: 'new\n' } }).state;
    expect(where(after)).toEqual([[8, 12]]);
  });

  /**
   * The reader goes on editing their side of the argument while it is
   * open, and what they type is part of the version they are keeping.
   */
  it('grows with what the reader types inside it', () => {
    const state = withConflicts('one\ntwo\n', conflictRegion(4, 8, 'TWO\n'));
    const after = state.update({ changes: { from: 7, to: 7, insert: ' more' } }).state;
    expect(where(after)).toEqual([[4, 13]]);
  });

  /** The line after the region is the document's, and taking theirs may not eat it. */
  it('leaves what is typed at the start of the next line outside', () => {
    const state = withConflicts('one\ntwo\nthree\n', conflictRegion(4, 8, 'TWO\n'));
    const after = state.update({ changes: { from: 8, to: 8, insert: 'mine ' } }).state;
    expect(where(after)).toEqual([[4, 8]]);
    expect(
      run(after, (target) => takeTheirs(target, conflicts(after)[0]?.id ?? '')).doc.toString(),
    ).toBe('one\nTWO\nmine three\n');
  });

  it('finds the region a position is in, ends included', () => {
    const state = withConflicts('one\ntwo\nthree\n', conflictRegion(4, 8, 'TWO\n'));
    expect(conflictAt(state, 5)?.theirs).toBe('TWO\n');
    expect(conflictAt(state, 4)?.theirs).toBe('TWO\n');
    expect(conflictAt(state, 8)?.theirs).toBe('TWO\n');
    expect(conflictAt(state, 9)).toBe(null);
  });

  it('steps to the next region and wraps at the end', () => {
    const state = withConflicts(
      'one\ntwo\nthree\n',
      conflictRegion(0, 4, 'ONE\n'),
      conflictRegion(8, 14, 'THREE\n'),
    ).update({ selection: EditorSelection.cursor(0) }).state;
    const second = run(state, nextConflict);
    expect(second.selection.main.head).toBe(8);
    expect(run(second, nextConflict).selection.main.head).toBe(0);
  });
});

describe('settling a conflict', () => {
  const opened = () => withConflicts('one\ntwo\nthree\n', conflictRegion(4, 8, 'TWO\n'));
  const id = (state: EditorState) => conflicts(state)[0]?.id ?? '';

  it('keeps mine without touching a byte of the document', () => {
    const state = opened();
    const after = run(state, (target) => keepMine(target, id(state)));
    expect(after.doc.toString()).toBe('one\ntwo\nthree\n');
    expect(hasConflicts(after)).toBe(false);
  });

  it('takes theirs by replacing our lines with theirs', () => {
    const state = opened();
    const after = run(state, (target) => takeTheirs(target, id(state)));
    expect(after.doc.toString()).toBe('one\nTWO\nthree\n');
    expect(hasConflicts(after)).toBe(false);
  });

  it('moves the region below one that was just settled', () => {
    const state = withConflicts(
      'one\ntwo\nthree\n',
      conflictRegion(0, 4, 'the first line\n'),
      conflictRegion(8, 14, 'THREE\n'),
    );
    const after = run(state, (target) => takeTheirs(target, id(state)));
    expect(after.doc.toString()).toBe('the first line\ntwo\nthree\n');
    expect(where(after)).toEqual([[19, 25]]);
  });

  it('does nothing for a region that is already settled', () => {
    const state = opened();
    const after = run(state, (target) => keepMine(target, id(state)));
    expect(keepMine({ state: after, dispatch: () => undefined }, id(state))).toBe(false);
  });
});

/**
 * A second write while the first is still unsettled. What it covers it
 * supersedes: that offer is a version of the file that is no longer on
 * disk. What it does not cover it leaves, because the merge will not
 * report that hunk again -- by then both sides agree on the base there.
 */
describe('a write that lands on an open question', () => {
  it('replaces an unsettled region it covers and leaves the others', () => {
    const state = withConflicts(
      'one\ntwo\nthree\n',
      conflictRegion(0, 4, 'first\n'),
      conflictRegion(8, 14, 'THREE\n'),
    );
    const after = state.update({
      effects: addConflicts.of([conflictRegion(0, 4, 'FIRST!\n')]),
    }).state;
    expect(conflicts(after).map((region) => region.theirs)).toEqual(['FIRST!\n', 'THREE\n']);
  });

  it('supersedes a region the reader has emptied', () => {
    const state = withConflicts('one\ntwo\nthree\n', conflictRegion(4, 4, 'TWO\n'));
    const after = state.update({
      effects: addConflicts.of([conflictRegion(0, 8, 'both\n')]),
    }).state;
    expect(conflicts(after).map((region) => region.theirs)).toEqual(['both\n']);
  });
});

/**
 * Both choices are undoable, and keeping mine is the reason why. It
 * writes nothing, so without an undo there is no way back to a question
 * the reader has dismissed: their version is already what the buffer
 * says, and theirs would be left only in the history store.
 */
describe('taking a choice back', () => {
  const opened = () =>
    EditorState.create({
      doc: 'one\ntwo\nthree\n',
      extensions: [conflictState, history()],
    }).update({ effects: addConflicts.of([conflictRegion(4, 8, 'TWO\n')]) }).state;
  const id = (state: EditorState) => conflicts(state)[0]?.id ?? '';

  it('brings back a question the reader kept their version of', () => {
    const state = opened();
    const kept = run(state, (target) => keepMine(target, id(state)));
    const back = run(kept, undo);
    expect(conflicts(back).map((region) => region.theirs)).toEqual(['TWO\n']);
    expect(back.doc.toString()).toBe('one\ntwo\nthree\n');
  });

  it('brings back both the text and the question after taking theirs', () => {
    const state = opened();
    const taken = run(state, (target) => takeTheirs(target, id(state)));
    const back = run(taken, undo);
    expect(back.doc.toString()).toBe('one\ntwo\nthree\n');
    expect(where(back)).toEqual([[4, 8]]);
  });

  /** Undoing the write itself takes the question away with the text. */
  it('takes the question away again when the write that raised it is undone', () => {
    const state = EditorState.create({
      doc: 'one\ntwo\n',
      extensions: [conflictState, history()],
    });
    const written = state.update({
      changes: { from: 0, to: 3, insert: 'ONE' },
      effects: addConflicts.of([conflictRegion(4, 8, 'TWO\n')]),
    }).state;
    expect(hasConflicts(written)).toBe(true);
    const back = run(written, undo);
    expect(back.doc.toString()).toBe('one\ntwo\n');
    expect(hasConflicts(back)).toBe(false);
  });
});

/**
 * The conflicting rows of the merge cases table (design section 10),
 * carried on from the Rust side where the same inputs prove that these
 * are the hunks `merge3` returns for them. Here they say what the two
 * choices do with one: keeping mine leaves the buffer alone, and taking
 * theirs puts the file back as it stands on disk.
 */
interface Case {
  name: string;
  /** The buffer, with their non-conflicting hunks already merged in. */
  ours: string;
  /** What precedes the conflicting hunk in `ours`, and the hunk itself. */
  before: string;
  mine: string;
  theirs: string;
  /** What the file says, which is what taking theirs has to produce. */
  taken: string;
}

const CASES: Case[] = [
  {
    name: 'adjacent edits',
    ours: 'a\nBBB\nc\nd\n',
    before: 'a\n',
    mine: 'BBB\nc\n',
    theirs: 'b\nCCC\n',
    taken: 'a\nb\nCCC\nd\n',
  },
  {
    name: 'whitespace only, on the line we are editing',
    ours: 'a\nb edited\nc\n',
    before: 'a\n',
    mine: 'b edited\n',
    theirs: 'b \n',
    taken: 'a\nb \nc\n',
  },
  {
    name: 'a full rewrite',
    ours: 'a\nb edited\nc\n',
    before: '',
    mine: 'a\nb edited\nc\n',
    theirs: 'completely\ndifferent\ntext\n',
    taken: 'completely\ndifferent\ntext\n',
  },
  {
    name: 'they deleted the region we are editing',
    ours: 'a\nb\nC edited\nd\n',
    before: 'a\n',
    mine: 'b\nC edited\n',
    theirs: '',
    taken: 'a\nd\n',
  },
];

describe('the merge cases, settled', () => {
  for (const testCase of CASES) {
    const { name, ours, before, mine, theirs, taken } = testCase;
    const open = () =>
      withConflicts(ours, conflictRegion(before.length, before.length + mine.length, theirs));

    it(`${name}: the hunk is where the fixture says it is`, () => {
      expect(ours.startsWith(before + mine)).toBe(true);
      expect(before + theirs + ours.slice(before.length + mine.length)).toBe(taken);
    });

    it(`${name}: keeping mine writes nothing`, () => {
      const state = open();
      const after = run(state, (target) => keepMine(target, conflicts(state)[0]?.id ?? ''));
      expect(after.doc.toString()).toBe(ours);
    });

    it(`${name}: taking theirs gives the file as it stands`, () => {
      const state = open();
      const after = run(state, (target) => takeTheirs(target, conflicts(state)[0]?.id ?? ''));
      expect(after.doc.toString()).toBe(taken);
    });
  }
});
