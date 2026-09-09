import { syntaxTree } from '@codemirror/language';
import { ChangeSet, EditorSelection, type EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { colorStyle, paletteEntry } from '@mdreader/markdown';
import {
  applyColor,
  applyComment,
  applyHighlight,
  applyStrikethrough,
  commentText,
} from '../commands/annotate.ts';
import { applyBold, applyCode, applyItalic, applyLink, linkEdit } from '../commands/format.ts';
import { indentListItem, indentPlan, outdentListItem, outdentPlan } from '../commands/list.ts';
import { insertNewlineMarkdown, lineMarkup, newlinePlan } from '../commands/newline.ts';
import { escapePipes, rebaseCellChanges } from '../preview/table/commands.ts';
import { tableModel } from '../preview/table/model.ts';
import { type CommandTarget, toggleTaskAt } from '../preview/widgets.ts';
import type { Rng } from './rng.ts';

/**
 * One planned edit: how to perform it through the editor, and what it
 * must do to the bytes, computed here without the editor's help.
 */
export interface ActionPlan {
  description: string;
  run: (view: CommandTarget) => boolean;
  expected: ChangeSet;
  /** The source span the edit touches, for the locality invariant. */
  span: { from: number; to: number };
  /**
   * True when the edit rearranges blocks on purpose, so invariant B does
   * not apply to it. Indentation is the case: making an item a child of
   * the one above it can also join the list to the one after it, which is
   * a change to the tree outside the block the bytes landed in. What is
   * still checked is invariant A, that the bytes are exactly the planned
   * ones.
   */
  structural?: boolean;
}

export interface Action {
  name: string;
  plan: (state: EditorState, rng: Rng) => ActionPlan | null;
  /**
   * How many corpus files this action must apply to before the run is
   * worth believing. Most apply to nearly all of them; indentation needs
   * a nested list, which most prose does not have.
   */
  minChecked?: number;
}

function nodesNamed(state: EditorState, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === name) out.push(node.node);
    },
  });
  return out;
}

/** Runs of letters inside a paragraph that no inline element covers, so wrapping them is plain. */
function plainWords(state: EditorState, para: SyntaxNode): { from: number; to: number }[] {
  const text = state.doc.sliceString(para.from, para.to);
  const tree = syntaxTree(state);
  const words: { from: number; to: number }[] = [];
  for (const m of text.matchAll(/[A-Za-z]{3,}/g)) {
    const from = para.from + m.index;
    const to = from + m[0].length;
    const line = state.doc.lineAt(from);
    if (from === line.from || to === line.to) continue;
    if (
      tree.resolveInner(from, 1).name !== 'Paragraph' ||
      tree.resolveInner(to, -1).name !== 'Paragraph'
    )
      continue;
    words.push({ from, to });
  }
  return words;
}

function pickWord(state: EditorState, rng: Rng): { from: number; to: number } | null {
  const paragraphs = nodesNamed(state, 'Paragraph').filter((p) => p.to - p.from > 4);
  if (paragraphs.length === 0) return null;
  const words = plainWords(state, rng.pick(paragraphs));
  return words.length ? rng.pick(words) : null;
}

function single(
  state: EditorState,
  spec: { from: number; to?: number; insert?: string },
): ChangeSet {
  return ChangeSet.of(spec, state.doc.length);
}

function withSelection(from: number, to: number, command: (view: CommandTarget) => boolean) {
  return (view: CommandTarget): boolean => {
    view.dispatch(view.state.update({ selection: EditorSelection.range(from, to) }));
    return command(view);
  };
}

export const typeCharacter: Action = {
  name: 'type a character in a paragraph',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word) return null;
    const at = rng.int(word.from + 1, word.to - 1);
    return {
      description: `type "x" at ${at}`,
      expected: single(state, { from: at, insert: 'x' }),
      span: { from: at, to: at },
      run: (view) => {
        view.dispatch(
          view.state.update({
            changes: { from: at, insert: 'x' },
            selection: { anchor: at + 1 },
            userEvent: 'input.type',
          }),
        );
        return true;
      },
    };
  },
};

export const deleteCharacter: Action = {
  name: 'delete a character in a paragraph',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word || word.to - word.from < 4) return null;
    const at = rng.int(word.from + 1, word.to - 2);
    return {
      description: `delete the character at ${at}`,
      expected: single(state, { from: at, to: at + 1 }),
      span: { from: at, to: at + 1 },
      run: (view) => {
        view.dispatch(
          view.state.update({
            changes: { from: at, to: at + 1 },
            selection: { anchor: at },
            userEvent: 'delete.backward',
          }),
        );
        return true;
      },
    };
  },
};

export const toggleCheckbox: Action = {
  name: 'toggle a checkbox',
  plan(state, rng) {
    const markers = nodesNamed(state, 'TaskMarker');
    if (markers.length === 0) return null;
    const marker = rng.pick(markers);
    const current = state.doc.sliceString(marker.from, marker.to);
    const insert = current === '[ ]' ? 'x' : ' ';
    return {
      description: `toggle ${current} at ${marker.from}`,
      expected: single(state, { from: marker.from + 1, to: marker.from + 2, insert }),
      span: { from: marker.from, to: marker.to },
      run: (view) => toggleTaskAt(view, marker.from),
    };
  },
};

const cellTexts = ['q', 'a|b', '日本', ' spaced '];

/** The pure half of a cell edit: the rebase and the escaping the nested editor performs. */
export const editTableCell: Action = {
  name: 'edit a table cell (state path)',
  plan(state, rng) {
    const tables = nodesNamed(state, 'Table');
    if (tables.length === 0) return null;
    const model = tableModel(rng.pick(tables), state.doc);
    if (!model) return null;
    const cells = model.rows.flatMap((r) => r.cells.filter((c) => !c.missing));
    if (cells.length === 0) return null;
    const cell = rng.pick(cells);
    const text = escapePipes(rng.pick(cellTexts));
    const offset = rng.int(0, cell.to - cell.from);
    return {
      description: `insert ${JSON.stringify(text)} at offset ${offset} of the cell at ${cell.from}`,
      expected: single(state, { from: cell.from + offset, insert: text }),
      span: { from: cell.from, to: cell.to },
      run: (view) => {
        const nested = ChangeSet.of({ from: offset, insert: text }, cell.to - cell.from);
        view.dispatch(
          view.state.update({
            changes: rebaseCellChanges(cell.from, nested),
            userEvent: 'input.type',
          }),
        );
        return true;
      },
    };
  },
};

export const enterInListItem: Action = {
  name: 'press Enter in a list item',
  plan(state, rng) {
    const items = nodesNamed(state, 'ListItem').filter((item) => {
      const body = item.getChild('ListMark')?.nextSibling;
      return (
        !!body &&
        (body.name === 'Paragraph' || body.name === 'Task') &&
        body.from <= state.doc.lineAt(item.from).to
      );
    });
    if (items.length === 0) return null;
    const item = rng.pick(items);
    const body = item.getChild('ListMark')?.nextSibling as SyntaxNode;
    const line = state.doc.lineAt(body.from);
    // Anywhere on the marker line at or after the content start, so items split as well as continue.
    const at = rng.int(body.from, Math.min(body.to, line.to));
    const plan = newlinePlan(state.doc, at);
    return {
      description: `Enter at ${at}, expecting ${JSON.stringify(plan)}`,
      expected: single(state, { from: plan.from, to: plan.to, insert: plan.insert }),
      span: { from: plan.from, to: plan.to },
      run: withSelection(at, at, (view) => insertNewlineMarkdown(view)),
    };
  },
};

/** The lines that carry a list marker, which is what Tab acts on. */
function itemLines(state: EditorState): number[] {
  const lines: number[] = [];
  for (const item of nodesNamed(state, 'ListItem')) {
    const line = state.doc.lineAt(item.from);
    if (lineMarkup(line.text).list) lines.push(line.number);
  }
  return [...new Set(lines)];
}

export const indentItem: Action = {
  name: 'indent a list item',
  minChecked: 60,
  plan(state, rng) {
    const lines = itemLines(state);
    if (lines.length === 0) return null;
    const n = rng.pick(lines);
    const plan = indentPlan(state.doc, n);
    if (plan.insert === '') return null;
    const at = state.doc.line(n).to;
    return {
      description: `Tab on the item at line ${n}, inserting ${JSON.stringify(plan.insert)}`,
      expected: single(state, plan),
      span: { from: plan.from, to: plan.to },
      structural: true,
      run: withSelection(at, at, (view) => indentListItem(view)),
    };
  },
};

export const outdentItem: Action = {
  name: 'outdent a list item',
  minChecked: 60,
  plan(state, rng) {
    const lines = itemLines(state).filter((n) => outdentPlan(state.doc, n) !== null);
    if (lines.length === 0) return null;
    const n = rng.pick(lines);
    const plan = outdentPlan(state.doc, n) as { from: number; to: number };
    const at = state.doc.line(n).to;
    return {
      description: `Shift-Tab on the item at line ${n}, removing ${plan.to - plan.from}`,
      expected: single(state, plan),
      span: plan,
      structural: true,
      run: withSelection(at, at, (view) => outdentListItem(view)),
    };
  },
};

function wrapAction(
  name: string,
  marker: string,
  command: (view: CommandTarget) => boolean,
): Action {
  return {
    name,
    plan(state, rng) {
      const word = pickWord(state, rng);
      if (!word) return null;
      return {
        description: `wrap ${word.from}-${word.to} in ${marker}`,
        expected: ChangeSet.of(
          [
            { from: word.from, insert: marker },
            { from: word.to, insert: marker },
          ],
          state.doc.length,
        ),
        span: word,
        run: withSelection(word.from, word.to, command),
      };
    },
  };
}

export const wrapInBold = wrapAction('wrap a selection in bold', '**', applyBold);
export const wrapInItalic = wrapAction('wrap a selection in italic', '*', applyItalic);
export const wrapInCode = wrapAction('wrap a selection in code', '`', applyCode);
export const wrapInHighlight = wrapAction('wrap a selection in highlight', '==', applyHighlight);
export const wrapInStrikethrough = wrapAction(
  'wrap a selection in strikethrough',
  '~~',
  applyStrikethrough,
);

/** The palette colour, its span, and the note it pre-fills (design 4.3). */
export const colorSelection: Action = {
  name: 'colour a selection from the palette',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word) return null;
    const meaning = rng.pick(['attention', 'question', 'remove', 'keep', 'rewrite'] as const);
    const open = `<span style="${colorStyle(paletteEntry(meaning).color)}">`;
    const close = `</span>${commentText(meaning, '')}`;
    return {
      description: `colour ${word.from}-${word.to} ${meaning}`,
      expected: ChangeSet.of(
        [
          { from: word.from, insert: open },
          { from: word.to, insert: close },
        ],
        state.doc.length,
      ),
      span: word,
      run: withSelection(word.from, word.to, applyColor(meaning)),
    };
  },
};

export const insertComment: Action = {
  name: 'insert a comment after a selection',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word) return null;
    // `pickWord` returns a run of letters, so the character before the
    // insertion point is never whitespace and the space is always added.
    const insert = ` ${commentText('note', 'corpus')}`;
    return {
      description: `comment after ${word.from}-${word.to}`,
      expected: single(state, { from: word.to, insert }),
      span: word,
      run: withSelection(word.from, word.to, applyComment('note', 'corpus')),
    };
  },
};

export const insertBlockComment: Action = {
  name: 'insert a comment above a block',
  plan(state, rng) {
    const blocks = nodesNamed(state, 'Paragraph').filter(
      (node) => node.parent?.name === 'Document',
    );
    if (blocks.length === 0) return null;
    const block = rng.pick(blocks);
    const at = state.doc.lineAt(block.from).from;
    const insert = `${commentText('note', 'corpus')}\n`;
    const inside = rng.int(block.from, block.to);
    return {
      description: `comment above the block at ${at}, from a cursor at ${inside}`,
      expected: single(state, { from: at, insert }),
      span: { from: at, to: at },
      run: withSelection(inside, inside, applyComment('note', 'corpus')),
    };
  },
};

/**
 * A link over a word (design 4.5). One replacement rather than two
 * insertions, because the destination goes between the parentheses and
 * the text keeps its place inside the brackets.
 */
export const linkSelection: Action = {
  name: 'make a selection a link',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word) return null;
    const url = rng.pick(['https://example.org/a', './notes.md', '#section']);
    const based = state.update({
      selection: EditorSelection.range(word.from, word.to),
    }).state;
    const edit = linkEdit(based, url);
    return {
      description: `link ${word.from}-${word.to} to ${url}`,
      expected: ChangeSet.of(edit.changes, state.doc.length),
      span: word,
      run: withSelection(word.from, word.to, applyLink(url)),
    };
  },
};

/**
 * The catalog for the Node runner, as it stands at the Phase 1 gate: the
 * Phase 0 six, the five annotation commands from WP 1.6, and the marks,
 * link and indentation from WP 1.10. DOM actions live in the browser
 * test. Rich-text paste is deliberately absent — its byte change is one
 * replacement CodeMirror itself guarantees, and what is worth testing is
 * the conversion, which has its own cases (ADR 0016).
 */
export const nodeActions: Action[] = [
  typeCharacter,
  deleteCharacter,
  toggleCheckbox,
  editTableCell,
  enterInListItem,
  indentItem,
  outdentItem,
  wrapInBold,
  wrapInItalic,
  wrapInCode,
  linkSelection,
  wrapInHighlight,
  wrapInStrikethrough,
  colorSelection,
  insertComment,
  insertBlockComment,
];
