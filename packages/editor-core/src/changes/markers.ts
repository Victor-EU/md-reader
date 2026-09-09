import { type EditorState, type Extension, StateEffect, StateField } from '@codemirror/state';
import { EditorView, type LayerMarker, layer, RectangleMarker } from '@codemirror/view';
import { type ChangeRecord, mapRecord } from './records.ts';

/**
 * The changes to draw. They are handed in rather than computed here:
 * the shell flattens the buffer and the version it is being compared
 * with into blocks, has Rust align them, and turns the alignment into
 * records (plan WP 2.2).
 */
export const setChanges = StateEffect.define<readonly ChangeRecord[]>();

/**
 * One change taken off the list, by id: the reader reverted it.
 *
 * The scan that follows the revert would drop it anyway a moment later.
 * This is so that the panel goes when the button is pressed rather than
 * when a timer says so, which is the difference between a button that
 * works and one that seems not to.
 */
export const dropChange = StateEffect.define<string>();

/**
 * What has changed, in document order. Mapped through every edit, so a
 * record stays beside its text while the reader types and the next scan
 * catches up; without that the whole margin would shuffle on every
 * keystroke.
 */
export const changesField = StateField.define<readonly ChangeRecord[]>({
  create: () => [],
  update(records, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setChanges)) return effect.value;
    }
    let next = transaction.docChanged
      ? records.map((record) => mapRecord(record, transaction.changes))
      : records;
    for (const effect of transaction.effects) {
      if (effect.is(dropChange)) next = next.filter((record) => record.id !== effect.value);
    }
    return next;
  },
});

/** The records in a state, whether or not the extension is loaded. */
export function changes(state: EditorState): readonly ChangeRecord[] {
  return state.field(changesField, false) ?? [];
}

/** The change a position falls in, ends included, or null. */
export function changeAt(state: EditorState, pos: number): ChangeRecord | null {
  return changes(state).find((record) => pos >= record.from && pos <= record.to) ?? null;
}

/** How far into the measure's own padding the bar sits, and how wide. */
const INSET = 14;
const WIDTH = 3;
/** A deletion has no height of its own, so it is a notch, drawn wider. */
const NOTCH = { inset: 16, width: 9, height: 3 };

/**
 * Where the view is drawing the position, whatever is drawing it.
 *
 * `lineBlockAt` answers in blocks and not in lines, which is the whole
 * reason the marks are measured rather than decorated: a table that live
 * preview has replaced with a widget is one block, and a change inside
 * it has a place on the screen even though the line it is on is not
 * being drawn.
 */
function bars(view: EditorView): readonly LayerMarker[] {
  const records = changes(view.state);
  if (records.length === 0) return [];
  const scroller = view.scrollDOM.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  const base = {
    left: scroller.left - view.scrollDOM.scrollLeft,
    top: scroller.top - view.scrollDOM.scrollTop,
  };
  // Where the text starts, which is the content box plus its own left
  // padding: the measure is centred, so this moves with the window.
  const padding = Number.parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
  const edge = content.left + padding - base.left;
  const top = view.documentTop - base.top;
  const out: RectangleMarker[] = [];
  for (const record of records) {
    // Outside what is rendered there is nothing to measure against, and
    // nothing that could be seen.
    if (record.to < view.viewport.from || record.from > view.viewport.to) continue;
    const first = view.lineBlockAt(Math.min(record.from, view.state.doc.length));
    const kind = `cm-change cm-change-${record.kind}`;
    if (record.kind === 'removed') {
      out.push(
        new RectangleMarker(kind, edge - NOTCH.inset, top + first.top, NOTCH.width, NOTCH.height),
      );
      continue;
    }
    const last = view.lineBlockAt(Math.min(record.to, view.state.doc.length));
    out.push(
      new RectangleMarker(
        kind,
        edge - INSET,
        top + first.top,
        WIDTH,
        Math.max(last.bottom - first.top, NOTCH.height),
      ),
    );
  }
  return out;
}

/**
 * The bars, as a layer over the text.
 *
 * Redrawn whenever the changes, the document or the viewport move; the
 * measuring is one `lineBlockAt` per change against a height map the
 * view keeps anyway, so the cost is the number of changes on the screen.
 */
const changeLayer = layer({
  above: false,
  class: 'cm-changeLayer',
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.transactions.some((tr) =>
      tr.effects.some((effect) => effect.is(setChanges) || effect.is(dropChange)),
    ),
  markers: bars,
});

/**
 * The mark is drawn beside the text, not in a gutter of its own.
 *
 * The measure is centred in the pane (design 11), so a gutter at the
 * editor's left edge would put the mark a third of a screen away from
 * the line it is about. This draws it in the padding the measure already
 * has, and nothing moves when the mode changes.
 */
const changesTheme = EditorView.theme({
  '.cm-changeLayer .cm-change': {
    borderRadius: '2px',
    background: 'var(--mdr-change, #2a6ad9)',
  },
  '.cm-change-added': { '--mdr-change': 'var(--mdr-change-added, #16a34a)' },
  '.cm-change-changed': { '--mdr-change': 'var(--mdr-change-changed, #d97706)' },
  // The same words in another place, which is not the same event as new
  // words and does not read as one (design 7.3 step 4).
  '.cm-change-moved': { '--mdr-change': 'var(--mdr-change-moved, #0ea5e9)' },
  // Nothing of a deleted run is left to mark, so it is a notch above
  // what closed over it rather than a bar beside it.
  '.cm-change-removed': { '--mdr-change': 'var(--mdr-change-removed, #dc2626)' },
});

/**
 * What has happened to the document since the reader last looked
 * (design 4.4).
 */
export function changeMarkers(): Extension {
  return [changesField, changeLayer, changesTheme];
}
