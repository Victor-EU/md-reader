import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type StateCommand, type Text } from '@codemirror/state';
import {
  type AnnotationKind,
  colorStyle,
  type PaletteMeaning,
  paletteEntry,
} from '@mdreader/markdown';
import { command, type Edit, trimmed } from './edit.ts';

/**
 * The four annotation commands of design 4.3: highlight, colour from the
 * five-meaning palette, strikethrough, and comment.
 *
 * Each is planned by a pure function of the state, which is what lets the
 * round-trip corpus state the bytes it expects without running the editor,
 * and what keeps the commands usable from Read mode, where there is no
 * editor view to dispatch through.
 */

/** The shape every plan in this folder returns; see `./edit.ts`. */
export type AnnotationEdit = Edit;

// --- highlight and strikethrough -----------------------------------------

/**
 * Wrap every non-empty range in `marker`, or take the marker off a range
 * that is already exactly wrapped in it. The whitespace at a range's
 * edges is left outside the marks, for the reason `trimmed` gives.
 *
 * Toggling reads the two spans of source either side of the selection
 * rather than the tree. That is the same question the reader is asking —
 * "are these characters right here the marks?" — and it answers correctly
 * inside a code span or an unclosed run, where the tree has no mark node
 * to find.
 */
export function toggleWrapEdit(state: EditorState, marker: string): AnnotationEdit | null {
  const width = marker.length;
  let acted = false;
  const edit = state.changeByRange((range) => {
    // The whitespace at the edges stays outside the marks; `trimmed` says
    // why that matters more for `==` than for anything else.
    const span = range.empty ? null : trimmed(state, range);
    if (!span) return { range };
    acted = true;
    const { from, to } = span;
    if (wrapped(state.doc, from, to, marker)) {
      return {
        changes: [
          { from: from - width, to: from },
          { from: to, to: to + width },
        ],
        range: EditorSelection.range(from - width, to - width),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + width, to + width),
    };
  });
  return acted ? edit : null;
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
  const main = state.selection.main;
  const range = main.empty ? null : trimmed(state, main);
  if (!range) return null;
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
 *
 * The selection is trimmed first. A selection dragged to the end of a
 * line ends after the line break, and a note written there sits at the
 * head of the next block, anchored to the wrong text. A selection of
 * nothing but whitespace has no anchor at all, so it takes the block
 * form.
 */
export function commentEdit(state: EditorState, kind: AnnotationKind, text = ''): AnnotationEdit {
  const main = state.selection.main;
  const span = main.empty ? null : trimmed(state, main);
  const note = commentText(kind, text);
  if (!span) {
    const at = blockCommentPos(state, main.from);
    return {
      changes: { from: at, insert: `${note}\n` },
      selection: EditorSelection.single(at + commentPrefix(kind).length + text.length),
    };
  }
  const before = state.doc.sliceString(Math.max(0, span.to - 1), span.to);
  const space = before === '' || /\s/.test(before) ? '' : ' ';
  const insert = `${space}${note}`;
  return {
    changes: { from: span.to, insert },
    selection: EditorSelection.single(
      span.to + space.length + commentPrefix(kind).length + text.length,
    ),
  };
}

export const applyComment = (kind: AnnotationKind, text = ''): StateCommand =>
  command((state) => commentEdit(state, kind, text), 'input.annotate.comment');
