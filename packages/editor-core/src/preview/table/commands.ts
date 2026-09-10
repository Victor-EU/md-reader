import type { ChangeSet, ChangeSpec, EditorState, Text } from '@codemirror/state';
import {
  type CellModel,
  cellText,
  type RowModel,
  rowCells,
  type TableModel,
  tableModelAt,
} from './model.ts';

/**
 * Structural table edits as plain change specs on the outer document.
 * Each is explicit and may produce a larger diff than a cell edit by
 * design (design 7.1); none rewrites cells it does not have to.
 */

/** The text before a row's first cell on its line: list indentation or `> ` markers. */
function linePrefix(doc: Text, row: RowModel): string {
  const line = doc.lineAt(row.from);
  return doc.sliceString(line.from, row.from);
}

/** Two spaces per cell, so text typed into one gets the ` | x |` padding a hand-typed row has. */
function emptyRow(columns: number): string {
  return `|${'  |'.repeat(columns)}`;
}

/** Insert an empty row after row `index` (0 is the header). */
export function insertRowBelow(
  state: EditorState,
  tableFrom: number,
  index: number,
): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  const row = table?.rows[index];
  if (!table || !row) return null;
  const at = index === 0 ? table.delimiter.to : row.to;
  return { from: at, insert: `\n${linePrefix(state.doc, row)}${emptyRow(table.columns)}` };
}

/** Delete body row `index`; the header cannot be deleted. */
export function deleteRow(state: EditorState, tableFrom: number, index: number): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  const row = table?.rows[index];
  if (!table || !row || index === 0) return null;
  const line = state.doc.lineAt(row.from);
  return { from: line.from - 1, to: line.to };
}

/** Insert an empty column after column `col`, in every row and the delimiter. */
export function insertColumnAfter(
  state: EditorState,
  tableFrom: number,
  col: number,
): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  if (!table || col < 0 || col >= table.columns) return null;
  const changes: ChangeSpec[] = [];
  /**
   * The new cell goes after the pipe that closes the one we are inserting
   * after, wherever on the line that pipe is. A row that runs off the end
   * of its line without a closing pipe has none, and then the text needs a
   * pipe of its own in front of it: appended straight onto the last cell it
   * would lengthen that cell instead of starting a new one, and in the
   * delimiter row it would leave `--- ---`, which is not a delimiter row,
   * so the parse loses the whole table.
   */
  const insertAfterCell = (cell: CellModel, text: string) => {
    const pipe = firstPipeAfter(state.doc, cell.to);
    changes.push(
      pipe === null ? { from: cell.to, insert: ` |${text}` } : { from: pipe + 1, insert: text },
    );
  };
  for (const row of table.rows) {
    const cell = row.cells[col];
    if (!cell || cell.missing) {
      changes.push({ from: row.to, insert: `${rowNeedsPipe(state.doc, row) ? ' |' : ''} |` });
    } else {
      insertAfterCell(cell, '  |');
    }
  }
  const delimiterCells = rowCellsOf(state, table.delimiter.from, table.delimiter.to);
  const dcell = delimiterCells[col];
  if (dcell) insertAfterCell(dcell, ' --- |');
  return changes;
}

/** Delete column `col` from every row and the delimiter; a table keeps at least one column. */
export function deleteColumn(
  state: EditorState,
  tableFrom: number,
  col: number,
): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  if (!table || table.columns < 2 || col < 0 || col >= table.columns) return null;
  const changes: ChangeSpec[] = [];
  /**
   * The cell goes, and with it exactly one of the two pipes beside it, so
   * that the columns after it move up by one. Which one depends on what
   * the row has: normally the pipe in front, leaving the pipe behind as
   * the separator that follows the previous cell. A first cell on a row
   * that opens without a pipe has nothing in front of it, and a last cell
   * on a row that closes without one has nothing behind it; in both the
   * pipe that is there has to stay, as a leading or a trailing pipe. A row
   * left out here keeps a cell the header lost, which slides a column of
   * the reader's data under the wrong heading. A row with no pipes at all
   * is one cell on a line of its own, and what is left of it becomes a
   * bare `|`: the empty line it would otherwise be ends the table.
   *
   * A pipe left opening a row has to be able to close it as well. `| ---`
   * is not a delimiter row -- the parser wants a pipe after the dashes and
   * not only in front of them -- so when the pipe we keep is the row's
   * first and last, the row is closed with one of its own, and a table can
   * lose its second-to-last column and still be a table.
   */
  const removeCell = (cells: CellModel[], index: number, from: number, to: number) => {
    const cell = cells[index];
    if (!cell || cell.missing) return;
    const prevPipe = lastPipeBefore(state.doc, cell.from);
    const nextPipe = firstPipeAfter(state.doc, cell.to);
    if (nextPipe !== null) {
      const start = prevPipe ?? from;
      changes.push({ from: start, to: nextPipe });
      if (start === from && firstPipeAfter(state.doc, nextPipe + 1) === null)
        changes.push({ from: to, insert: ' |' });
    } else if (prevPipe !== null) changes.push({ from: prevPipe + 1, to });
    else changes.push({ from, to, insert: '|' });
  };
  for (const row of table.rows) removeCell(row.cells, col, row.from, row.to);
  const { from, to } = table.delimiter;
  removeCell(rowCellsOf(state, from, to), col, from, to);
  return changes;
}

/**
 * Rewrite the whole table with padded cells and aligned pipes. The one
 * command that touches every row; cell contents are preserved exactly.
 *
 * That includes the cells of a row wider than the header, which go back
 * after the last column, unpadded because they have no column to be as
 * wide as. GFM does not draw them and neither does the widget, but they
 * are what the file says, and formatting is not a licence to delete a
 * reader's text on the way past.
 */
export function formatTable(state: EditorState, tableFrom: number): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  if (!table) return null;
  const texts = table.rows.map((row) => row.cells.map((c) => cellText(state.doc, c)));
  const extras = table.rows.map((row) => row.extra.map((c) => cellText(state.doc, c)));
  const widths = Array.from({ length: table.columns }, (_, c) =>
    Math.max(3, ...texts.map((row) => displayWidth(row[c] ?? ''))),
  );
  const pad = (text: string, c: number) => {
    const extra = (widths[c] ?? 0) - displayWidth(text);
    const align = table.align[c];
    if (align === 'right') return `${' '.repeat(extra)}${text}`;
    if (align === 'center')
      return `${' '.repeat(Math.floor(extra / 2))}${text}${' '.repeat(Math.ceil(extra / 2))}`;
    return `${text}${' '.repeat(extra)}`;
  };
  const line = (cells: string[], extra: string[]) =>
    `| ${[...cells.map(pad), ...extra].join(' | ')} |`;
  const delimiter = `| ${widths
    .map((w, c) => {
      const a = table.align[c];
      const dashes = '-'.repeat(Math.max(1, w - (a === 'center' ? 2 : a ? 1 : 0)));
      return a === 'center'
        ? `:${dashes}:`
        : a === 'right'
          ? `${dashes}:`
          : a === 'left'
            ? `:${dashes}`
            : dashes;
    })
    .join(' | ')} |`;
  const changes: ChangeSpec[] = [];
  table.rows.forEach((row, i) => {
    const next = line(texts[i] ?? [], extras[i] ?? []);
    if (state.doc.sliceString(row.from, row.to) !== next)
      changes.push({ from: row.from, to: row.to, insert: next });
  });
  if (state.doc.sliceString(table.delimiter.from, table.delimiter.to) !== delimiter) {
    changes.push({ from: table.delimiter.from, to: table.delimiter.to, insert: delimiter });
  }
  return changes.length ? changes : null;
}

/** Width in columns of monospace text; East Asian wide characters count double. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Materialize a missing cell so it can be edited: appends ` |` (and a closing pipe) to the row. */
export function materializeCell(
  state: EditorState,
  tableFrom: number,
  rowIndex: number,
  col: number,
): ChangeSpec | null {
  const table = tableModelAt(state, tableFrom);
  const row = table?.rows[rowIndex];
  if (!table || !row) return null;
  const present = row.cells.filter((c) => !c.missing).length;
  if (col < present) return null;
  const needed = col - present + 1;
  const needsPipe = rowNeedsPipe(state.doc, row);
  return { from: row.to, insert: `${needsPipe ? ' |' : ''}${'  |'.repeat(needed)}` };
}

function rowNeedsPipe(doc: Text, row: RowModel): boolean {
  const text = doc.sliceString(row.from, row.to).trimEnd();
  return !(text.endsWith('|') && !text.endsWith('\\|'));
}

function rowCellsOf(state: EditorState, from: number, to: number): CellModel[] {
  return rowCells(state.doc, from, to);
}

function lastPipeBefore(doc: Text, pos: number): number | null {
  const line = doc.lineAt(pos);
  const text = doc.sliceString(line.from, pos);
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === 124 && (i === 0 || text.charCodeAt(i - 1) !== 92))
      return line.from + i;
  }
  return null;
}

function firstPipeAfter(doc: Text, pos: number): number | null {
  const line = doc.lineAt(pos);
  const text = doc.sliceString(pos, line.to);
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 92) {
      i++;
      continue;
    }
    if (text.charCodeAt(i) === 124) return pos + i;
  }
  return null;
}

export type { TableModel };

/**
 * Turn changes made to a cell's own text into changes on the outer
 * document. The nested editor's document is exactly the cell's source, so
 * every offset shifts by the cell's start and nothing else moves.
 */
export function rebaseCellChanges(
  cellFrom: number,
  changes: ChangeSet,
): { from: number; to: number; insert: string }[] {
  const out: { from: number; to: number; insert: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: cellFrom + fromA, to: cellFrom + toA, insert: inserted.toString() });
  });
  return out;
}

/**
 * A literal `|` going into a cell must not split it; it becomes `\|`.
 *
 * What decides whether a pipe is literal is the run of backslashes in
 * front of it: an odd run escapes it, an even one leaves it a delimiter,
 * which is how both `rowCells` and the parser read a row. So the run has
 * to be counted over the text the pipe will actually sit in, and `before`
 * is that text -- everything the insertion lands after. Escaping against
 * the inserted string alone turns a `|` typed after a backslash the reader
 * typed a moment ago into `\\|`, an escaped backslash followed by a live
 * delimiter, and the cell splits in two.
 */
export function escapePipes(text: string, before = ''): string {
  let run = 0;
  while (run < before.length && before[before.length - 1 - run] === '\\') run++;
  let out = '';
  for (const ch of text) {
    if (ch === '|') {
      out += run % 2 === 0 ? '\\|' : ch;
      run = 0;
    } else {
      out += ch;
      run = ch === '\\' ? run + 1 : 0;
    }
  }
  return out;
}
