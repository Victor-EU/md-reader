import type { Extension } from '@codemirror/state';
import { previewPlugin } from './plugin.ts';
import { tableWidgets } from './table/index.ts';
import { previewTheme } from './theme.ts';

export { buildDecorations, type PreviewDecorations, type VisibleRange } from './build.ts';
export { type RevealRange, revealRanges } from './reveal.ts';
export {
  type ActiveCell,
  activeCellField,
  type CellModel,
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumnAfter,
  insertRowBelow,
  type RowModel,
  setActiveCell,
  type TableModel,
  tableModel,
  tableModelAt,
} from './table/index.ts';
export { markdownHighlightStyle, previewTheme } from './theme.ts';
export { toggleTaskAt } from './widgets.ts';

/** Live preview: decorations over the source, the reveal rule, and the table widgets. */
export function livePreview(): Extension {
  return [previewPlugin, tableWidgets(), previewTheme];
}
