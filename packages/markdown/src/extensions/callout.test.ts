import { describe, expect, it } from 'vitest';
import { find, names, parse } from '../test-helpers.ts';

describe('Callout', () => {
  it('is a Blockquote with a CalloutHeader first', () => {
    expect(names('> [!note]\n> body')).toEqual([
      'Document',
      'Blockquote',
      'QuoteMark',
      'CalloutHeader',
      'CalloutMark',
      'CalloutType',
      'CalloutMark',
      'QuoteMark',
      'Paragraph',
    ]);
    expect(find('> [!note]\n> body', 'Paragraph').map((n) => n.text)).toEqual(['body']);
    expect(find('> [!Warning]', 'CalloutType').map((n) => n.text)).toEqual(['Warning']);
  });

  it('parses the fold sign and an inline title', () => {
    const doc = '> [!tip]- A *title* with $x$';
    expect(find(doc, 'CalloutFold').map((n) => n.text)).toEqual(['-']);
    expect(find(doc, 'CalloutTitle').map((n) => n.text)).toEqual(['A *title* with $x$']);
    expect(names(doc)).toEqual(expect.arrayContaining(['Emphasis', 'InlineMath']));
    expect(find('> [!tip]+', 'CalloutFold').map((n) => n.text)).toEqual(['+']);
    expect(find('> [!tip]   ', 'CalloutHeader').map((n) => n.text)).toEqual(['[!tip]']);
  });

  it('accepts the marker forms blockquotes accept', () => {
    expect(names('>[!note]')).toContain('CalloutHeader');
    expect(names('>   [!note]')).toContain('CalloutHeader');
    expect(names('>     [!note]')).not.toContain('CalloutHeader');
  });

  it('rejects near misses', () => {
    for (const doc of [
      '> [!not a callout]',
      '> [!]',
      '>[!bug]no',
      '> [note]',
      '> text\n> [!note]',
      '[!note]',
    ]) {
      expect(names(doc), doc).not.toContain('CalloutHeader');
    }
  });

  it('nests and holds blocks', () => {
    const doc = '> [!q] Outer\n> > [!note] Inner\n> > body\n>\n> - item\n> ```\n> code\n> ```';
    expect(find(doc, 'CalloutHeader')).toHaveLength(2);
    expect(names(doc)).toEqual(expect.arrayContaining(['BulletList', 'FencedCode']));
    const outer = parse(doc).topNode.firstChild;
    expect(outer?.name).toBe('Blockquote');
    expect(outer?.to).toBe(doc.length);
  });
});
