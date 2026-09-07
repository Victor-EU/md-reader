import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { cellEditorPlugin, tableKeymap } from './cell-editor.ts';
import { activeCellField, tableWidgetsField } from './state.ts';

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

/** Table widgets with in-place cell editing (design 7.1, WP 0.4). */
export function tableWidgets() {
  return [activeCellField, tableWidgetsField, cellEditorPlugin, Prec.high(keymap.of(tableKeymap))];
}
