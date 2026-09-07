import { describe, expect, it } from 'vitest';
import { find, mathSource, names } from '../test-helpers.ts';

function inline(doc: string): string[] {
  return find(doc, 'InlineMath').map((n) => n.text);
}

describe('InlineMath', () => {
  it.each([
    ['a $x$ b', ['$x$']],
    ['$e^{i\\pi} + 1 = 0$', ['$e^{i\\pi} + 1 = 0$']],
    ['$5 and $10', []],
    ['$20,000 and $30,000', []],
    ['$x$1', []],
    ['$x$ is', ['$x$']],
    ['$x$.', ['$x$']],
    ['$ x$', []],
    ['$x $', []],
    ['\\$5 and \\$10', []],
    ['$a \\$ b$', ['$a \\$ b$']],
    ['a$b$c', ['$b$']],
    ['$a\nb$', ['$a\nb$']],
    ['$a\n$', []],
    ['x $$y$$ z', ['$$y$$']],
    ['x $$ y $$ z', ['$$ y $$']],
    ['$$', []],
    ['$$$$', []],
    ['$$$', []],
    ['$', []],
    ['$a$$b$', ['$a$', '$b$']],
  ])('%j -> %j', (doc, expected) => {
    expect(inline(doc)).toEqual(expected);
  });

  it('keeps markdown inside math literal', () => {
    const found = names('$a*b*c$ and $`x`$');
    expect(found.filter((n) => n === 'InlineMath')).toHaveLength(2);
    expect(found).not.toContain('Emphasis');
    expect(found).not.toContain('InlineCode');
  });

  it('gives way to a code span that started first', () => {
    expect(names('`a $b` c$')).toContain('InlineCode');
    expect(inline('`a $b` c$')).toEqual([]);
  });

  it('stays linear on a paragraph full of prices', () => {
    const doc = 'Prices: $5, $10, $15, $20 and more. '.repeat(6000);
    const start = performance.now();
    expect(inline(doc)).toEqual([]);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(inline(`${doc}\n\n$x$`)).toEqual(['$x$']);
  });

  it('marks are one or two characters', () => {
    expect(find('$x$ $$y$$', 'MathMark').map((n) => n.text)).toEqual(['$', '$', '$$', '$$']);
  });
});

describe('BlockMath', () => {
  function block(doc: string): { text: string; marks: number; source: string }[] {
    return find(doc, 'BlockMath').map((n) => ({
      text: n.text,
      marks: n.node.getChildren('MathMark').length,
      source: mathSource(n.node, doc),
    }));
  }

  it('parses the plain forms', () => {
    expect(block('$$\nE = mc^2\n$$')).toEqual([
      { text: '$$\nE = mc^2\n$$', marks: 2, source: 'E = mc^2' },
    ]);
    expect(block('$$x^2$$')).toEqual([{ text: '$$x^2$$', marks: 2, source: 'x^2' }]);
    expect(block('$$ a\nb $$')).toEqual([{ text: '$$ a\nb $$', marks: 2, source: 'a\nb' }]);
    expect(block('$$\n\na$$')).toEqual([{ text: '$$', marks: 1, source: '' }]);
    expect(block('$$$$')).toEqual([{ text: '$$$$', marks: 2, source: '' }]);
    expect(block('$$ $$')).toEqual([{ text: '$$ $$', marks: 2, source: '' }]);
  });

  it('joins lines and skips container markers', () => {
    expect(block('> $$\n> a\n> b\n> $$')).toEqual([
      { text: '$$\n> a\n> b\n> $$', marks: 2, source: 'a\nb' },
    ]);
    expect(block('- $$\n  a\n  $$')).toEqual([{ text: '$$\n  a\n  $$', marks: 2, source: 'a' }]);
  });

  it('ends unclosed at a blank line, the end of a container, or the end of input', () => {
    expect(block('$$\na\n\nb')).toEqual([{ text: '$$\na', marks: 1, source: 'a' }]);
    expect(names('$$\na\n\nb')).toContain('Paragraph');
    expect(block('$$\na')).toEqual([{ text: '$$\na', marks: 1, source: 'a' }]);
    expect(block('> $$\n> a\nb')).toEqual([{ text: '$$\n> a', marks: 1, source: 'a' }]);
    expect(block('> $$\n> a\n>\n> $$')).toEqual([
      { text: '$$\n> a', marks: 1, source: 'a' },
      { text: '$$', marks: 1, source: '' },
    ]);
    expect(block('$$\na\n>\n$$')).toEqual([{ text: '$$\na\n>\n$$', marks: 2, source: 'a\n>' }]);
  });

  it('interrupts a paragraph like a fence does', () => {
    expect(block('The equation is:\n$$\nx\n$$')).toEqual([
      { text: '$$\nx\n$$', marks: 2, source: 'x' },
    ]);
    expect(find('The equation is:\n$$\nx\n$$', 'Paragraph').map((n) => n.text)).toEqual([
      'The equation is:',
    ]);
    expect(block('- item\n  $$\n  x\n  $$')).toEqual([
      { text: '$$\n  x\n  $$', marks: 2, source: 'x' },
    ]);
    expect(find('a $$b$$ c', 'InlineMath').map((n) => n.text)).toEqual(['$$b$$']);
  });

  it('does not replace indented code', () => {
    expect(block('    $$\n    x\n    $$')).toEqual([]);
    expect(names('    $$')).toContain('CodeBlock');
  });
});
