import { describe, expect, it } from 'vitest';
import { parser } from './parser.ts';

describe('parser', () => {
  it('parses an ATX heading and a GFM table', () => {
    const doc = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const tree = parser.parse(doc);
    const names: string[] = [];
    tree.iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).toContain('ATXHeading1');
    expect(names).toContain('Table');
    expect(names).toContain('TableCell');
  });

  it('never throws on odd input', () => {
    for (const doc of ['', '\r\n', '```', '| |', '[', '$$', '<div>', '\u{feff}# bom']) {
      expect(() => parser.parse(doc)).not.toThrow();
    }
  });
});
