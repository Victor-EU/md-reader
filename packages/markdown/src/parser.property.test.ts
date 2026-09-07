import { TreeFragment } from '@lezer/common';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parser } from './parser.ts';
import { assertWellFormed } from './test-helpers.ts';
import { dumpTree } from './tree.ts';

/**
 * Design 5.2: the parser must never fail. Two generators: raw strings up
 * to 4 KB, and a soup of the dialect's own tokens, which reaches the
 * extension code paths far more often than uniform noise does.
 */
const tokens = [
  '$$',
  '$',
  '==',
  '=',
  '>',
  '> ',
  '[!note]',
  '[!note]-',
  '[!',
  ']',
  '-',
  '+',
  '---',
  '...',
  '```',
  '~~',
  '*',
  '_',
  '`',
  '<!--',
  '-->',
  '<!-- note: x -->',
  '|',
  '\n',
  '\n\n',
  ' ',
  '  ',
  '    ',
  'word',
  'x',
  '5',
  '\\',
  '\r\n',
  '#',
  '# ',
  '1. ',
  '- ',
  '[ ] ',
  '[x] ',
  '\t',
  'é',
  '日本',
  '[',
  ']',
  '(',
  ')',
  '<',
  '&amp;',
];
const soup = fc.array(fc.constantFrom(...tokens), { maxLength: 300 }).map((a) => a.join(''));
const noise = fc.string({ unit: 'binary', maxLength: 4096 });
/** Raise locally with FC_RUNS=5000 to hunt for rare cases; CI uses the default. */
const numRuns = Number(process.env.FC_RUNS ?? 400);

describe('parser properties', () => {
  it('never throws and always builds a well-formed tree', () => {
    fc.assert(
      fc.property(fc.oneof(soup, noise), (doc) => {
        assertWellFormed(parser.parse(doc), doc);
      }),
      { numRuns },
    );
  });

  it('parses incrementally to the same tree as from scratch', () => {
    const edit = fc.record({
      doc: soup,
      at: fc.double({ min: 0, max: 1, noNaN: true }),
      remove: fc.nat({ max: 12 }),
      insert: fc.array(fc.constantFrom(...tokens), { maxLength: 3 }).map((a) => a.join('')),
    });
    fc.assert(
      fc.property(edit, ({ doc, at, remove, insert }) => {
        const fromA = Math.floor(at * doc.length);
        const toA = Math.min(doc.length, fromA + remove);
        const next = doc.slice(0, fromA) + insert + doc.slice(toA);
        const before = parser.parse(doc);
        const fragments = TreeFragment.applyChanges(TreeFragment.addTree(before), [
          { fromA, toA, fromB: fromA, toB: fromA + insert.length },
        ]);
        const incremental = parser.parse(next, fragments);
        assertWellFormed(incremental, next);
        expect(dumpTree(incremental, next)).toBe(dumpTree(parser.parse(next), next));
      }),
      { numRuns },
    );
  });
});
