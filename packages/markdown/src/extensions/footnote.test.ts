import { describe, expect, it } from 'vitest';
import { find, names, parse } from '../test-helpers.ts';

describe('Footnote', () => {
  it('parses a reference into its label and marks', () => {
    const doc = 'Text[^1] more.';
    expect(names(doc)).toEqual([
      'Document',
      'Paragraph',
      'FootnoteReference',
      'FootnoteMark',
      'FootnoteLabel',
      'FootnoteMark',
    ]);
    expect(find(doc, 'FootnoteLabel').map((n) => n.text)).toEqual(['1']);
    expect(find(doc, 'FootnoteReference').map((n) => n.text)).toEqual(['[^1]']);
  });

  it('takes labels a writer actually uses', () => {
    for (const label of ['1', 'note', 'a-b_c', 'my note', '本', '2024.1']) {
      expect(find(`x[^${label}]`, 'FootnoteLabel').map((n) => n.text)).toEqual([label]);
    }
  });

  it('leaves near misses to the other parsers', () => {
    expect(names('[^]()')).not.toContain('FootnoteReference');
    expect(names('[^unclosed')).not.toContain('FootnoteReference');
    expect(names('[^a\nb]')).not.toContain('FootnoteReference');
    expect(names('[^[nested]]')).not.toContain('FootnoteReference');
    // A plain link is still a link.
    expect(names('[text](url)')).toContain('Link');
  });

  it('parses a definition as a block with the label and content apart', () => {
    const doc = '[^1]: The note.';
    expect(names(doc)).toEqual([
      'Document',
      'FootnoteDefinition',
      'FootnoteMark',
      'FootnoteLabel',
      'FootnoteMark',
      'Paragraph',
    ]);
    expect(find(doc, 'FootnoteMark').map((n) => n.text)).toEqual(['[^', ']:']);
    expect(find(doc, 'Paragraph').map((n) => n.text)).toEqual(['The note.']);
    expect(find('[^1]:', 'FootnoteDefinition').map((n) => n.text)).toEqual(['[^1]:']);
  });

  it('holds whole blocks, not one flat string', () => {
    const doc = '[^long]: first para\n\n    second para\n\n    - a list\n\nAfter.\n';
    const definition = find(doc, 'FootnoteDefinition')[0];
    expect(definition?.text).toBe('[^long]: first para\n\n    second para\n\n    - a list');
    expect(find(doc, 'Paragraph').map((n) => n.text)).toEqual([
      'first para',
      'second para',
      'a list',
      'After.',
    ]);
    expect(names(doc)).toContain('BulletList');
  });

  it('continues lazily, the way a list item does', () => {
    const doc = '[^x]: one\n  lazy line\nstill lazy\n';
    expect(find(doc, 'Paragraph').map((n) => n.text)).toEqual(['one\n  lazy line\nstill lazy']);
  });

  it('interrupts a paragraph, because that is where models put it', () => {
    const doc = 'Text[^a]\n[^a]: right after\n';
    expect(find(doc, 'Paragraph').map((n) => n.text)).toEqual(['Text[^a]', 'right after']);
    expect(find(doc, 'FootnoteDefinition').map((n) => n.text)).toEqual(['[^a]: right after']);
  });

  it('does not take an indented line for a definition', () => {
    const doc = '    [^1]: indented code\n';
    expect(names(doc)).toContain('CodeBlock');
    expect(names(doc)).not.toContain('FootnoteDefinition');
  });

  it('parses inside a blockquote and a list', () => {
    expect(find('> [^q]: in a quote', 'FootnoteDefinition').map((n) => n.text)).toEqual([
      '[^q]: in a quote',
    ]);
    expect(find('- [^l]: in a list', 'FootnoteDefinition').map((n) => n.text)).toEqual([
      '[^l]: in a list',
    ]);
  });

  it('is not a link reference definition', () => {
    const doc = '[^1]: https://example.com\n\n[^1]\n';
    expect(names(doc)).not.toContain('LinkReference');
    expect(find(doc, 'FootnoteReference').map((n) => n.text)).toEqual(['[^1]']);
    // The ordinary form still is one.
    expect(names('[ref]: https://example.com\n\n[ref]\n')).toContain('LinkReference');
  });

  it('leaves the tree well formed for every shape', () => {
    for (const doc of [
      '[^1]:\n',
      '[^1]: a\n[^2]: b\n',
      '[^1]: a\n\n\n[^2]: b\n',
      '> [^1]: a\n> more\n',
      '[^1]: ```\ncode\n```\n',
      '[^a]: outer\n\n    [^b]: inner\n',
      'a[^1]b[^1]c\n\n[^1]: twice\n',
    ]) {
      expect(() => parse(doc)).not.toThrow();
    }
  });
});
