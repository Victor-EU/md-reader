import { describe, expect, it } from 'vitest';
import { pairTags, parseTag } from './whitelist.ts';

/** The one pairing rule Read mode, Edit mode, and the extractor all share. */
function pairs(source: string): (number | null)[] {
  return pairTags(source.split(' ').map((tag) => parseTag(tag)));
}

describe('pairTags', () => {
  it.each([
    ['<mark> </mark>', [1, null]],
    ['<mark> <sup> </sup> </mark>', [3, 2, null, null]],
    // A close for something opened outside ends that and abandons what
    // was opened inside, which is why the crossed pair renders as it does.
    ['<mark> <sup> </mark> </sup>', [2, null, null, null]],
    ['</mark> <mark> </mark>', [null, 2, null]],
    ['<mark> <br> </mark>', [2, null, null]],
    ['<mark> <mark> </mark> </mark>', [3, 2, null, null]],
    ['<mark> hello', [null, null]],
  ])('%s', (source, expected) => {
    expect(pairs(source)).toEqual(expected);
  });
});
