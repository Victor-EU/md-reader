import type { Text } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import type { Tree } from '@lezer/common';
import { activateCell, cellManager, managerOfDom } from './cell-editor.ts';
import { renderInline } from './inline-dom.ts';
import { cellText, type TableModel, tableModelAt, tableNodeAt } from './model.ts';
import { type ActiveCell, activeCellField, sameActive } from './state.ts';

/** The latest widget instance behind a table element, so event handlers never read stale positions. */
export const widgetOfDom = new WeakMap<HTMLElement, TableWidget>();

/**
 * A rendered table over the source lines. Cells not being edited show
 * their inline markdown; the active cell holds a nested editor managed by
 * `cell-editor.ts`. `updateDOM` patches only the cells whose text or
 * active state changed, so a keystroke in one cell of a hundred-row table
 * touches one element.
 */
export class TableWidget extends WidgetType {
  constructor(
    readonly model: TableModel,
    readonly source: string,
    readonly tree: Tree,
    readonly doc: Text,
    readonly active: ActiveCell | null,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source && sameActive(other.active, this.active);
  }

  override get estimatedHeight(): number {
    return (this.model.rows.length + 1) * 30;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const table = document.createElement('table');
    table.className = 'mdr-table-widget';
    widgetOfDom.set(table, this);
    managerOfDom.set(table, cellManager(view));
    for (let r = 0; r < this.model.rows.length; r++) {
      const section = r === 0 ? table.createTHead() : (table.tBodies[0] ?? table.createTBody());
      const tr = section.insertRow();
      for (let c = 0; c < this.model.columns; c++) {
        const cell = document.createElement(r === 0 ? 'th' : 'td');
        cell.dataset.row = String(r);
        cell.dataset.col = String(c);
        const align = this.model.align[c];
        if (align) cell.style.textAlign = align;
        tr.appendChild(cell);
        this.renderCell(cell, r, c, view);
      }
    }
    table.addEventListener('mousedown', (event) => onMouseDown(view, table, event));
    return table;
  }

  override updateDOM(dom: HTMLElement, view: EditorView, from: TableWidget): boolean {
    if (
      from.model.rows.length !== this.model.rows.length ||
      from.model.columns !== this.model.columns
    )
      return false;
    widgetOfDom.set(dom, this);
    for (let r = 0; r < this.model.rows.length; r++) {
      for (let c = 0; c < this.model.columns; c++) {
        const el = cellElement(dom, r, c);
        if (!el) return false;
        const wasActive = isActive(from.active, r, c);
        const nowActive = isActive(this.active, r, c);
        const oldText = from.cellSource(r, c);
        const newText = this.cellSource(r, c);
        if (wasActive === nowActive && oldText === newText && !nowActive) continue;
        if (nowActive && wasActive) {
          cellManager(view).sync(view, el, this.model, this.active as ActiveCell);
          continue;
        }
        this.renderCell(el, r, c, view);
      }
    }
    return true;
  }

  override destroy(dom: HTMLElement): void {
    const manager = managerOfDom.get(dom);
    if (manager?.isMountedIn(dom)) manager.unmount();
    widgetOfDom.delete(dom);
  }

  cellSource(r: number, c: number): string {
    const cell = this.model.rows[r]?.cells[c];
    return cell ? cellText(this.doc, cell) : '';
  }

  private renderCell(el: HTMLElement, r: number, c: number, view: EditorView): void {
    const cell = this.model.rows[r]?.cells[c];
    if (isActive(this.active, r, c) && this.active && cell) {
      el.replaceChildren();
      el.classList.add('mdr-cell-active');
      cellManager(view).sync(view, el, this.model, this.active);
      return;
    }
    const manager = managerOfDom.get(el.closest('table') as HTMLElement);
    if (manager?.isMountedIn(el)) manager.unmount();
    el.classList.remove('mdr-cell-active');
    el.replaceChildren();
    if (cell && cell.from < cell.to) renderInline(this.tree, this.doc, cell.from, cell.to, el);
  }
}

function isActive(active: ActiveCell | null, r: number, c: number): boolean {
  return !!active && active.row === r && active.col === c;
}

function cellElement(table: HTMLElement, r: number, c: number): HTMLElement | null {
  return table.querySelector(`[data-row="${r}"][data-col="${c}"]`);
}

function onMouseDown(view: EditorView, table: HTMLElement, event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const cell = target?.closest('td,th') as HTMLElement | null;
  if (!cell || cell.closest('table') !== table) return;
  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);
  const active = view.state.field(activeCellField);
  if (target?.closest('a')) return;
  // Positions come from the document at click time, never from the widget,
  // whose model may predate edits elsewhere that mapped it into place.
  const line = view.state.doc.lineAt(view.posAtDOM(table));
  const node = tableNodeAt(view.state, line.to);
  const model = node ? tableModelAt(view.state, node.from) : null;
  if (!model) return;
  if (active && active.table === model.from && active.row === row && active.col === col) return;
  event.preventDefault();
  activateCell(view, model, row, col, { x: event.clientX, y: event.clientY });
}
