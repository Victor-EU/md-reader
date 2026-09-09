import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { classifyComment, commentSpans, comments } from './comments.ts';

describe('classifyComment', () => {
  it.each([
    ['<!-- note: hi -->', { kind: 'note', text: 'hi' }],
    ['<!--question:why?-->', { kind: 'question', text: 'why?' }],
    ['<!-- Rewrite: too long -->', { kind: 'rewrite', text: 'too long' }],
    ['<!-- keep:\n  two\n  lines -->', { kind: 'keep', text: 'two\n  lines' }],
    ['<!-- remove: -->', { kind: 'remove', text: '' }],
    ['<!-- attention -->', null],
    ['<!-- todo: x -->', null],
    ['<!-- note: x --> tail', null],
    ['<!-- note x -->', null],
    ['note: bare', null],
  ])('%j', (source, expected) => {
    expect(classifyComment(source)).toEqual(expected);
  });
});

describe('comments', () => {
  it('finds inline and block comments and skips the rest', () => {
    const doc = readFileSync(new URL('../../fixtures/comments.md', import.meta.url), 'utf8');
    const found = comments(parser.parse(doc), doc).map((a) => [
      a.kind,
      a.text,
      a.block,
      doc.slice(a.from, a.to),
    ]);
    expect(found).toEqual([
      ['note', 'inline after text', false, '<!-- note: inline after text -->'],
      [
        'question',
        'on its own line, anchored to the next block',
        true,
        '<!-- question: on its own line, anchored to the next block -->',
      ],
      ['rewrite', 'too long\nspanning lines', true, '<!-- rewrite: too long\nspanning lines -->'],
      ['attention', 'capitalized kind', true, '<!-- Attention: capitalized kind -->'],
      ['remove', 'cut this', false, '<!-- remove: cut this -->'],
    ]);
  });

  it('accepts a CodeMirror-like text source', () => {
    const doc = 'a <!-- keep: b --> c';
    const text = { sliceString: (from: number, to: number) => doc.slice(from, to) };
    expect(comments(parser.parse(doc), text)).toEqual([
      { kind: 'keep', text: 'b', from: 2, to: 18, block: false },
    ]);
  });
});

describe('commentSpans', () => {
  const spans = (doc: string) => commentSpans(parser.parse(doc), doc).map((s) => [s.from, s.to]);
  const hidden = (doc: string) =>
    commentSpans(parser.parse(doc), doc).map((s) => doc.slice(s.from, s.to));

  it('covers every comment, annotation or not', () => {
    expect(hidden('One <!-- note: a --> two <!-- whatever --> three.\n')).toEqual([
      '<!-- note: a -->',
      '<!-- whatever -->',
    ]);
  });

  it('stops at the close mark, not at the end of the block', () => {
    // The parser makes this whole line one CommentBlock, but everything
    // after `-->` is rendered, so it is not hidden.
    const doc = '<!-- note: a --> and then some words.\n';
    expect(spans(doc)).toEqual([[0, 16]]);
    expect(doc.slice(16)).toBe(' and then some words.\n');
  });

  it('leaves a comment inside a fence alone, because the reader is shown it', () => {
    expect(spans('```html\n<!-- note: a -->\n```\n')).toEqual([]);
  });

  it('runs an unterminated comment to the end the parser gave it', () => {
    const doc = 'A\n\n<!-- note: never closed\n';
    const [span] = spans(doc);
    expect(span?.[0]).toBe(3);
    expect(doc.slice(span?.[1] ?? 0)).toBe('');
  });
});
