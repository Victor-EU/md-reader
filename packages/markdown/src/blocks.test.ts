import { describe, expect, it } from 'vitest';
import { commonBlocks, type DocBlock, flattenBlocks } from './blocks.ts';
import { corpusFiles } from './corpus.ts';
import { parser } from './parser.ts';

function blocks(text: string): DocBlock[] {
  return flattenBlocks(parser.parse(text), text);
}

/** What a block is, as a pair, which is what the alignment compares. */
function shown(text: string): [string, string][] {
  return blocks(text).map((block) => [block.kind, block.text]);
}

describe('flattenBlocks', () => {
  it('reports one block per leaf, in document order', () => {
    expect(shown('# Title\n\nOne.\n\nTwo.\n')).toEqual([
      ['heading1', '# Title'],
      ['paragraph', 'One.'],
      ['paragraph', 'Two.'],
    ]);
  });

  it('gives every block the containers it sits in', () => {
    expect(shown('- one\n  - two\n\n> quoted\n\n| a |\n| - |\n')).toEqual([
      ['list>item>paragraph', 'one'],
      ['list>item>list>item>paragraph', 'two'],
      ['quote>paragraph', 'quoted'],
      ['table>table_row', '| a |'],
      ['table>table_row', '| - |'],
    ]);
  });

  it('points at the source it came from', () => {
    const text = '# Title\n\nOne.\n';
    expect(blocks(text).map((block) => text.slice(block.from, block.to))).toEqual([
      '# Title',
      'One.',
    ]);
  });

  // The case design 7.3 exists for: an agent that reflows a document to
  // eighty columns has changed every line and said nothing different.
  it('does not see a rewrap', () => {
    const wide = 'One two three four five six seven.\n';
    const narrow = 'One two three\nfour five six\nseven.\n';
    expect(shown(narrow)).toEqual(shown(wide));
  });

  it('does not see a list renumbered, and does see it turned into bullets', () => {
    expect(shown('1. one\n2. two\n')).toEqual(shown('1. one\n1. two\n'));
    expect(shown('1. one\n')).not.toEqual(shown('- one\n'));
  });

  it('keeps the quote marks off the text and the quote in the kind', () => {
    expect(shown('> one\n> two\n')).toEqual([['quote>paragraph', 'one two']]);
    expect(shown('> > deep\n')).toEqual([['quote>quote>paragraph', 'deep']]);
  });

  it('keeps every space inside a fenced block, because they are the program', () => {
    expect(shown('```py\nif x:\n    go()\n```\n')).toEqual([
      ['code', '```py\nif x:\n    go()\n```'],
    ]);
  });

  it('keeps a fenced block inside a list item verbatim too', () => {
    expect(shown('- one\n\n  ```py\n  if x:\n      go()\n  ```\n')).toEqual([
      ['list>item>paragraph', 'one'],
      ['list>item>code', '```py\n  if x:\n      go()\n  ```'],
    ]);
  });

  it('reports a construct it has no name for rather than dropping it', () => {
    expect(shown('---\ntitle: x\n---\n\n<div>\nhi\n</div>\n\n***\n')).toEqual([
      ['frontmatter', '---\ntitle: x\n---'],
      ['html', '<div>\nhi\n</div>'],
      ['rule', '***'],
    ]);
  });

  it('sees a checkbox ticked', () => {
    expect(shown('- [ ] todo\n')).not.toEqual(shown('- [x] todo\n'));
  });

  /**
   * The blocks have to tile the document for a change tracker to be able
   * to promise that what it does not mark did not change. What falls
   * between two of them is blank lines and the marks that make the
   * structure; nothing else may.
   */
  it('walks the corpus with the blocks in order and inside the document', () => {
    for (const file of corpusFiles(50)) {
      let at = 0;
      for (const block of blocks(file.text)) {
        expect([file.name, block.from]).toEqual([file.name, Math.max(at, block.from)]);
        expect(block.to).toBeGreaterThanOrEqual(block.from);
        expect(block.to).toBeLessThanOrEqual(file.text.length);
        at = block.to;
      }
    }
  });
});

describe('commonBlocks', () => {
  it('matches off both ends', () => {
    const before = blocks('a\n\nb\n\nc\n');
    const after = blocks('a\n\nB\n\nc\n');
    expect(commonBlocks(before, after)).toEqual({ head: 1, tail: 1 });
  });

  it('never counts a block from both ends at once', () => {
    const one = blocks('a\n');
    const two = blocks('a\n\na\n');
    expect(commonBlocks(one, two)).toEqual({ head: 1, tail: 0 });
    expect(commonBlocks(two, one)).toEqual({ head: 1, tail: 0 });
  });

  it('says nothing is shared when nothing is', () => {
    expect(commonBlocks(blocks('a\n'), blocks('b\n'))).toEqual({ head: 0, tail: 0 });
  });
});
