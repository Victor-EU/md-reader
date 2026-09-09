import type { Extension } from '@codemirror/state';
import { blockWidgetsField } from './blocks/state.ts';
import { commentNotes } from './comment.ts';
import { previewPlugin } from './plugin.ts';
import { tableWidgets } from './table/index.ts';
import { previewTheme } from './theme.ts';

export { type PreviewOptions, previewOptions } from './blocks/options.ts';
export { addProperty, PropertiesWidget, setProperty } from './blocks/properties.ts';
export { blockWidgetsField, changedRegion, widgetBlockStart } from './blocks/state.ts';
export { DiagramWidget, ImageWidget, MathWidget } from './blocks/widgets.ts';
export { buildDecorations, type PreviewDecorations, type VisibleRange } from './build.ts';
export {
  type AnchorRange,
  CommentWidget,
  commentNotes,
  hoveredAnchor,
  setHoveredAnchor,
} from './comment.ts';
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
export {
  codeHighlightStyle,
  markdownHighlightStyle,
  previewTheme,
} from './theme.ts';
export { type CommandTarget, toggleTaskAt } from './widgets.ts';

/**
 * Live preview: decorations over the source, the reveal rule, and the
 * block widgets. What the widgets render with comes from the
 * `previewOptions` facet, which sits outside the mode compartment so a
 * switch to Source and back does not have to carry it.
 */
export function livePreview(): Extension {
  return [previewPlugin, blockWidgetsField, tableWidgets(), commentNotes(), previewTheme];
}
