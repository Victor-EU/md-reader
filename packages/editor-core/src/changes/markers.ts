import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * What happened to a run of lines between two versions of a document.
 * `removed` marks a place rather than a range: the text that was there is
 * not in the buffer to point at. `moved` is the same words somewhere
 * else, which the semantic engine can tell from a rewrite (design 7.3).
 */
export type ChangeKind = 'added' | 'changed' | 'removed' | 'moved';

/** A run of lines that differ, in the buffer's own 1-based line numbers. */
export interface LineChange {
  from: number;
  /** The line after the run, so `to === from` is a deletion. */
  to: number;
  kind: ChangeKind;
}

/**
 * The change runs to draw. They are handed in rather than computed here:
 * the shell flattens the buffer and the last reviewed snapshot into
 * blocks, has Rust align them, and turns the alignment into runs
 * (plan WP 2.2).
 */
export const setChanges = StateEffect.define<readonly LineChange[]>();

const marks: Record<ChangeKind, Decoration> = {
  added: Decoration.line({ class: 'cm-change cm-change-added' }),
  changed: Decoration.line({ class: 'cm-change cm-change-changed' }),
  removed: Decoration.line({ class: 'cm-change cm-change-removed' }),
  moved: Decoration.line({ class: 'cm-change cm-change-moved' }),
};

function build(doc: Text, changes: readonly LineChange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const change of changes) {
    const first = Math.max(1, Math.min(change.from, doc.lines));
    // A deletion has no lines of its own, so it marks the single line
    // that closed over it.
    const last = Math.max(first, Math.min(change.to - 1, doc.lines));
    for (let line = first; line <= last; line += 1) {
      builder.add(doc.line(line).from, doc.line(line).from, marks[change.kind]);
    }
  }
  return builder.finish();
}

/**
 * Where the marks are. They are mapped through every edit, so a run stays
 * beside its text while the reader types and the next diff catches up;
 * without that the whole margin would shuffle on every keystroke.
 */
export const changesField = StateField.define<DecorationSet>({
  create: () => RangeSet.empty,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setChanges)) return build(transaction.state.doc, effect.value);
    }
    return transaction.docChanged ? current.map(transaction.changes) : current;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The mark is drawn beside the text, not in a gutter of its own.
 *
 * The measure is centred in the pane (design 11), so a gutter at the
 * editor's left edge would put the mark a third of a screen away from
 * the line it is about. This draws it in the padding the measure already
 * has: it costs no layout, and nothing moves when the mode changes.
 */
const changesTheme = EditorView.theme({
  '.cm-line': { position: 'relative' },
  '.cm-change::before': {
    content: '""',
    position: 'absolute',
    left: '-14px',
    top: '0',
    bottom: '0',
    width: '3px',
    borderRadius: '2px',
    background: 'var(--mdr-change, #2a6ad9)',
  },
  '.cm-change-added::before': { '--mdr-change': 'var(--mdr-change-added, #16a34a)' },
  '.cm-change-changed::before': { '--mdr-change': 'var(--mdr-change-changed, #d97706)' },
  // The same words in another place, which is not the same event as new
  // words and does not read as one (design 7.3 step 4).
  '.cm-change-moved::before': { '--mdr-change': 'var(--mdr-change-moved, #0ea5e9)' },
  // Nothing of a deleted run is left to mark, so it is a notch above the
  // line that closed over it rather than a bar beside it.
  '.cm-change-removed::before': {
    '--mdr-change': 'var(--mdr-change-removed, #dc2626)',
    left: '-16px',
    bottom: 'auto',
    height: '3px',
    width: '9px',
  },
});

/**
 * What has happened to the document since the reader last said they had
 * seen it (design 4.4).
 */
export function changeMarkers(): Extension {
  return [changesField, changesTheme];
}
