import { isolateHistory, undo } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { dumpTree, parser } from '@markdown/markdown';
import { describe, expect, it } from 'vitest';
import { createEditorState, editorStateFromJSON, serializeEditorState } from './state.ts';

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

describe('a state serialized for another window (plan WP 2.5)', () => {
  /** Type into a state the way a transaction does, one edit at a time. */
  const typed = (text: string) => {
    let state = createEditorState('# Title\n');
    for (const word of text.split(' ')) {
      state = state.update({
        changes: { from: state.doc.length, insert: `${word} ` },
        // Each word its own undo step, which typing with a pause
        // between the words is what would make it here.
        annotations: isolateHistory.of('before'),
      }).state;
    }
    return state;
  };

  it('comes back with its text and its cursor', () => {
    const state = createEditorState('# Title\n\nbody\n', {
      selection: EditorSelection.single(3, 7),
    });
    const back = editorStateFromJSON(serializeEditorState(state));
    expect(back?.doc.toString()).toBe('# Title\n\nbody\n');
    expect(back?.selection.main.anchor).toBe(3);
    expect(back?.selection.main.head).toBe(7);
  });

  it('can still be undone on the other side', () => {
    const state = typed('one two three');
    expect(state.doc.toString()).toBe('# Title\none two three ');
    const back = editorStateFromJSON(serializeEditorState(state));
    expect(back).not.toBeNull();
    if (!back) return;
    // Undo needs a view to dispatch through; this is the smallest one
    // that counts as one.
    let current = back;
    const view = {
      state: current,
      dispatch: (tr: { state: typeof current }) => {
        current = tr.state;
        view.state = current;
      },
    };
    expect(undo(view)).toBe(true);
    expect(current.doc.toString()).toBe('# Title\none two ');
  });

  it('is null for a string that is not one of ours, rather than a throw', () => {
    expect(editorStateFromJSON('not json at all')).toBeNull();
    expect(editorStateFromJSON('{"doc":42}')).toBeNull();
  });
});
