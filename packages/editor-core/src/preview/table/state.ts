import { StateEffect, StateField } from '@codemirror/state';

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
