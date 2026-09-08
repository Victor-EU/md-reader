import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../test-helpers.ts';
import { deleteMarkerBackward, deleteMarkerPlan, indentListItem, outdentListItem } from './list.ts';

function run(
  command: StateCommand,
  doc: string,
  at: number | { anchor: number; head: number },
  parsed = false,
): { doc: string; head: number; handled: boolean } {
  let state = parsed
    ? parsedState(doc, at)
    : EditorState.create({
        doc,
        selection:
          typeof at === 'number'
            ? EditorSelection.single(at)
            : EditorSelection.single(at.anchor, at.head),
      });
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  return { doc: state.doc.toString(), head: state.selection.main.head, handled };
}

describe('deleteMarkerBackward', () => {
  it('removes an empty item marker with its indentation and leaves nothing behind', () => {
    expect(run(deleteMarkerBackward, '- a\n- ', 6)).toEqual({
      doc: '- a\n',
      head: 4,
      handled: true,
    });
    expect(run(deleteMarkerBackward, '1. ', 3).doc).toBe('');
    expect(run(deleteMarkerBackward, '  - ', 4).doc).toBe('');
    expect(run(deleteMarkerBackward, '\t* ', 3).doc).toBe('');
    expect(run(deleteMarkerBackward, '- [ ] ', 6).doc).toBe('');
    expect(run(deleteMarkerBackward, '- [x] ', 6).doc).toBe('');
  });

  it('removes the marker in front of text, keeping the text', () => {
    expect(run(deleteMarkerBackward, '- item', 2)).toEqual({ doc: 'item', head: 0, handled: true });
    expect(run(deleteMarkerBackward, '12) item', 4).doc).toBe('item');
    expect(run(deleteMarkerBackward, '- [ ] task', 6).doc).toBe('task');
  });

  it('removes one quote marker at a time and keeps a list inside a quote quoted', () => {
    expect(run(deleteMarkerBackward, '> ', 2).doc).toBe('');
    expect(run(deleteMarkerBackward, '>', 1).doc).toBe('');
    expect(run(deleteMarkerBackward, '> > deep', 4).doc).toBe('> deep');
    expect(run(deleteMarkerBackward, '> - x', 4).doc).toBe('> x');
    expect(run(deleteMarkerBackward, '> x', 2).doc).toBe('x');
  });

  it('leaves every other position to the ordinary delete', () => {
    expect(deleteMarkerPlan(EditorState.create({ doc: 'plain' }).doc, 3)).toBeNull();
    // Extra whitespace after the marker is content and goes one byte at a time.
    expect(deleteMarkerPlan(EditorState.create({ doc: '-   ' }).doc, 4)).toBeNull();
    expect(deleteMarkerPlan(EditorState.create({ doc: '- [ ]  ' }).doc, 7)).toBeNull();
    // Inside or before the marker.
    expect(deleteMarkerPlan(EditorState.create({ doc: '- a' }).doc, 1)).toBeNull();
    expect(deleteMarkerPlan(EditorState.create({ doc: '  - a' }).doc, 2)).toBeNull();
    expect(deleteMarkerPlan(EditorState.create({ doc: '- a' }).doc, 3)).toBeNull();
    expect(run(deleteMarkerBackward, '- a', 3).handled).toBe(false);
    expect(run(deleteMarkerBackward, '- a\n- b', { anchor: 2, head: 6 }).handled).toBe(false);
  });
});

describe('indentListItem', () => {
  it('indents an item under the item above by that marker width', () => {
    expect(run(indentListItem, '- a\n- b', 7)).toEqual({
      doc: '- a\n  - b',
      head: 9,
      handled: true,
    });
    expect(run(indentListItem, '1. a\n2. b', 9).doc).toBe('1. a\n   2. b');
    expect(run(indentListItem, '10. a\n11. b', 11).doc).toBe('10. a\n    11. b');
    expect(run(indentListItem, '- [ ] a\n- [ ] b', 15).doc).toBe('- [ ] a\n  - [ ] b');
    expect(run(indentListItem, '> - a\n> - b', 11).doc).toBe('> - a\n>   - b');
  });

  it('uses the item’s own marker width for the first item and keeps the cursor in place', () => {
    expect(run(indentListItem, '- a', 1)).toEqual({ doc: '  - a', head: 3, handled: true });
    expect(run(indentListItem, '1. a', 0).doc).toBe('   1. a');
  });

  it('indents every item under a selection and nothing else', () => {
    const doc = 'para\n- a\n- b\n- c';
    expect(run(indentListItem, doc, { anchor: 6, head: 12 }).doc).toBe('para\n  - a\n  - b\n- c');
    expect(run(indentListItem, doc, { anchor: 0, head: 7 }).doc).toBe('para\n  - a\n- b\n- c');
  });

  it('inserts a tab in text and in code, but never as line indentation', () => {
    expect(run(indentListItem, 'ab', 1)).toEqual({ doc: 'a\tb', head: 2, handled: true });
    expect(run(indentListItem, 'ab', 0, true)).toEqual({ doc: 'ab', head: 0, handled: true });
    expect(run(indentListItem, '  ab', 1, true).doc).toBe('  ab');
    expect(run(indentListItem, '', 0, true).doc).toBe('');
    expect(run(indentListItem, '```\nx\n```', 4, true).doc).toBe('```\n\tx\n```');
    expect(run(indentListItem, 'ab', { anchor: 0, head: 2 }).doc).toBe('\t');
  });
});

describe('outdentListItem', () => {
  it('outdents an item by its parent’s marker width, or all the way when it has none', () => {
    expect(run(outdentListItem, '- a\n  - b', 9)).toEqual({
      doc: '- a\n- b',
      head: 7,
      handled: true,
    });
    expect(run(outdentListItem, '1. a\n   - b', 11).doc).toBe('1. a\n- b');
    expect(run(outdentListItem, '- a\n    - b', 11).doc).toBe('- a\n  - b');
    expect(run(outdentListItem, '   - b', 6).doc).toBe('- b');
    expect(run(outdentListItem, '> - a\n>   - b', 13).doc).toBe('> - a\n> - b');
  });

  it('is a no-op that still claims the key outside a list or at the outer level', () => {
    expect(run(outdentListItem, '- a', 3)).toEqual({ doc: '- a', head: 3, handled: true });
    expect(run(outdentListItem, 'text', 2)).toEqual({ doc: 'text', head: 2, handled: true });
  });
});
