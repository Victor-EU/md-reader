import { defaultKeymap, redo, undo } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import {
  type ChangeDesc,
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { extensions as dialect } from '@markdown/markdown';
import { markdownHighlightStyle } from '../theme.ts';
import { escapePipes, insertRowBelow, materializeCell, rebaseCellChanges } from './commands.ts';
import { type CellModel, cellText, type TableModel, tableModelAt, tableNodeAt } from './model.ts';
import { type ActiveCell, activeCellField, type CursorHint, setActiveCell } from './state.ts';

const managers = new WeakMap<EditorView, CellEditorManager>();
/** Table elements to the manager of their outer view, for `WidgetType.destroy`, which has no view. */
export const managerOfDom = new WeakMap<HTMLElement, CellEditorManager>();

export function cellManager(view: EditorView): CellEditorManager {
  let manager = managers.get(view);
  if (!manager) {
    manager = new CellEditorManager(view);
    managers.set(view, manager);
  }
  return manager;
}

const cellLanguage = markdown({ base: commonmarkLanguage, extensions: dialect, addKeymap: false });

/**
 * Keep a cell's document on one line and escape typed pipes. Composition
 * transactions pass through untouched: an IME insertion is not cancelable
 * and must reach the view exactly as the DOM already shows it.
 */
function cellTransactionFilter(tr: Transaction): TransactionSpec | readonly TransactionSpec[] {
  if (!tr.docChanged) return tr;
  if (tr.newDoc.lines > 1) return [];
  const compose = tr.isUserEvent('input.type.compose');
  const typed = (tr.isUserEvent('input.type') && !compose) || tr.isUserEvent('input.paste');
  if (!typed) return tr;
  let touched = false;
  const changes: { from: number; to: number; insert: string }[] = [];
  let lastFrom = 0;
  // Each insertion is escaped against the cell as it will read once every
  // change in front of it has landed, never against the keystroke on its
  // own: whether a pipe is a delimiter is decided by the backslashes
  // before it, and those are usually text the reader typed earlier.
  let before = '';
  let prevTo = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    before += tr.startState.doc.sliceString(prevTo, fromA);
    const text = inserted.toString();
    const escaped = escapePipes(text, before);
    if (escaped !== text) touched = true;
    changes.push({ from: fromA, to: toA, insert: escaped });
    before += escaped;
    prevTo = toA;
    lastFrom = fromA;
  });
  if (!touched) return tr;
  const set = ChangeSet.of(changes, tr.startState.doc.length);
  const userEvent = tr.annotation(Transaction.userEvent);
  return {
    changes: set,
    selection: EditorSelection.cursor(set.mapPos(lastFrom, 1)),
    ...(userEvent ? { userEvent } : {}),
  };
}

/**
 * Owns the one nested `EditorView` that edits a table cell in place.
 *
 * The nested document is the cell's source text and nothing else. Its
 * transactions are intercepted: the nested view applies them first, so
 * the DOM the browser just mutated (composition included) stays in step,
 * and the same changes are then dispatched on the outer document shifted
 * by the cell's start, with the same user event so undo groups as usual.
 * The outer update rebuilds the widget, which calls `sync`; there the nested
 * document is verified against the span it occupies in the outer one and
 * overwritten from it whenever the two disagree. That span is not the cell's
 * model range: `rowCells` trims a cell to its content, while a space typed at
 * either edge is content to the person typing and becomes padding only once
 * they leave. `cellStart` holds the span so a rebase lands after such a space
 * instead of in front of it. The outer document is the truth; the nested view
 * is a projection that is allowed to be first only because it is verified
 * immediately after.
 */
export class CellEditorManager {
  private nested: EditorView | null = null;
  private td: HTMLElement | null = null;
  /** Click coordinates from the activation, consumed on mount to place the cursor. */
  pendingCoords: { x: number; y: number } | null = null;
  /**
   * Set by an activation and consumed by the next mount: the reader asked
   * for this cell, so the cell takes the focus and is scrolled to. A mount
   * nobody asked for must do neither. The widget is rebuilt whenever the
   * table gains or loses a row, which an agent writing to the document can
   * do at any moment, and it is built again every time the table scrolls
   * back into the viewport; a cell that grabbed the focus on those would
   * take it out of the find bar or the palette while the reader was typing
   * there.
   */
  pendingFocus = false;
  /**
   * Whether the reader is in the nested view. Kept by its own focus and
   * blur, because a mount cannot ask the DOM about a view that has just
   * been destroyed, and the rebuilds above happen under the reader's
   * fingers: the cell has to come back focused if that is where they were.
   */
  private focused = false;
  /** True while we are tearing the nested view down, whose blur means nothing. */
  private unmounting = false;
  private syncing = false;
  /**
   * Where the nested document starts in the outer one. It is the cell's
   * trimmed start when the cell opens, and stops being it the moment the
   * user types a space at either edge: `rowCells` trims the model's cell
   * range, so a space typed at the end of a cell falls outside it while it
   * is still, to the person typing, part of what they are writing. The
   * nested document keeps those blanks and this offset keeps the span they
   * occupy, so a rebase lands after them instead of in front of them.
   */
  private cellStart: number | null = null;
  /** True while this manager's own nested change is being dispatched on the outer view. */
  private rebasing = false;

  constructor(private readonly outer: EditorView) {}

  isMountedIn(dom: Node): boolean {
    return !!this.td && (dom === this.td || dom.contains(this.td));
  }

  /** Make `td` the editing cell for `active`, mounting or updating the nested view. */
  sync(_view: EditorView, td: HTMLElement, model: TableModel, active: ActiveCell): void {
    const cell = model.rows[active.row]?.cells[active.col];
    const text = cell ? cellText(this.outer.state.doc, cell) : '';
    if (this.nested && this.td === td) {
      // Our own rebase, already verified against the document: the nested view
      // is the truth about its own edge blanks, and `text` has had them trimmed
      // off, so overwriting with it here is what used to eat typed spaces.
      if (this.rebasing && this.nestedMatchesDoc(cell)) return;
      this.resync(text, active.cursor);
      this.cellStart = cell?.from ?? null;
      return;
    }
    const takeFocus = this.pendingFocus || (this.focused && !this.focusIsAway());
    this.pendingFocus = false;
    if (this.nested) this.unmount();
    this.td = td;
    this.cellStart = cell?.from ?? null;
    td.classList.add('mdr-cell-active');
    const coords = active.cursor === 'coords' ? this.pendingCoords : null;
    this.pendingCoords = null;
    const state = EditorState.create({
      doc: text,
      selection: cursorFor(active.cursor, text, 0),
      extensions: [
        keymap.of(cellKeymap(this)),
        keymap.of(defaultKeymap),
        EditorView.lineWrapping,
        cellLanguage,
        syntaxHighlighting(markdownHighlightStyle),
        EditorState.transactionFilter.of(cellTransactionFilter),
        EditorView.contentAttributes.of({ 'aria-label': 'table cell' }),
      ],
    });
    const nested = new EditorView({
      state,
      parent: td,
      dispatchTransactions: (trs) => this.onNested(trs),
    });
    this.nested = nested;
    nested.contentDOM.addEventListener('focus', () => {
      this.focused = true;
    });
    nested.contentDOM.addEventListener('blur', () => {
      if (!this.unmounting) this.focused = false;
    });
    queueMicrotask(() => {
      if (this.nested !== nested) return;
      if (takeFocus) nested.focus();
      if (coords) {
        const pos = nested.posAtCoords(coords);
        if (pos !== null) nested.dispatch({ selection: { anchor: pos } });
      }
      // A clicked cell is on screen already; one reached by Tab or an arrow
      // key from a line above the fold is not, and the outer view does not
      // scroll for a cursor it no longer owns.
      if (takeFocus) td.scrollIntoView({ block: 'nearest' });
    });
  }

  unmount(): void {
    this.td?.classList.remove('mdr-cell-active');
    this.unmounting = true;
    this.nested?.destroy();
    this.unmounting = false;
    this.nested = null;
    this.td = null;
    this.cellStart = null;
  }

  /**
   * True when the focus is somewhere the reader put it that is not this
   * editor's text: the find bar, the palette, a dialog. A view destroyed
   * out from under a reader who was typing in it leaves the focus on the
   * body instead, and that much is ours to take back; nothing else is.
   */
  private focusIsAway(): boolean {
    const root = this.outer.dom.ownerDocument;
    const active = root.activeElement;
    return !!active && active !== root.body && !this.outer.contentDOM.contains(active);
  }

  /**
   * Move the nested document's start along with the outer document. A
   * write that lands above the table without disturbing the table's own
   * block never rebuilds the widget -- Lezer hands the same block back and
   * the decoration is only mapped -- so nothing else here would notice
   * that every offset below it has moved. The next keystroke would then
   * read the wrong span, fail the check in `onNested`, and be thrown away
   * as drift while the reader watched their letter not arrive.
   */
  mapCellStart(changes: ChangeDesc): void {
    if (this.cellStart !== null) this.cellStart = changes.mapPos(this.cellStart, -1);
  }

  /**
   * Does the outer document still hold exactly what the nested view shows,
   * over the span the nested document occupies? The span has to cover the
   * whole trimmed cell, so a nested view that has fallen behind the model
   * fails this and is overwritten rather than rebased onto the wrong text.
   */
  private nestedMatchesDoc(cell: CellModel | undefined): boolean {
    const nested = this.nested;
    if (!nested || !cell || this.cellStart === null) return false;
    const current = nested.state.doc.toString();
    const from = this.cellStart;
    const to = from + current.length;
    if (from > cell.from || to < cell.to) return false;
    return this.outer.state.doc.sliceString(from, to) === current;
  }

  destroy(): void {
    this.unmount();
  }

  /** The nested cursor offset within the cell, or 0. */
  head(): number {
    return this.nested?.state.selection.main.head ?? 0;
  }

  private resync(text: string, cursor: CursorHint): void {
    const nested = this.nested;
    if (!nested) return;
    const current = nested.state.doc.toString();
    if (current === text && cursor === 'keep') return;
    this.syncing = true;
    try {
      const head = nested.state.selection.main.head;
      const selection =
        cursor === 'keep'
          ? EditorSelection.cursor(Math.min(head, text.length))
          : cursorFor(cursor, text, head);
      nested.update([
        nested.state.update({
          changes: current === text ? undefined : { from: 0, to: current.length, insert: text },
          selection,
        }),
      ]);
    } finally {
      this.syncing = false;
    }
  }

  /** The active cell as the outer state knows it; its table position is kept mapped there. */
  private current(): ActiveCell | null {
    return this.outer.state.field(activeCellField);
  }

  private onNested(trs: readonly Transaction[]): void {
    const nested = this.nested;
    if (!nested) return;
    for (const tr of trs) {
      nested.update([tr]);
      const active = this.current();
      if (!tr.docChanged || this.syncing || !active) continue;
      const model = tableModelAt(this.outer.state, active.table);
      const cell = model?.rows[active.row]?.cells[active.col];
      if (!cell) continue;
      const before = tr.startState.doc.toString();
      const from = this.cellStart ?? cell.from;
      const to = from + before.length;
      // The span must still read back as the document the nested view had, and
      // must cover the trimmed cell; anything else means the two have drifted.
      if (
        from > cell.from ||
        to < cell.to ||
        this.outer.state.doc.sliceString(from, to) !== before
      ) {
        this.cellStart = cell.from;
        this.resync(cellText(this.outer.state.doc, cell), 'keep');
        continue;
      }
      const userEvent = tr.annotation(Transaction.userEvent);
      this.rebasing = true;
      try {
        this.outer.dispatch({
          changes: rebaseCellChanges(from, tr.changes),
          effects: setActiveCell.of({ ...active, cursor: 'keep' }),
          ...(userEvent ? { userEvent } : {}),
          scrollIntoView: false,
        });
      } finally {
        this.rebasing = false;
      }
    }
  }

  /** Move the nested editor to another cell of the same table. */
  moveTo(row: number, col: number, cursor: CursorHint): boolean {
    const active = this.current();
    if (!active) return false;
    const model = tableModelAt(this.outer.state, active.table);
    if (!model || row < 0 || row >= model.rows.length || col < 0 || col >= model.columns)
      return false;
    activateCell(this.outer, model, row, col, null, cursor);
    return true;
  }

  /** Leave the table: put the outer cursor at `pos` and close the cell. */
  exitTo(pos: number): void {
    const outer = this.outer;
    outer.dispatch({
      selection: { anchor: pos },
      effects: setActiveCell.of(null),
      scrollIntoView: true,
    });
    outer.focus();
  }

  currentModel(): { model: TableModel; active: ActiveCell } | null {
    const active = this.current();
    if (!active) return null;
    const model = tableModelAt(this.outer.state, active.table);
    return model ? { model, active } : null;
  }

  get outerView(): EditorView {
    return this.outer;
  }
}

function cursorFor(hint: CursorHint, text: string, keep: number): EditorSelection {
  const pos =
    hint === 'start' || hint === 'coords'
      ? 0
      : hint === 'end'
        ? text.length
        : hint === 'keep'
          ? Math.min(keep, text.length)
          : Math.min(hint, text.length);
  return EditorSelection.single(pos);
}

/**
 * Start editing cell (row, col) of `model` in place. A cell the source
 * does not have yet is written first, as ` |`, so the nested document has
 * a range to own.
 */
export function activateCell(
  view: EditorView,
  model: TableModel,
  row: number,
  col: number,
  coords: { x: number; y: number } | null,
  cursor: CursorHint = coords ? 'coords' : 'end',
): void {
  const cell = model.rows[row]?.cells[col];
  if (!cell) return;
  const manager = cellManager(view);
  manager.pendingCoords = coords;
  manager.pendingFocus = true;
  const changes = cell.missing ? materializeCell(view.state, model.from, row, col) : null;
  view.dispatch({
    ...(changes ? { changes } : {}),
    effects: setActiveCell.of({
      table: model.from,
      row,
      col,
      cursor: cell.missing ? 'end' : cursor,
    }),
  });
}

function cellKeymap(manager: CellEditorManager) {
  const outer = manager.outerView;
  const tableRange = () => manager.currentModel();
  const nextCell = (): boolean => {
    const current = tableRange();
    if (!current) return false;
    const { model, active } = current;
    if (active.col + 1 < model.columns) return manager.moveTo(active.row, active.col + 1, 'end');
    if (active.row + 1 < model.rows.length) return manager.moveTo(active.row + 1, 0, 'end');
    const change = insertRowBelow(outer.state, model.from, active.row);
    if (!change) return false;
    outer.dispatch({
      changes: change,
      effects: setActiveCell.of({ table: model.from, row: active.row + 1, col: 0, cursor: 'end' }),
      userEvent: 'input.table.row',
    });
    return true;
  };
  const prevCell = (): boolean => {
    const current = tableRange();
    if (!current) return false;
    const { model, active } = current;
    if (active.col > 0) return manager.moveTo(active.row, active.col - 1, 'end');
    if (active.row > 0) return manager.moveTo(active.row - 1, model.columns - 1, 'end');
    return true;
  };
  const exitAbove = (): boolean => {
    const current = tableRange();
    if (!current) return false;
    const line = outer.state.doc.lineAt(current.model.from);
    manager.exitTo(line.number > 1 ? outer.state.doc.line(line.number - 1).to : 0);
    return true;
  };
  const exitBelow = (): boolean => {
    const current = tableRange();
    if (!current) return false;
    const line = outer.state.doc.lineAt(current.model.to);
    manager.exitTo(
      line.number < outer.state.doc.lines ? outer.state.doc.line(line.number + 1).from : line.to,
    );
    return true;
  };
  const rowDelta = (delta: number, atEdge: () => boolean) => (): boolean => {
    const current = tableRange();
    if (!current) return false;
    const { model, active } = current;
    const row = active.row + delta;
    if (row < 0 || row >= model.rows.length) return atEdge();
    return manager.moveTo(row, active.col, 'keep');
  };
  return [
    { key: 'Tab', run: nextCell, shift: prevCell },
    { key: 'Enter', run: rowDelta(1, exitBelow) },
    { key: 'ArrowUp', run: rowDelta(-1, exitAbove) },
    { key: 'ArrowDown', run: rowDelta(1, exitBelow) },
    {
      key: 'ArrowLeft',
      run: (nested: EditorView) => (nested.state.selection.main.head === 0 ? prevCell() : false),
    },
    {
      key: 'ArrowRight',
      run: (nested: EditorView) =>
        nested.state.selection.main.head === nested.state.doc.length ? nextCell() : false,
    },
    {
      key: 'Escape',
      run: () => {
        const current = tableRange();
        if (!current) return false;
        const cell = current.model.rows[current.active.row]?.cells[current.active.col];
        manager.exitTo((cell?.from ?? current.model.from) + manager.head());
        return true;
      },
    },
    { key: 'Mod-z', run: () => undo(outer), preventDefault: true },
    { key: 'Mod-y', mac: 'Mod-Shift-z', run: () => redo(outer), preventDefault: true },
  ];
}

/** Arrow keys on the line next to a table widget enter it, so keyboard users are not locked out. */
function enterTable(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const target = line.number + direction;
  if (target < 1 || target > state.doc.lines) return false;
  const next = state.doc.line(target);
  const node = tableNodeAt(state, direction > 0 ? next.from + (next.length ? 1 : 0) : next.to);
  if (!node) return false;
  const edge = direction > 0 ? state.doc.lineAt(node.from) : state.doc.lineAt(node.to);
  if (edge.number !== next.number) return false;
  const model = tableModelAt(state, node.from);
  if (!model || state.field(activeCellField)) return false;
  activateCell(view, model, direction > 0 ? 0 : model.rows.length - 1, 0, null, 'start');
  return true;
}

/** True when `lineNumber` is the last line of a table, which is the model of that table. */
function tableEndingAt(state: EditorState, lineNumber: number): TableModel | null {
  const line = state.doc.line(lineNumber);
  const node = tableNodeAt(state, line.to);
  if (!node || state.doc.lineAt(node.to).number !== lineNumber) return null;
  return tableModelAt(state, node.from);
}

/**
 * Backspace at the start of the line under a table, or of the first text
 * line after the blank line under it, opens the table's last cell instead
 * of joining. Joining would splice the line into the last row, and taking
 * the blank line away would make the paragraph a row of its own, since a
 * table runs until a blank line; neither is what a writer backing up to
 * a table means.
 */
function backspaceIntoTable(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  if (!sel.empty || sel.head !== line.from || line.number < 2) return false;
  if (state.field(activeCellField)) return false;
  let model = tableEndingAt(state, line.number - 1);
  if (!model && line.number > 2 && line.text.trim() !== '') {
    const blank = state.doc.line(line.number - 1);
    if (blank.text.trim() === '') model = tableEndingAt(state, line.number - 2);
  }
  if (!model) return false;
  activateCell(view, model, model.rows.length - 1, model.columns - 1, null, 'end');
  return true;
}

export const tableKeymap = [
  { key: 'ArrowDown', run: (view: EditorView) => enterTable(view, 1) },
  { key: 'ArrowUp', run: (view: EditorView) => enterTable(view, -1) },
  { key: 'Backspace', run: backspaceIntoTable },
];

/** Keeps the open cell's offset in step with the document, and tears the nested view down with it. */
export const cellEditorPlugin = ViewPlugin.define((view) => ({
  update(update: ViewUpdate) {
    if (update.docChanged) managers.get(view)?.mapCellStart(update.changes);
  },
  destroy() {
    managers.get(view)?.destroy();
    managers.delete(view);
  },
}));
