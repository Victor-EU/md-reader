import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { widgetBlockStart } from '../preview/blocks/state.ts';
import { revertChange } from './commands.ts';
import { changes, changesField } from './markers.ts';
import type { ChangeKind, ChangePart, ChangeRecord } from './records.ts';

/**
 * Review mode (design 4.4): every change shown where it happened, as the
 * words that went and the words that came, with a way to put each one
 * back.
 *
 * The panel holds both versions rather than marking one of them in the
 * buffer. The buffer is the new version, in the reader's own live
 * preview, and the words that are no longer in it have nowhere in it to
 * be drawn; a mark on what arrived would say a change happened without
 * saying what it was. What the engine compared is the normalized text of
 * each block (design 7.3), and that is what this shows, so the panel and
 * the marks can never disagree about what changed.
 */

const labels: Record<ChangeKind, string> = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
  moved: 'Moved here',
};

class ReviewWidget extends WidgetType {
  constructor(
    readonly record: ChangeRecord,
    readonly current: boolean,
  ) {
    super();
  }

  override eq(other: ReviewWidget): boolean {
    return (
      other.record.id === this.record.id &&
      other.current === this.current &&
      other.record.parts === this.record.parts &&
      other.record.revert.length === this.record.revert.length
    );
  }

  /**
   * The panel is chrome, not text: clicks inside it are the button's and
   * the selection's, and the editor should not try to put a cursor in it.
   */
  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    const body = this.record.parts.reduce((sum, part) => sum + part.text.length, 0);
    return 26 + (body === 0 ? 0 : 21 * Math.ceil(body / 70));
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = `mdr-review mdr-review-${this.record.kind}`;
    if (this.current) el.classList.add('mdr-review-current');
    el.dataset.change = this.record.id;
    const bar = document.createElement('div');
    bar.className = 'mdr-review-bar';
    const label = document.createElement('span');
    label.className = 'mdr-review-label';
    label.textContent = labels[this.record.kind];
    bar.append(label);
    if (this.record.revert.length > 0) bar.append(button(view, this.record));
    else bar.append(note('nothing left to put it back beside'));
    el.append(bar);
    if (this.record.parts.length > 0) el.append(body(this.record.parts));
    return el;
  }
}

/**
 * A button that does not take the selection with it. `mousedown` is
 * where the editor would move the cursor, which would scroll the reader
 * away from what they are deciding about.
 */
function button(view: EditorView, record: ChangeRecord): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'mdr-review-revert';
  el.tabIndex = -1;
  el.textContent = 'Revert';
  el.addEventListener('mousedown', (event) => event.preventDefault());
  el.addEventListener('click', (event) => {
    event.preventDefault();
    revertChange(view, record.id);
  });
  return el;
}

function note(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mdr-review-note';
  el.textContent = text;
  return el;
}

const tags: Record<ChangePart['kind'], string> = {
  same: 'span',
  gone: 'del',
  new: 'ins',
  gap: 'span',
};

function body(parts: readonly ChangePart[]): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mdr-review-body';
  for (const part of parts) {
    const piece = document.createElement(tags[part.kind]);
    piece.className = `mdr-review-${part.kind}`;
    piece.textContent = part.kind === 'gap' ? ' … ' : part.text;
    el.append(piece);
  }
  return el;
}

/**
 * The panel goes above the line the change starts on -- unless live
 * preview has replaced that line with a widget, in which case it goes
 * above the widget. A panel anchored inside a replaced block is not
 * drawn at all, and a change nobody can see is the one thing Review mode
 * must never have.
 */
function build(state: EditorState): DecorationSet {
  const head = state.selection.main.head;
  const ranges: Range<Decoration>[] = [];
  for (const record of changes(state)) {
    const from = Math.min(record.from, state.doc.length);
    const at = widgetBlockStart(state, from) ?? state.doc.lineAt(from).from;
    const current = head >= record.from && head <= record.to;
    ranges.push(
      Decoration.widget({
        widget: new ReviewWidget(record, current),
        block: true,
        side: -1,
      }).range(at),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * Colours come from the same variables the margin marks use, so a change
 * is one colour wherever it is drawn and a theme restyles both at once.
 */
const reviewTheme = EditorView.baseTheme({
  '.mdr-review': {
    fontSize: '0.85em',
    lineHeight: '1.6',
    margin: '2px 0',
    padding: '2px 8px',
    borderRadius: '4px',
    borderLeft: '3px solid var(--mdr-review-tint, #2a6ad9)',
    background: 'color-mix(in srgb, var(--mdr-review-tint, #2a6ad9) 7%, transparent)',
  },
  '.mdr-review-added': { '--mdr-review-tint': 'var(--mdr-change-added, #16a34a)' },
  '.mdr-review-changed': { '--mdr-review-tint': 'var(--mdr-change-changed, #d97706)' },
  '.mdr-review-removed': { '--mdr-review-tint': 'var(--mdr-change-removed, #dc2626)' },
  '.mdr-review-moved': { '--mdr-review-tint': 'var(--mdr-change-moved, #0ea5e9)' },
  // The one the reader is standing in. Stepping is what makes Review a
  // walk rather than a wall of panels, and the walk has to be visible.
  '.mdr-review-current': {
    background: 'color-mix(in srgb, var(--mdr-review-tint, #2a6ad9) 16%, transparent)',
  },
  '.mdr-review-bar': { display: 'flex', alignItems: 'baseline', gap: '8px' },
  '.mdr-review-label': {
    fontWeight: '600',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontSize: '0.85em',
    color: 'var(--mdr-review-tint, #2a6ad9)',
  },
  '.mdr-review-note': { opacity: '0.7' },
  '.mdr-review-revert': {
    font: 'inherit',
    fontSize: '0.95em',
    marginLeft: 'auto',
    padding: '1px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    color: 'inherit',
    border: '1px solid color-mix(in srgb, var(--mdr-review-tint, #2a6ad9) 45%, transparent)',
    background: 'var(--mdr-bg, transparent)',
  },
  '.mdr-review-revert:hover': {
    background: 'color-mix(in srgb, var(--mdr-review-tint, #2a6ad9) 18%, transparent)',
  },
  '.mdr-review-body': { whiteSpace: 'pre-wrap', marginTop: '2px', fontSize: '1.05em' },
  // A little room either side, so that a word taken out and the word
  // that replaced it read as two things and not as one long one.
  '.mdr-review-gone, .mdr-review-new': { padding: '0 3px', borderRadius: '3px' },
  '.mdr-review-gone': {
    textDecoration: 'line-through',
    background: 'color-mix(in srgb, var(--mdr-change-removed, #dc2626) 14%, transparent)',
  },
  '.mdr-review-new': {
    textDecoration: 'none',
    background: 'color-mix(in srgb, var(--mdr-change-added, #16a34a) 16%, transparent)',
  },
  '.mdr-review-gap': { opacity: '0.55' },
});

/** The panels. Loaded only while Review mode is on (design 4.4). */
export function reviewPanels(): Extension {
  return [EditorView.decorations.compute([changesField, 'selection', 'doc'], build), reviewTheme];
}
