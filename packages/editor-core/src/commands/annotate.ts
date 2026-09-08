import { syntaxTree } from '@codemirror/language';
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type StateCommand,
  type Text,
} from '@codemirror/state';
import {
  type AnnotationKind,
  colorStyle,
  type PaletteMeaning,
  paletteEntry,
} from '@mdreader/markdown';

/**
 * The four annotation commands of design 4.3: highlight, colour from the
 * five-meaning palette, strikethrough, and comment.
 *
 * Each is planned by a pure function of the state, which is what lets the
 * round-trip corpus state the bytes it expects without running the editor,
 * and what keeps the commands usable from Read mode, where there is no
 * editor view to dispatch through.
 */

export interface AnnotationEdit {
  changes: ChangeSpec;
  /** Where the selection lands afterwards, in the coordinates of the new document. */
  selection: EditorSelection;
}

function command(
  plan: (state: EditorState) => AnnotationEdit | null,
  userEvent: string,
): StateCommand {
  return ({ state, dispatch }) => {
    const edit = plan(state);
    if (!edit) return false;
    dispatch(state.update({ ...edit, userEvent, scrollIntoView: true }));
    return true;
  };
}

// --- highlight and strikethrough -----------------------------------------

/**
 * Wrap every non-empty range in `marker`, or take the marker off a range
 * that is already exactly wrapped in it.
 *
 * Toggling reads the two spans of source either side of the selection
 * rather than the tree. That is the same question the reader is asking —
 * "are these characters right here the marks?" — and it answers correctly
 * inside a code span or an unclosed run, where the tree has no mark node
 * to find.
 */
export function toggleWrapEdit(state: EditorState, marker: string): AnnotationEdit | null {
  if (state.selection.ranges.every((range) => range.empty)) return null;
  const width = marker.length;
  return state.changeByRange((range) => {
    if (range.empty) return { range };
    if (wrapped(state.doc, range.from, range.to, marker)) {
      return {
        changes: [
          { from: range.from - width, to: range.from },
          { from: range.to, to: range.to + width },
        ],
        range: EditorSelection.range(range.from - width, range.to - width),
      };
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + width, range.to + width),
    };
  });
}

function wrapped(doc: Text, from: number, to: number, marker: string): boolean {
  const width = marker.length;
  if (from < width || to + width > doc.length) return false;
  return (
    doc.sliceString(from - width, from) === marker && doc.sliceString(to, to + width) === marker
  );
}

export const highlightEdit = (state: EditorState) => toggleWrapEdit(state, '==');
export const strikethroughEdit = (state: EditorState) => toggleWrapEdit(state, '~~');

export const applyHighlight = command(highlightEdit, 'input.annotate.highlight');
export const applyStrikethrough = command(strikethroughEdit, 'input.annotate.strikethrough');

// --- colour ---------------------------------------------------------------

const OPEN_SPAN = /^<span\s+style\s*=\s*"(?<style>[^"]*)"\s*>$/i;
const CLOSE_SPAN = '</span>';

/**
 * The opening tag of the coloured span the range exactly fills, or null
 * when it fills none. A tag longer than `TAG_WINDOW` is not looked for;
 * missing one only means the new colour nests instead of replacing, which
 * is the same thing the file would say either way.
 */
const TAG_WINDOW = 128;

function enclosingSpan(doc: Text, from: number, to: number): { from: number; to: number } | null {
  if (doc.sliceString(to, to + CLOSE_SPAN.length).toLowerCase() !== CLOSE_SPAN) return null;
  const before = doc.sliceString(Math.max(0, from - TAG_WINDOW), from);
  const open = before.lastIndexOf('<span');
  if (open === -1) return null;
  const tag = before.slice(open);
  if (!OPEN_SPAN.test(tag)) return null;
  const at = from - tag.length;
  return { from: at, to: from };
}

/**
 * Colour the selection and pre-fill a comment with the palette's word for
 * that colour (design 4.3). The comment is the point: a colour alone is
 * invisible to a model, so the command leaves the cursor inside the note
 * ready for the reason.
 *
 * Colouring text that is already one colour changes that colour rather
 * than nesting a second span inside the first, which would render as the
 * inner one and leave the file saying two things.
 */
export function colorEdit(state: EditorState, meaning: PaletteMeaning): AnnotationEdit | null {
  const range = state.selection.main;
  if (range.empty) return null;
  const entry = paletteEntry(meaning);
  const open = `<span style="${colorStyle(entry.color)}">`;
  const existing = enclosingSpan(state.doc, range.from, range.to);
  if (existing) {
    return {
      changes: { from: existing.from, to: existing.to, insert: open },
      selection: EditorSelection.single(
        existing.from + open.length,
        existing.from + open.length + (range.to - range.from),
      ),
    };
  }
  const note = commentText(meaning, '');
  const shift = open.length;
  return {
    changes: [
      { from: range.from, insert: open },
      { from: range.to, insert: `${CLOSE_SPAN}${note}` },
    ],
    // Inside the empty note, where the reason goes.
    selection: EditorSelection.single(
      range.to + shift + CLOSE_SPAN.length + commentPrefix(meaning).length,
    ),
  };
}

export const applyColor = (meaning: PaletteMeaning): StateCommand =>
  command((state) => colorEdit(state, meaning), 'input.annotate.color');

// --- comments -------------------------------------------------------------

function commentPrefix(kind: AnnotationKind): string {
  return `<!-- ${kind}: `;
}

/** The comment as it is written into the file. An empty note keeps its space, ready to be typed into. */
export function commentText(kind: AnnotationKind, text: string): string {
  return `${commentPrefix(kind)}${text} -->`;
}

/**
 * Where a comment with nothing selected goes: on its own line above the
 * top-level block the cursor is in (design 4.3).
 *
 * The top-level block, and not the innermost one, because a line inserted
 * inside a list or a blockquote has to carry that container's prefix to
 * stay part of it — and an unprefixed line in the middle of a list is a
 * lazy continuation of the item above, which would change the document's
 * meaning rather than annotate it. Above the whole list is always valid,
 * and it is what the extractor then anchors the note to.
 */
export function blockCommentPos(state: EditorState, pos: number): number {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent && node.parent.name !== 'Document') node = node.parent;
  const at = node.parent ? node.from : pos;
  return state.doc.lineAt(at).from;
}

/**
 * A comment anchored to what the reader has selected, or to the block
 * they are in when they have selected nothing.
 *
 * The inline form gets a leading space when the character before it is
 * not one, so the comment never glues onto a word; the anchor rule
 * accepts whitespace between an element and its note.
 */
export function commentEdit(state: EditorState, kind: AnnotationKind, text = ''): AnnotationEdit {
  const range = state.selection.main;
  const note = commentText(kind, text);
  if (range.empty) {
    const at = blockCommentPos(state, range.from);
    return {
      changes: { from: at, insert: `${note}\n` },
      selection: EditorSelection.single(at + commentPrefix(kind).length + text.length),
    };
  }
  const before = state.doc.sliceString(Math.max(0, range.to - 1), range.to);
  const space = before === '' || /\s/.test(before) ? '' : ' ';
  const insert = `${space}${note}`;
  return {
    changes: { from: range.to, insert },
    selection: EditorSelection.single(
      range.to + space.length + commentPrefix(kind).length + text.length,
    ),
  };
}

export const applyComment = (kind: AnnotationKind, text = ''): StateCommand =>
  command((state) => commentEdit(state, kind, text), 'input.annotate.comment');
