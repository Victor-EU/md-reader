import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type StateCommand, type Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { lineMarkup, markerIndent, outerQuotes, parentItemPrefix } from './newline.ts';

/**
 * The markup a Backspace removes in one go: quote markers, then a list
 * marker with exactly one whitespace character after it, then a task box
 * with one. Any further whitespace is content and goes one byte at a time.
 */
const coreRe = /^((?:[ \t]*>[ \t]?)*)(?:([ \t]*)([-*+]|\d+[.)])[ \t](\[[ xX]\][ \t])?)?/;

export interface DeletePlan {
  from: number;
  to: number;
}

/**
 * What Backspace deletes at `pos` when it sits right after a line's
 * markup: the list marker (with its indentation and task box) when the
 * line is an item, or the innermost quote marker otherwise. Null anywhere
 * else, where the ordinary one-character delete applies. Only the marker
 * goes; the text after it stays, so the item becomes a plain line and no
 * whitespace is written in the marker's place.
 */
export function deleteMarkerPlan(doc: Text, pos: number): DeletePlan | null {
  const line = doc.lineAt(pos);
  const m = coreRe.exec(line.text);
  const core = m?.[0] ?? '';
  if (core === '' || pos !== line.from + core.length) return null;
  const quotes = m?.[1] ?? '';
  const list = !!m?.[3];
  if (list) return { from: line.from + quotes.length, to: pos };
  return { from: line.from + outerQuotes(quotes).length, to: pos };
}

/**
 * Backspace for markdown. Right after a list marker it removes the marker,
 * its indentation, and its task box; right after a quote marker it removes
 * that marker. Replaces lang-markdown's `deleteMarkupBackward`, which
 * writes whitespace of the marker's width in its place, so that a few
 * Backspaces on empty items left lines of spaces that Enter then copied
 * and a later paragraph inherited as a code block.
 */
export const deleteMarkerBackward: StateCommand = ({ state, dispatch }) => {
  let handled = true;
  const changes = state.changeByRange((range) => {
    const plan = range.empty ? deleteMarkerPlan(state.doc, range.head) : null;
    if (!plan) {
      handled = false;
      return { range };
    }
    return { changes: { from: plan.from, to: plan.to }, range: EditorSelection.cursor(plan.from) };
  });
  if (!handled) return false;
  dispatch(state.update(changes, { userEvent: 'delete', scrollIntoView: true }));
  return true;
};

/** Marker plus the whitespace after it, which is how far a child item is indented. */
function markerWidth(text: string): number {
  const markup = lineMarkup(text);
  const marker = /^[ \t]*([-*+]|\d+[.)])[ \t]+/.exec(markup.prefix.slice(markup.quotes.length));
  return marker ? marker[0].length - markerIndent(markup) : 0;
}

/**
 * The indentation Tab adds to the item on `lineNumber`: the marker width
 * of the nearest item above at the same or a shallower level, so the item
 * lands exactly under that item's content and CommonMark reads it as a
 * child. The item's own marker width when it is the first of its list.
 */
function indentUnit(doc: Text, lineNumber: number): string {
  const line = doc.line(lineNumber);
  const current = lineMarkup(line.text);
  const indent = markerIndent(current);
  const stop = Math.max(1, lineNumber - 500);
  for (let n = lineNumber - 1; n >= stop; n--) {
    const markup = lineMarkup(doc.line(n).text);
    if (markup.quotes.replace(/[ \t]/g, '') !== current.quotes.replace(/[ \t]/g, '')) break;
    if (markup.list && markerIndent(markup) <= indent)
      return ' '.repeat(markerWidth(markup.prefix));
  }
  return ' '.repeat(markerWidth(line.text));
}

function coveredLines(doc: Text, ranges: readonly { from: number; to: number }[]): number[] {
  const lines = new Set<number>();
  for (const range of ranges) {
    const last = doc.lineAt(range.to).number;
    for (let n = doc.lineAt(range.from).number; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

function inCode(state: EditorState, pos: number): boolean {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

/**
 * Tab for markdown. On list item lines it indents each item one level,
 * by the width of the marker above, so the item becomes a child of it.
 * In a code block it inserts a tab. Anywhere else it inserts a tab too,
 * except within a line's leading whitespace, where four columns would turn
 * the line into an indented code block; there it does nothing. It always
 * returns true, because a Tab the editor does not claim moves focus to
 * the next control of the window and the next Enter presses that.
 */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const { doc } = state;
  const lines = coveredLines(doc, state.selection.ranges);
  const items = lines.filter((n) => lineMarkup(doc.line(n).text).list);
  if (items.length > 0) {
    const changes = items.map((n) => {
      const line = doc.line(n);
      return { from: line.from + lineMarkup(line.text).quotes.length, insert: indentUnit(doc, n) };
    });
    dispatch(
      state.update({
        changes,
        selection: state.selection.map(state.changes(changes)),
        userEvent: 'input.indent',
        scrollIntoView: true,
      }),
    );
    return true;
  }
  const main = state.selection.main;
  const line = doc.lineAt(main.from);
  const leading = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
  if (main.empty && main.from <= line.from + leading && !inCode(state, main.from)) return true;
  dispatch(
    state.update(state.replaceSelection('\t'), { userEvent: 'input', scrollIntoView: true }),
  );
  return true;
};

/**
 * Shift-Tab for markdown: outdents each list item under the selection by
 * one level, the width of its parent's marker, or removes all of its
 * indentation when it has no parent. Always returns true for the same
 * reason as `indentListItem`.
 */
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const { doc } = state;
  const changes: { from: number; to: number }[] = [];
  for (const n of coveredLines(doc, state.selection.ranges)) {
    const line = doc.line(n);
    const markup = lineMarkup(line.text);
    const indent = markerIndent(markup);
    if (!markup.list || indent === 0) continue;
    const parent = parentItemPrefix(doc, n, markup.prefix);
    const unit = parent === null ? indent : Math.min(indent, markerWidth(parent));
    const start = line.from + markup.quotes.length + indent - unit;
    changes.push({ from: start, to: start + unit });
  }
  if (changes.length === 0) return true;
  dispatch(
    state.update({
      changes,
      selection: state.selection.map(state.changes(changes)),
      userEvent: 'delete.dedent',
      scrollIntoView: true,
    }),
  );
  return true;
};
