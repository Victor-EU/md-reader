import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
} from '@codemirror/state';
import { command, type Edit, trimmed } from './edit.ts';

/**
 * The four inline marks of design 4.5: bold, italic, code, and link.
 *
 * Applying a mark to a selection wraps it; applying it with nothing
 * selected wraps the word under the cursor; applying it to text that
 * already carries the mark takes it off again. A cursor in whitespace
 * leaves an empty pair to type into, which is what every editor does and
 * what anyone reaching for Cmd+B before writing the word expects.
 */

/**
 * How far a run of `ch` reaches back from `pos`.
 *
 * Only a short run is counted. Three marker characters either side is
 * already bold and italic together, which is as much emphasis as anybody
 * means; past that the answer stops changing and the scan stops with it.
 */
const RUN_LIMIT = 8;

function runBefore(doc: Text, pos: number, ch: string): number {
  let n = 0;
  while (n < RUN_LIMIT && pos - n > 0 && doc.sliceString(pos - n - 1, pos - n) === ch) n++;
  return n;
}

function runAfter(doc: Text, pos: number, ch: string): number {
  let n = 0;
  while (n < RUN_LIMIT && pos + n < doc.length && doc.sliceString(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/**
 * Whether the text from `from` to `to` already carries `marker`.
 *
 * Emphasis nests in one run of asterisks, so the question is not "are the
 * two characters before it the marker" but "how deep is the run either
 * side". `**word**` carries bold and not italic, `***word***` carries
 * both, and `*word*` carries italic alone — which is the difference
 * between Cmd+I on bold text adding a level and it quietly halving one.
 *
 * A code span is delimited by as many backticks as it needs to hold the
 * ticks inside it, so for that one any run at all is the mark.
 */
function marked(doc: Text, from: number, to: number, marker: string): boolean {
  const ch = marker.charAt(0);
  const run = Math.min(runBefore(doc, from, ch), runAfter(doc, to, ch));
  if (marker === '`') return run >= 1;
  return marker.length === 2 ? run >= 2 : run % 2 === 1;
}

/**
 * What the mark applies to: the selection with the whitespace at its
 * edges left outside, or the word the cursor is in. The trimming is
 * `trimmed` in `./edit.ts`, which the annotation marks share.
 */
function target(state: EditorState, range: SelectionRange): SelectionRange | null {
  if (range.empty) {
    const word = state.wordAt(range.head);
    return word && !word.empty ? word : null;
  }
  return trimmed(state, range);
}

/**
 * Wrap or unwrap every range in `marker`. Two changes per range and
 * nothing else, which is the byte diff the round-trip corpus expects.
 *
 * Null when there is nothing to mark: a selection of whitespace alone.
 * A cursor with no word around it is not that case — there the empty
 * pair is the point, and the reader types into it.
 */
export function markEdit(state: EditorState, marker: string): Edit | null {
  const width = marker.length;
  let acted = false;
  const edit = state.changeByRange((range) => {
    const span = target(state, range);
    if (!span) {
      if (!range.empty) return { range };
      acted = true;
      return {
        changes: { from: range.from, insert: `${marker}${marker}` },
        range: EditorSelection.cursor(range.from + width),
      };
    }
    acted = true;
    const { from, to } = span;
    // A cursor stays a cursor: the reader is mid-word and about to keep
    // typing, so the mark goes on around them rather than selecting.
    const kept = range.empty;
    if (marked(state.doc, from, to, marker)) {
      return {
        changes: [
          { from: from - width, to: from },
          { from: to, to: to + width },
        ],
        range: kept
          ? EditorSelection.cursor(range.head - width)
          : EditorSelection.range(from - width, to - width),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: kept
        ? EditorSelection.cursor(range.head + width)
        : EditorSelection.range(from + width, to + width),
    };
  });
  return acted ? edit : null;
}

export const boldEdit = (state: EditorState) => markEdit(state, '**');
export const italicEdit = (state: EditorState) => markEdit(state, '*');
export const codeEdit = (state: EditorState) => markEdit(state, '`');

export const applyBold = command(boldEdit, 'input.format.bold');
export const applyItalic = command(italicEdit, 'input.format.italic');
export const applyCode = command(codeEdit, 'input.format.code');

/**
 * Text that is meant as a destination rather than as words: a scheme, a
 * bare `www.`, or a path. Deliberately loose — the cost of being wrong is
 * a link the reader retypes, and the cost of being strict is a pasted URL
 * that lands as text.
 */
const URLISH = /^(?:[a-z][a-z0-9+.-]*:|www\.|\/|\.{1,2}\/)\S*$/i;

export function isUrl(text: string): boolean {
  return URLISH.test(text.trim()) && !/\s/.test(text.trim());
}

/**
 * A link around the selection (design 4.5).
 *
 * With a `url` — the paste path — the whole link is written and the cursor
 * lands after it. Without one, a selection that is itself a URL becomes
 * the destination and the cursor waits in the empty text slot; anything
 * else becomes the text and the cursor waits in the empty destination.
 */
export function linkEdit(state: EditorState, url = ''): Edit {
  const range = state.selection.main;
  // Nothing but whitespace selected is nothing to link: the empty link
  // goes in where the caret is rather than swallowing the spaces.
  const span = target(state, range) ?? EditorSelection.cursor(range.head);
  const text = state.doc.sliceString(span.from, span.to);
  const href = url !== '' ? url : isUrl(text) ? text : '';
  const label = url === '' && href === text ? '' : text;
  const insert = `[${label}](${href})`;
  const at =
    label === ''
      ? span.from + 1
      : href === ''
        ? span.from + label.length + 3
        : span.from + insert.length;
  return {
    changes: { from: span.from, to: span.to, insert },
    selection: EditorSelection.single(at),
  };
}

export const applyLink = (url = '') =>
  command((state) => linkEdit(state, url), 'input.format.link');
