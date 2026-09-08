import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { cellEditorPlugin, tableKeymap } from './cell-editor.ts';
import { activeCellField } from './state.ts';

export {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumnAfter,
  insertRowBelow,
} from './commands.ts';
export {
  type CellModel,
  type RowModel,
  type TableModel,
  tableModel,
  tableModelAt,
} from './model.ts';
export { type ActiveCell, activeCellField, setActiveCell } from './state.ts';

/**
 * In-place cell editing for the table widgets (design 7.1, WP 0.4). The
 * widgets themselves are built by `preview/blocks`, together with every
 * other block widget, so the document is walked once per change.
 */
export function tableWidgets() {
  return [activeCellField, cellEditorPlugin, Prec.high(keymap.of(tableKeymap))];
}
