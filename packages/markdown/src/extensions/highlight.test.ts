import { describe, expect, it } from 'vitest';
import { find, names } from '../test-helpers.ts';

describe('Highlight', () => {
  it('wraps ==text== with marks', () => {
    expect(names('==a==')).toEqual([
      'Document',
      'Paragraph',
      'Highlight',
      'HighlightMark',
      'HighlightMark',
    ]);
    expect(find('x ==a b== y', 'Highlight').map((n) => n.text)).toEqual(['==a b==']);
  });

  it('follows the strikethrough flanking rules', () => {
    for (const doc of ['a == b == c', '== spaced ==', '==', '=a=', 'a ==b', '==\n==']) {
      expect(find(doc, 'Highlight'), doc).toEqual([]);
    }
    expect(find('(==a==)', 'Highlight').map((n) => n.text)).toEqual(['==a==']);
    expect(find('==a==.', 'Highlight').map((n) => n.text)).toEqual(['==a==']);
  });

  it('nests with emphasis and links', () => {
    expect(names('*a ==b== c*')).toContain('Highlight');
    expect(names('==a *b* c==').slice(2, 6)).toEqual([
      'Highlight',
      'HighlightMark',
      'Emphasis',
      'EmphasisMark',
    ]);
    expect(names('[==a==](u)')).toContain('Highlight');
  });

  it('stays out of code', () => {
    expect(find('`==a==`', 'Highlight')).toEqual([]);
    expect(find('```\n==a==\n```', 'Highlight')).toEqual([]);
  });
});
