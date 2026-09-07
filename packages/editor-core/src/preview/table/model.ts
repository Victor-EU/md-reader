import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export type Align = 'left' | 'center' | 'right' | null;

export interface CellModel {
  /** Source range of the trimmed cell content. Empty cells have `from === to` at the insertion point. */
  from: number;
  to: number;
  /** True when the row has fewer cells than the header and this one does not exist in the source. */
  missing: boolean;
}

export interface RowModel {
  from: number;
  to: number;
  cells: CellModel[];
}

export interface TableModel {
  from: number;
  to: number;
  columns: number;
  align: Align[];
  /** Header, then body rows; the delimiter row is not a row. */
  rows: RowModel[];
  delimiter: { from: number; to: number };
}

const PIPE = 124;
const BACKSLASH = 92;

/**
 * Split one row line into cell content ranges the way the GFM parser does:
 * unescaped `|` separates cells, a leading pipe opens the row, a trailing
 * pipe closes it, and content is trimmed of spaces and tabs. Unlike the
 * parser, empty cells are kept, because a user must be able to type into
 * one. Their range is the insertion point after the separator's space.
 */
export function rowCells(doc: Text, from: number, to: number): CellModel[] {
  const text = doc.sliceString(from, to);
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === BACKSLASH) i++;
    else if (ch === PIPE) pipes.push(i);
  }
  const first = pipes[0];
  const last = pipes[pipes.length - 1];
  const leading = first !== undefined && text.slice(0, first).trim() === '';
  const trailing =
    last !== undefined && text.slice(last + 1).trim() === '' && !(leading && pipes.length === 1);
  const inner = pipes.slice(leading ? 1 : 0, trailing ? pipes.length - 1 : pipes.length);
  const segment = (start: number, end: number): CellModel => {
    let a = start;
    let b = end;
    while (a < b && isBlank(text.charCodeAt(a))) a++;
    while (b > a && isBlank(text.charCodeAt(b - 1))) b--;
    if (a < b) return { from: from + a, to: from + b, missing: false };
    const at = start < end && text.charCodeAt(start) === 32 ? start + 1 : start;
    return { from: from + at, to: from + at, missing: false };
  };
  const cells: CellModel[] = [];
  let segFrom = leading && first !== undefined ? first + 1 : 0;
  for (const p of inner) {
    cells.push(segment(segFrom, p));
    segFrom = p + 1;
  }
  cells.push(segment(segFrom, trailing && last !== undefined ? last : text.length));
  return cells;
}

function isBlank(ch: number): boolean {
  return ch === 32 || ch === 9;
}

function alignments(doc: Text, from: number, to: number): Align[] {
  return rowCells(doc, from, to).map((c) => {
    const t = doc.sliceString(c.from, c.to);
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

/** Build the model of a `Table` node, or null when the node is not a table. */
export function tableModel(node: SyntaxNode, doc: Text): TableModel | null {
  if (node.name !== 'Table') return null;
  const header = node.getChild('TableHeader');
  const delimiter = node.getChild('TableDelimiter');
  if (!header || !delimiter) return null;
  const rows: RowModel[] = [
    { from: header.from, to: header.to, cells: rowCells(doc, header.from, header.to) },
  ];
  const columns = rows[0]?.cells.length ?? 0;
  for (const row of node.getChildren('TableRow')) {
    rows.push({ from: row.from, to: row.to, cells: rowCells(doc, row.from, row.to) });
  }
  for (const row of rows) {
    while (row.cells.length < columns) row.cells.push({ from: row.to, to: row.to, missing: true });
    row.cells.length = columns;
  }
  const align = alignments(doc, delimiter.from, delimiter.to);
  while (align.length < columns) align.push(null);
  return {
    from: node.from,
    to: node.to,
    columns,
    align: align.slice(0, columns),
    rows,
    delimiter: { from: delimiter.from, to: delimiter.to },
  };
}

/** The `Table` node whose range contains `pos`, if any. */
export function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Table') return node;
  }
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Table') return node;
  }
  return null;
}

/** The model of the table starting exactly at `from`, if the tree still has one there. */
export function tableModelAt(state: EditorState, from: number): TableModel | null {
  const node = tableNodeAt(state, from);
  return node && node.from === from ? tableModel(node, state.doc) : null;
}

/** The text of a cell, or the empty string for a missing or empty one. */
export function cellText(doc: Text, cell: CellModel): string {
  return doc.sliceString(cell.from, cell.to);
}
