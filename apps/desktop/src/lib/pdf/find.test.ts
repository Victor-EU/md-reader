import { describe, expect, it } from 'vitest';
import type { TextRun } from './engine.ts';
import { hitsInPage, pageString, queryRegExp, stepHit } from './find.ts';

/**
 * The part of Find over a PDF that has no DOM in it (ADR 0035).
 *
 * A page is a list of runs, each a few characters and a rectangle, in
 * the order the file draws them — so a match can begin in one run and
 * end three runs later, which is the whole reason this is not a search
 * over a buffer.
 */

const run = (text: string): TextRun => ({ text, rect: [0, 0, 10, 10] });

function page(...texts: string[]): TextRun[] {
  return texts.map(run);
}

describe('a page as one string', () => {
  it('remembers where every run began', () => {
    expect(pageString(page('Hello', ' ', 'world'))).toEqual({
      text: 'Hello world',
      starts: [0, 5, 6],
    });
  });

  it('is empty for a page with nothing on it', () => {
    expect(pageString([])).toEqual({ text: '', starts: [] });
  });
});

describe('the query', () => {
  it('is literal unless the reader ticks the box', () => {
    expect(queryRegExp('a.c')?.test('abc')).toBe(false);
    expect(queryRegExp('a.c')?.test('a.c')).toBe(true);
    expect(queryRegExp('a.c', { regexp: true })?.test('abc')).toBe(true);
  });

  it('ignores case unless asked not to', () => {
    expect(queryRegExp('HELLO')?.test('hello')).toBe(true);
    expect(queryRegExp('HELLO', { caseSensitive: true })?.test('hello')).toBe(false);
  });

  it('is nothing at all when it cannot be a pattern', () => {
    // Which is what the reader has while they are still typing one.
    expect(queryRegExp('(', { regexp: true })).toBeNull();
    expect(queryRegExp('')).toBeNull();
  });
});

describe('matching a page', () => {
  it('says where in a run the match begins and ends', () => {
    const pattern = queryRegExp('quick');
    expect(hitsInPage(page('The quick fox'), 1, pattern as RegExp)).toEqual([
      { page: 1, from: 0, to: 1, head: 4, tail: 9 },
    ]);
  });

  it('finds a match that begins in one run and ends in another', () => {
    const pattern = queryRegExp('lo wo');
    expect(pattern).not.toBeNull();
    expect(hitsInPage(page('Hel', 'lo ', 'wor', 'ld'), 3, pattern as RegExp)).toEqual([
      // Two characters into run 1, two characters into run 2: enough to
      // mark the letters rather than the three runs they lie across.
      { page: 3, from: 1, to: 3, head: 0, tail: 2 },
    ]);
  });

  it('finds every match, not only the first', () => {
    const pattern = queryRegExp('the');
    expect(hitsInPage(page('the cat and the hat'), 1, pattern as RegExp).length).toBe(2);
  });

  it('respects whole word', () => {
    const literal = queryRegExp('cat');
    const whole = queryRegExp('cat', { wholeWord: true });
    expect(hitsInPage(page('a cat, a catalogue'), 1, literal as RegExp).length).toBe(2);
    expect(hitsInPage(page('a cat, a catalogue'), 1, whole as RegExp).length).toBe(1);
  });

  it('does not hang on a pattern that matches nothing at all', () => {
    // `a*` matches the empty string at every position, so a walk that
    // did not move on after a zero-width match would never reach the
    // end of the page. Five for four characters: one before each and
    // one after the last.
    const pattern = queryRegExp('a*', { regexp: true });
    const hits = hitsInPage(page('bbbb'), 1, pattern as RegExp);
    expect(hits.length).toBe(5);
  });

  it('finds nothing on a page with nothing on it', () => {
    expect(hitsInPage([], 1, queryRegExp('x') as RegExp)).toEqual([]);
  });
});

describe('stepping through the matches', () => {
  const at = (page: number) => ({ page, from: 0, to: 1, head: 0, tail: 1 });
  const hits = [at(1), at(4), at(9)];

  it('starts from the page the reader is looking at', () => {
    expect(stepHit(hits, -1, 3, true)).toBe(1);
    expect(stepHit(hits, -1, 5, false)).toBe(1);
  });

  it('goes on from wherever it got to, and wraps', () => {
    expect(stepHit(hits, 0, 1, true)).toBe(1);
    expect(stepHit(hits, 2, 9, true)).toBe(0);
    expect(stepHit(hits, 0, 1, false)).toBe(2);
  });

  it('takes the first from a page past the last match', () => {
    expect(stepHit(hits, -1, 20, true)).toBe(0);
    expect(stepHit(hits, -1, 1, false)).toBe(0);
  });

  it('has nothing to say when nothing matched', () => {
    expect(stepHit([], -1, 1, true)).toBe(-1);
  });
});
