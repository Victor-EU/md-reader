import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../test-helpers.ts';
import {
  applyColor,
  applyComment,
  applyHighlight,
  applyStrikethrough,
  blockCommentPos,
} from './annotate.ts';

/** Run a command on a parsed document and show where the cursor ends up as `|`. */
function run(
  command: StateCommand,
  doc: string,
  at: number | { anchor: number; head: number },
): string | false {
  let state = parsedState(doc, at);
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  if (!handled) return false;
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

/** The offsets of the word `word` in the fixture, as a selection. */
function around(doc: string, word: string) {
  const at = doc.indexOf(word);
  return { anchor: at, head: at + word.length };
}

describe('highlight and strikethrough', () => {
  const doc = 'One two three.\n';

  it('wraps the selection and keeps it selected', () => {
    expect(run(applyHighlight, doc, around(doc, 'two'))).toBe('One ==[two]== three.\n');
    expect(run(applyStrikethrough, doc, around(doc, 'two'))).toBe('One ~~[two]~~ three.\n');
  });

  it('takes the markers off text that already carries them', () => {
    const marked = 'One ==two== three.\n';
    expect(run(applyHighlight, marked, around(marked, 'two'))).toBe('One [two] three.\n');
    const struck = 'One ~~two~~ three.\n';
    expect(run(applyStrikethrough, struck, around(struck, 'two'))).toBe('One [two] three.\n');
  });

  it('does nothing without a selection', () => {
    expect(run(applyHighlight, doc, 4)).toBe(false);
  });

  /**
   * Found by hand at the Phase 1 gate. A reader dragging over a paragraph
   * ends the selection after the last line break, and a `==` alone on the
   * line that follows a paragraph is a Setext heading underline: the
   * paragraph rendered as an H1 and appeared in the outline.
   */
  it('leaves the line break outside the marks', () => {
    const para = 'One two\nthree four\n\nNext.\n';
    expect(run(applyHighlight, para, { anchor: 0, head: 19 })).toBe(
      '==[One two\nthree four]==\n\nNext.\n',
    );
    expect(run(applyStrikethrough, para, { anchor: 0, head: 19 })).toBe(
      '~~[One two\nthree four]~~\n\nNext.\n',
    );
  });

  it('does nothing to a selection of whitespace alone', () => {
    expect(run(applyHighlight, 'One\n\n\nTwo.\n', { anchor: 3, head: 5 })).toBe(false);
    expect(run(applyStrikethrough, 'One\n\n\nTwo.\n', { anchor: 3, head: 5 })).toBe(false);
  });

  it('marks every range of a multiple selection', () => {
    let state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    applyHighlight({
      state,
      dispatch: (tr) => {
        state = tr.state;
      },
    });
    expect(state.doc.toString()).toBe('==One== ==two== three.\n');
  });
});

describe('colour', () => {
  const doc = 'One two three.\n';

  it('wraps the selection and leaves the cursor in the pre-filled note', () => {
    expect(run(applyColor('remove'), doc, around(doc, 'two'))).toBe(
      'One <span style="color:#dc2626">two</span><!-- remove: | --> three.\n',
    );
  });

  it('changes the colour of a span it already fills, rather than nesting', () => {
    const coloured = 'One <span style="color:#dc2626">two</span> three.\n';
    expect(run(applyColor('keep'), coloured, around(coloured, 'two'))).toBe(
      'One <span style="color:#16a34a">[two]</span> three.\n',
    );
  });

  it('nests when the selection is only part of a coloured span', () => {
    const coloured = 'A <span style="color:#dc2626">two words</span> here.\n';
    expect(run(applyColor('keep'), coloured, around(coloured, 'words'))).toContain(
      '<span style="color:#dc2626">two <span style="color:#16a34a">words</span>',
    );
  });

  it('does nothing without a selection', () => {
    expect(run(applyColor('keep'), doc, 4)).toBe(false);
  });

  it('leaves the line break outside the span', () => {
    const para = 'One two\nthree four\n\nNext.\n';
    const out = run(applyColor('remove'), para, { anchor: 0, head: 19 });
    expect(out).toContain('">One two\nthree four</span>');
    expect(out).not.toContain('</span>\n');
  });
});

describe('comment', () => {
  it('anchors to the selection, adding the space that separates it', () => {
    const doc = 'One two three.\n';
    expect(run(applyComment('note', 'why'), doc, around(doc, 'two'))).toBe(
      'One two <!-- note: why| --> three.\n',
    );
  });

  // The trailing space is trimmed off the anchor, so the note lands after
  // the word with one space either side. Before the gate's trim it landed
  // after the space and glued onto the next word: `-->two three.`
  it('sits between the words when the selection took the space with it', () => {
    const doc = 'One two three.\n';
    expect(run(applyComment('keep', 'k'), doc, { anchor: 0, head: 4 })).toBe(
      'One <!-- keep: k| --> two three.\n',
    );
  });

  it('anchors to the text, not to the line break the drag took with it', () => {
    const para = 'One two\nthree four\n\nNext.\n';
    expect(run(applyComment('note', 'why'), para, { anchor: 0, head: 19 })).toBe(
      'One two\nthree four <!-- note: why| -->\n\nNext.\n',
    );
  });

  it('goes above the block when nothing is selected', () => {
    const doc = '# Title\n\nA paragraph here.\n';
    expect(run(applyComment('question', 'q'), doc, doc.indexOf('paragraph'))).toBe(
      '# Title\n\n<!-- question: q| -->\nA paragraph here.\n',
    );
  });

  it('leaves the cursor in an empty note, ready for the reason', () => {
    const doc = 'A paragraph.\n';
    expect(run(applyComment('note'), doc, 3)).toBe('<!-- note: | -->\nA paragraph.\n');
  });

  // Highlight, then comment, is one gesture in two presses: the second is
  // handed the selection the first one wrapped. A note written inside the
  // marks is part of the anchor rather than a note on it, and the
  // extractor never sees it (Phase 3 gate).
  it('goes after a mark the selection exactly fills, not inside it', () => {
    const doc = 'One ==two== three.\n';
    expect(run(applyComment('note', 'why'), doc, around(doc, 'two'))).toBe(
      'One ==two== <!-- note: why| --> three.\n',
    );
    const struck = 'One ~~two~~ three.\n';
    expect(run(applyComment('note', 'why'), struck, around(struck, 'two'))).toBe(
      'One ~~two~~ <!-- note: why| --> three.\n',
    );
    const colored = 'One <span style="color:#dc2626">two</span> three.\n';
    expect(run(applyComment('note', 'why'), colored, around(colored, 'two'))).toBe(
      'One <span style="color:#dc2626">two</span> <!-- note: why| --> three.\n',
    );
  });

  it('stays inside a mark it only partly fills', () => {
    const doc = 'One ==two words== three.\n';
    expect(run(applyComment('note', 'why'), doc, around(doc, 'two'))).toBe(
      'One ==two <!-- note: why| --> words== three.\n',
    );
  });
});

describe('blockCommentPos', () => {
  it.each([
    ['# Title\n\nText here.\n', 'Text', 9],
    // Inside a list: above the whole list, where an unprefixed line is safe.
    ['- one\n- two\n- three\n', 'two', 0],
    ['> quoted text\n', 'quoted', 0],
    ['| a | b |\n|---|---|\n| c | d |\n', 'c', 0],
    ['A paragraph\nwrapped over lines.\n', 'wrapped', 0],
  ])('%j at %j', (doc, word, expected) => {
    const state = parsedState(doc);
    expect(blockCommentPos(state, doc.indexOf(word))).toBe(expected);
  });
});
