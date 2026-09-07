import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { continuation, insertNewlineMarkdown, lineMarkup } from './newline.ts';

function press(doc: string, at: number): { doc: string; head: number } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(at) });
  insertNewlineMarkdown({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  return { doc: state.doc.toString(), head: state.selection.main.head };
}

describe('lineMarkup and continuation', () => {
  it.each([
    ['- item', '- ', true],
    ['  * item', '  * ', true],
    ['\t- tabbed', '\t- ', true],
    ['1. one', '1. ', true],
    ['12) twelve', '12) ', true],
    ['- [x] done', '- [x] ', true],
    ['> quoted', '> ', false],
    ['> - both', '> - ', true],
    ['> > deep', '> > ', false],
    ['plain', '', false],
    ['  indented plain', '', false],
    ['-no space', '', false],
  ])('%j -> prefix %j list %s', (line, prefix, list) => {
    expect(lineMarkup(line)).toMatchObject({ prefix, list });
  });

  it('bumps numbers and unchecks tasks', () => {
    expect(continuation('9. ')).toBe('10. ');
    expect(continuation('> 2) ')).toBe('> 3) ');
    expect(continuation('- [x] ')).toBe('- [ ] ');
    expect(continuation('- [X] ')).toBe('- [ ] ');
  });
});

describe('insertNewlineMarkdown', () => {
  it('continues a bullet with the exact prefix and keeps trailing spaces', () => {
    expect(press('- item  ', 8)).toEqual({ doc: '- item  \n- ', head: 11 });
    expect(press('\t- tab', 6)).toEqual({ doc: '\t- tab\n\t- ', head: 10 });
  });

  it('continues ordered lists, tasks, and quotes', () => {
    expect(press('3. three', 8).doc).toBe('3. three\n4. ');
    expect(press('- [x] done', 10).doc).toBe('- [x] done\n- [ ] ');
    expect(press('> quote', 7).doc).toBe('> quote\n> ');
    expect(press('> - q', 5).doc).toBe('> - q\n> - ');
  });

  it('splits an item at the cursor', () => {
    expect(press('- ab', 3)).toEqual({ doc: '- a\n- b', head: 6 });
  });

  it('leaves a list or quote on an empty item', () => {
    expect(press('- a\n- ', 6)).toEqual({ doc: '- a\n', head: 4 });
    expect(press('  - ', 4).doc).toBe('');
    expect(press('> ', 2).doc).toBe('');
    expect(press('> - ', 4).doc).toBe('> ');
  });

  it('never turns the paragraph above into a setext heading', () => {
    // Enter at the start of the first item's text, list directly under a paragraph.
    expect(press('para\n- item', 7)).toEqual({ doc: 'para\n\n- \n- item', head: 11 });
    expect(press('> para\n> - item', 11)).toEqual({ doc: '> para\n\n> - \n> - item', head: 17 });
    // Other markers cannot underline, and a list line above is not a paragraph.
    expect(press('para\n* item', 7).doc).toBe('para\n* \n* item');
    expect(press('- a\n- b', 6).doc).toBe('- a\n- \n- b');
    expect(press('para\n\n- item', 8).doc).toBe('para\n\n- \n- item');
  });

  it('copies plain indentation without trimming', () => {
    expect(press('    code  ', 10).doc).toBe('    code  \n    ');
    expect(press('text', 4).doc).toBe('text\n');
    expect(press('- item', 0).doc).toBe('\n- item');
  });

  it('replaces a selection with a newline', () => {
    let state = EditorState.create({ doc: 'abcd', selection: EditorSelection.single(1, 3) });
    insertNewlineMarkdown({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(state.doc.toString()).toBe('a\nd');
  });
});
