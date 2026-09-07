import { syntaxTree } from '@codemirror/language';
import { ChangeSet, EditorSelection, type EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  commentInsertion,
  insertCommentAfterSelection,
  wrapBold,
  wrapHighlight,
} from '../commands/format.ts';
import { insertNewlineMarkdown, newlinePlan } from '../commands/newline.ts';
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
}

export interface Action {
  name: string;
  plan: (state: EditorState, rng: Rng) => ActionPlan | null;
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
      expected: single(state, plan),
      span: { from: plan.from, to: plan.to },
      run: withSelection(at, at, (view) => insertNewlineMarkdown(view)),
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

export const wrapInBold = wrapAction('wrap a selection in bold', '**', wrapBold);
export const wrapInHighlight = wrapAction('wrap a selection in highlight', '==', wrapHighlight);

export const insertComment: Action = {
  name: 'insert a comment after a selection',
  plan(state, rng) {
    const word = pickWord(state, rng);
    if (!word) return null;
    const insert = commentInsertion(state.doc.toString(), word.to, 'note', 'corpus');
    return {
      description: `comment after ${word.from}-${word.to}`,
      expected: single(state, { from: word.to, insert }),
      span: word,
      run: withSelection(word.from, word.to, insertCommentAfterSelection('note', 'corpus')),
    };
  },
};

/** The Phase 0 catalog for the Node runner. DOM actions live in the browser test. */
export const nodeActions: Action[] = [
  typeCharacter,
  deleteCharacter,
  toggleCheckbox,
  editTableCell,
  enterInListItem,
  wrapInBold,
  wrapInHighlight,
  insertComment,
];
