import { syntaxTree } from '@codemirror/language';
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
});
