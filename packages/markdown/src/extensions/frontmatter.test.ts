import { describe, expect, it } from 'vitest';
import { find, names, parse } from '../test-helpers.ts';

describe('Frontmatter', () => {
  it('parses a closed block at the start', () => {
    const doc = '---\ntitle: x\nlist:\n  - a\n---\n\n# H';
    expect(find(doc, 'Frontmatter').map((n) => n.text)).toEqual([
      '---\ntitle: x\nlist:\n  - a\n---',
    ]);
    expect(find(doc, 'FrontmatterContent').map((n) => n.text)).toEqual(['title: x\nlist:\n  - a']);
    expect(find(doc, 'FrontmatterMark')).toHaveLength(2);
    expect(names(doc)).toContain('ATXHeading1');
    expect(names(doc)).not.toContain('HorizontalRule');
  });

  it('accepts a dots closer, an empty block, and trailing spaces on the marks', () => {
    expect(find('---\na: 1\n...\ntext', 'Frontmatter').map((n) => n.text)).toEqual([
      '---\na: 1\n...',
    ]);
    expect(find('---\n---', 'Frontmatter').map((n) => n.text)).toEqual(['---\n---']);
    expect(find('---\n---', 'FrontmatterContent')).toEqual([]);
    expect(find('---  \na: 1\n---\t\n', 'Frontmatter').map((n) => n.text)).toEqual([
      '---  \na: 1\n---\t',
    ]);
  });

  it('leaves an unclosed opening line as a horizontal rule', () => {
    for (const doc of ['---', '---\n', '---\ntitle: x\n\n# H\n\ntext', '---\n----\n']) {
      const found = names(doc);
      expect(found, doc).not.toContain('Frontmatter');
      expect(found, doc).toContain('HorizontalRule');
    }
  });

  it('only starts on the first line at column zero', () => {
    expect(names('\n---\na: 1\n---')).not.toContain('Frontmatter');
    expect(names(' ---\na: 1\n---')).not.toContain('Frontmatter');
    expect(names('x\n---\na: 1\n---')).not.toContain('Frontmatter');
    expect(names('> ---\n> a\n> ---')).not.toContain('Frontmatter');
  });

  it('closes at the first closing line, whatever lies between', () => {
    const doc = '---\n# not a heading\n- not a list\n---\n# heading';
    expect(find(doc, 'Frontmatter').map((n) => n.text)).toEqual([
      '---\n# not a heading\n- not a list\n---',
    ]);
    expect(find(doc, 'ATXHeading1').map((n) => n.text)).toEqual(['# heading']);
  });

  it('looks ahead through a large document', () => {
    const big = `---\na: 1\n${'line of text\n'.repeat(20000)}`;
    expect(names(big)[1]).toBe('HorizontalRule');
    const closed = `${big}---\nend`;
    const node = parse(closed).topNode.firstChild;
    expect(node?.name).toBe('Frontmatter');
    expect(node?.to).toBe(closed.length - '\nend'.length);
  });
});
