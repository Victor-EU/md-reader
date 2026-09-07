import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { dumpTree, parser } from '@mdreader/markdown';
import { describe, expect, it } from 'vitest';
import { createEditorState } from './state.ts';

describe('createEditorState', () => {
  it('keeps an LF document byte for byte', () => {
    const doc = '# Title\n\ntext with trailing spaces   \n\ttab\n\nno final newline';
    expect(createEditorState(doc).doc.toString()).toBe(doc);
  });

  it('normalises CRLF to LF, which is why line endings are restored in Rust (WP 1.1)', () => {
    expect(createEditorState('a\r\nb\r\n').doc.toString()).toBe('a\nb\n');
  });

  it('parses markdown with the shared dialect', () => {
    const state = createEditorState('# Title\n\n- [ ] task\n');
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names).toContain('ATXHeading1');
    expect(names).toContain('TaskMarker');
  });

  it('parses exactly like the headless parser, CommonMark base and dialect included', () => {
    const doc = [
      '---',
      'title: x',
      '---',
      '',
      '> [!note] Title',
      '> ==hi== $x$ and ^not-superscript^ and ~not-subscript~ :not_emoji:',
      '',
      '$$',
      'a = b',
      '$$',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
    ].join('\n');
    const state = createEditorState(doc);
    const tree = ensureSyntaxTree(state, doc.length, 5000);
    expect(tree).not.toBeNull();
    if (!tree) return;
    const dump = dumpTree(tree, doc);
    expect(dump).toBe(dumpTree(parser.parse(doc), doc));
    expect(dump).toContain('CalloutHeader');
    expect(dump).toContain('BlockMath');
    expect(dump).not.toMatch(/Superscript|Subscript|Emoji/);
  });
});
