import { EditorSelection, type StateCommand, type Text } from '@codemirror/state';

/**
 * The markup at the start of a line: quote markers, then optionally a list
 * marker and a task box, each with the exact whitespace that follows it.
 */
const markupRe = /^((?:[ \t]*>[ \t]*)*)(?:([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?)?/;

export interface LineMarkup {
  /** Everything before the content: quotes, indentation, marker, task box. */
  prefix: string;
  /** The quote markers alone, with their whitespace. */
  quotes: string;
  /** True when the line has a list marker. */
  list: boolean;
  /** Content after the markup, may be empty. */
  content: string;
}

export function lineMarkup(text: string): LineMarkup {
  const m = markupRe.exec(text);
  const prefix = m?.[0] ?? '';
  return { prefix, quotes: m?.[1] ?? '', list: !!m?.[3], content: text.slice(prefix.length) };
}

/**
 * What Enter inserts after `prefix`: the same quotes and indentation byte
 * for byte, the same bullet, the next number for an ordered item, and an
 * unchecked box for a task. Nothing is trimmed, retyped, or renumbered
 * elsewhere.
 */
export function continuation(prefix: string): string {
  return prefix
    .replace(/(\d+)([.)])/, (_m, n: string, d: string) => `${Number(n) + 1}${d}`)
    .replace(/\[[xX]\]/, '[ ]');
}

/**
 * Plan the change Enter makes at `pos`, without an editor. Exposed so the
 * corpus expectation and the command share one definition.
 */
export interface NewlinePlan {
  from: number;
  to: number;
  insert: string;
  /** Where the cursor lands; defaults to the end of the insertion. */
  cursor?: number;
}

/**
 * True when the item's marker line directly follows a paragraph line at
 * the same level, so an empty `-` item above it would underline that
 * paragraph. Only `-` can be an underline; `*`, `+`, and numbers cannot.
 */
function underlineTrap(doc: Text, lineNumber: number, prefix: string): boolean {
  if (lineNumber < 2) return false;
  const marker = /([-*+]|\d+[.)])/.exec(prefix.replace(/^(?:[ \t]*>[ \t]*)*/, ''))?.[1];
  if (marker !== '-') return false;
  const current = lineMarkup(prefix);
  const prev = lineMarkup(doc.line(lineNumber - 1).text);
  if (prev.quotes !== current.quotes || prev.list || prev.content.trim() === '') return false;
  const indent = (text: string) => /^[ \t]*/.exec(text)?.[0].length ?? 0;
  const markerIndent = indent(prefix.slice(current.quotes.length));
  return indent(prev.content) <= markerIndent + 3;
}

export function newlinePlan(doc: Text, pos: number): NewlinePlan {
  const line = doc.lineAt(pos);
  const { prefix, quotes, list, content } = lineMarkup(line.text);
  const markupEnd = line.from + prefix.length;
  if (pos < markupEnd || prefix === '') {
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
    return { from: pos, to: pos, insert: `\n${pos >= line.from + indent.length ? indent : ''}` };
  }
  if (list && pos === markupEnd && underlineTrap(doc, line.number, prefix)) {
    // A new empty item here would be a lone `-` under a paragraph, which
    // CommonMark reads as a setext underline and turns the paragraph into a
    // heading. Put the empty item after a blank line instead, which says
    // the same thing and leaves the paragraph a paragraph.
    const insert = `\n${prefix}\n`;
    return {
      from: line.from,
      to: line.from,
      insert,
      cursor: line.from + insert.length + prefix.length,
    };
  }
  if ((list || prefix.includes('>')) && content.trim() === '' && pos === line.to) {
    // Enter on an empty item or quote line leaves the list or quote.
    const keep = list ? quotes : quotes.replace(/[ \t]*>[ \t]*$/, '');
    return { from: line.from + keep.length, to: line.to, insert: '' };
  }
  return { from: pos, to: pos, insert: `\n${continuation(prefix)}` };
}

/**
 * Enter for markdown. Continues lists, tasks, and quotes with an exact copy
 * of the line's markup, keeps tabs and trailing spaces alone (two trailing
 * spaces are a hard break), never adds or converts indentation, and steps
 * out of a list or quote when the item is empty. Replaces lang-markdown's
 * `insertNewlineContinueMarkup`, which trims trailing whitespace, turns
 * tabs into spaces, adds blank lines in loose lists, and renumbers.
 */
export const insertNewlineMarkdown: StateCommand = ({ state, dispatch }) => {
  const changes = state.changeByRange((range) => {
    if (!range.empty) {
      return {
        changes: { from: range.from, to: range.to, insert: '\n' },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const plan = newlinePlan(state.doc, range.head);
    return {
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      range: EditorSelection.cursor(plan.cursor ?? plan.from + plan.insert.length),
    };
  });
  dispatch(state.update(changes, { userEvent: 'input', scrollIntoView: true }));
  return true;
};
