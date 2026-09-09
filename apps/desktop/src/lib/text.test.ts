import { describe, expect, it } from 'vitest';
import { countWords, describeError, describeFormat } from './text.ts';

describe('countWords', () => {
  it('counts words, not punctuation', () => {
    expect(countWords('# A heading, with **emphasis**.')).toBe(4);
    expect(countWords('')).toBe(0);
    expect(countWords('one-two three’s four_five')).toBe(3);
  });

  it('counts CJK per character', () => {
    expect(countWords('日本語 text')).toBe(4);
  });

  it('does not count what the reader is never shown', () => {
    const doc = 'One two <!-- note: three four five --> six.\n';
    expect(countWords(doc)).toBe(7);
    // One, two, six: the note is not part of what was written.
    expect(countWords(doc, [{ from: 8, to: 38 }])).toBe(3);
  });

  it('counts a word that only touches a span', () => {
    // `to` is exclusive, so a word starting where a span ends is text.
    expect(countWords('aa bb', [{ from: 0, to: 3 }])).toBe(1);
    expect(countWords('aa bb', [{ from: 0, to: 2 }])).toBe(1);
  });

  it('walks several spans in order', () => {
    const doc = 'a <!-- x --> b <!-- y --> c';
    expect(
      countWords(doc, [
        { from: 2, to: 12 },
        { from: 15, to: 25 },
      ]),
    ).toBe(3);
  });
});

describe('describeFormat', () => {
  it('reads as the status bar shows it', () => {
    expect(
      describeFormat({
        eol: 'crlf',
        mixed_eol: true,
        bom: true,
        trailing_newline: true,
        encoding: 'utf-8',
      }),
    ).toBe('UTF-8 BOM · CRLF (mixed)');
  });
});

describe('describeError', () => {
  it('turns each error kind into a line', () => {
    expect(
      describeError({ kind: 'hash_mismatch', path: '/a.md', expected: '1', actual: '2' }),
    ).toBe('/a.md changed on disk; reload before saving');
    expect(describeError({ kind: 'read', path: '/a.md', message: 'No such file' })).toBe(
      'No such file',
    );
  });
});
