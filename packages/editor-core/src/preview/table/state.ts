import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { type RevealRange, revealRanges } from '../reveal.ts';
import { tableModel } from './model.ts';
import { TableWidget } from './widget.ts';

/** Where to put the nested editor's cursor when a cell becomes active. */
export type CursorHint = 'start' | 'end' | 'keep' | 'coords' | number;

export interface ActiveCell {
  /** Start of the `Table` node, mapped through changes. */
  table: number;
  /** Row index over header and body rows, 0 is the header. */
  row: number;
  col: number;
  cursor: CursorHint;
}

export const setActiveCell = StateEffect.define<ActiveCell | null>({
  map: (value, mapping) => value && { ...value, table: mapping.mapPos(value.table, -1) },
});

/**
 * The cell being edited through a table widget, if any. Cleared by any
 * transaction that sets the outer selection on purpose, which is what a
 * click or keyboard motion outside the widget does; undo and redo restore
 * a selection too but must not close the cell.
 */
export const activeCellField = StateField.define<ActiveCell | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveCell)) return e.value;
    if (!value) return null;
    if (tr.selection && !tr.isUserEvent('undo') && !tr.isUserEvent('redo')) return null;
    return tr.docChanged ? { ...value, table: tr.changes.mapPos(value.table, -1) } : value;
  },
});

export function sameActive(a: ActiveCell | null, b: ActiveCell | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.table === b.table &&
      a.row === b.row &&
      a.col === b.col &&
      a.cursor === b.cursor)
  );
}

const containers: ReadonlySet<string> = new Set([
  'Document',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
]);

interface TableState {
  deco: DecorationSet;
  /** Block reveal ranges at the time `deco` was built, to find tables whose reveal state flipped. */
  revealed: RevealRange[];
}

/** Widgets for every table overlapping one of `ranges` that the reveal rule does not show as source. */
function buildWidgetsIn(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  revealed: readonly RevealRange[],
): Range<Decoration>[] {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const active = state.field(activeCellField);
  const out: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== 'Table') return containers.has(node.name);
        if (seen.has(node.from)) return false;
        seen.add(node.from);
        if (revealed.some((r) => r.from < node.to && r.to > node.from)) return false;
        const model = tableModel(node.node, doc);
        if (!model) return false;
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        const cell = active && active.table === node.from ? active : null;
        const widget = new TableWidget(model, doc.sliceString(node.from, node.to), tree, doc, cell);
        out.push(Decoration.replace({ widget, block: true }).range(from, to));
        return false;
      },
    });
  }
  return out;
}

/**
 * The span of the new tree whose top-level blocks were not reused from
 * the old tree. Lezer keeps the same `Tree` object for a block whose text
 * and context did not change, so walking the top-level children from
 * both ends until identity stops matching bounds every block that can
 * have changed. Null means nothing structural changed.
 */
export function changedRegion(oldTree: Tree, newTree: Tree): { from: number; to: number } | null {
  const a = oldTree.cursor();
  const b = newTree.cursor();
  let prefixEnd = 0;
  let aHas = a.firstChild();
  let bHas = b.firstChild();
  while (aHas && bHas && a.tree !== null && a.tree === b.tree) {
    prefixEnd = b.to;
    aHas = a.nextSibling();
    bHas = b.nextSibling();
  }
  if (!bHas) return aHas ? { from: prefixEnd, to: newTree.length } : null;
  const a2 = oldTree.cursor();
  const b2 = newTree.cursor();
  let suffixStart = newTree.length;
  let aH = a2.lastChild();
  let bH = b2.lastChild();
  while (aH && bH && a2.tree !== null && a2.tree === b2.tree && b2.from > prefixEnd) {
    suffixStart = b2.from;
    aH = a2.prevSibling();
    bH = b2.prevSibling();
  }
  return { from: prefixEnd, to: Math.max(prefixEnd, suffixStart) };
}

function blockReveal(state: EditorState): RevealRange[] {
  return revealRanges(state).filter((r) => r.block);
}

function sameRanges(a: readonly RevealRange[], b: readonly RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i]?.from && r.to === b[i]?.to);
}

function fullBuild(state: EditorState): TableState {
  const revealed = blockReveal(state);
  const deco = Decoration.set(
    buildWidgetsIn(state, [{ from: 0, to: state.doc.length }], revealed),
    true,
  );
  return { deco, revealed };
}

/**
 * One block widget per table that the reveal rule does not show as
 * source. Updated incrementally: existing widgets are mapped through the
 * change, and only the blocks Lezer reparsed, the tables whose reveal
 * state flipped, and the tables that gained or lost the active cell are
 * rebuilt. A keystroke in a 1 MB document therefore costs a walk over
 * the reparsed blocks, not over every block. A widget spans whole lines
 * because block replacements must; a table indented in a list or
 * prefixed by `>` loses that prefix visually while it is a widget.
 *
 * Math, Mermaid, image, and frontmatter widgets belong in this same field
 * when they arrive, so the document is walked once per change.
 */
export const tableWidgetsField = StateField.define<TableState>({
  create: fullBuild,
  update(value, tr) {
    const oldTree = syntaxTree(tr.startState);
    const newTree = syntaxTree(tr.state);
    const dirty: { from: number; to: number }[] = [];
    let deco = value.deco;
    if (tr.docChanged) deco = deco.map(tr.changes);
    if (tr.docChanged || oldTree !== newTree) {
      const region = changedRegion(oldTree, newTree);
      if (region) dirty.push(region);
    }
    const revealed = blockReveal(tr.state);
    if (!sameRanges(revealed, value.revealed)) {
      for (const r of value.revealed)
        dirty.push({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) });
      for (const r of revealed) dirty.push(r);
    }
    const oldActive = tr.startState.field(activeCellField, false) ?? null;
    const newActive = tr.state.field(activeCellField);
    if (tr.effects.some((e) => e.is(setActiveCell))) {
      if (oldActive) dirty.push(point(tr.changes.mapPos(oldActive.table, -1)));
      if (newActive) dirty.push(point(newActive.table));
    }
    if (dirty.length === 0) return { deco, revealed };
    const doc = tr.state.doc;
    const ranges = dirty.map((d) => ({
      from: doc.lineAt(Math.min(d.from, doc.length)).from,
      to: doc.lineAt(Math.min(d.to, doc.length)).to,
    }));
    deco = deco.update({
      filter: (from, to) => !ranges.some((r) => from <= r.to && to >= r.from),
      add: buildWidgetsIn(tr.state, ranges, revealed),
      sort: true,
    });
    return { deco, revealed };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

function point(pos: number): { from: number; to: number } {
  return { from: pos, to: pos };
}
