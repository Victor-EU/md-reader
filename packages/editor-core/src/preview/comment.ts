import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { AnnotationKind } from '@markdown/markdown';

/**
 * Comments as notes (design 4.3): a chip carrying the kind and the words,
 * in the margin where there is room for it and inline where there is not.
 * Hovering one highlights the span it is anchored to, which is the only
 * way to see an anchoring rule that lives in whitespace.
 *
 * The source comes back the moment the selection touches the comment, as
 * it does for every other inline unit, so the note is edited as the text
 * it is rather than through a form.
 */

export interface AnchorRange {
  from: number;
  to: number;
}

export class CommentWidget extends WidgetType {
  constructor(
    readonly kind: AnnotationKind,
    readonly text: string,
    readonly anchor: AnchorRange | null,
    /** Which note this is on its line, so several on one line stack instead of overlapping. */
    readonly index: number,
  ) {
    super();
  }

  override eq(other: CommentWidget): boolean {
    return (
      other.kind === this.kind &&
      other.text === this.text &&
      other.index === this.index &&
      other.anchor?.from === this.anchor?.from &&
      other.anchor?.to === this.anchor?.to
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'mdr-comment-widget';
    el.dataset.kind = this.kind;
    if (this.index > 0) el.style.setProperty('--mdr-note-index', String(this.index));
    if (this.anchor) {
      el.dataset.anchorFrom = String(this.anchor.from);
      el.dataset.anchorTo = String(this.anchor.to);
    }
    const kind = el.appendChild(document.createElement('span'));
    kind.className = 'mdr-comment-kind';
    kind.textContent = this.kind;
    const text = el.appendChild(document.createElement('span'));
    text.className = 'mdr-comment-text';
    text.textContent = this.text;
    return el;
  }

  /** A click goes to the editor, which puts the cursor in the comment and gives the source back. */
  override ignoreEvent(): boolean {
    return false;
  }
}

export const setHoveredAnchor = StateEffect.define<AnchorRange | null>();

const anchorMark = Decoration.mark({ class: 'mdr-anchor-hover', kind: 'mark' });

/**
 * The span the note under the pointer is anchored to. View state, not
 * document state, but it is kept in a field so the decoration it draws
 * composes with the rest and survives a document change under the pointer.
 */
export const hoveredAnchor = StateField.define<AnchorRange | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHoveredAnchor)) return effect.value;
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    return from < to ? { from, to } : null;
  },
  provide: (field) =>
    EditorView.decorations.from(
      field,
      (value): DecorationSet =>
        value && value.from < value.to
          ? Decoration.set(anchorMark.range(value.from, value.to))
          : Decoration.none,
    ),
});

function anchorOf(target: EventTarget | null): AnchorRange | null {
  const el = (target as HTMLElement | null)?.closest?.('.mdr-comment-widget');
  const from = (el as HTMLElement | null)?.dataset.anchorFrom;
  const to = (el as HTMLElement | null)?.dataset.anchorTo;
  return from === undefined || to === undefined ? null : { from: Number(from), to: Number(to) };
}

function hover(view: EditorView, anchor: AnchorRange | null): void {
  const current = view.state.field(hoveredAnchor, false) ?? null;
  if (current?.from === anchor?.from && current?.to === anchor?.to) return;
  view.dispatch({ effects: setHoveredAnchor.of(anchor) });
}

const commentHover = EditorView.domEventHandlers({
  mouseover: (event, view) => {
    const anchor = anchorOf(event.target);
    if (anchor) hover(view, anchor);
  },
  mouseout: (event, view) => {
    if (anchorOf(event.target)) hover(view, null);
  },
});

export function commentNotes(): Extension {
  return [hoveredAnchor, commentHover];
}
