import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search';
import { type EditorState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin } from '@codemirror/view';

/**
 * Find and replace (design 4.5), on `@codemirror/search`'s state machine
 * with the app's own bar in front of it.
 *
 * The one thing that is ours rather than theirs is the highlighter. The
 * one in the package draws matches only while the package's own panel is
 * open, and the app's find bar is a Svelte component in the window
 * chrome, not a CodeMirror panel — so the same drawing is done here,
 * gated on the bar instead.
 */

/** Whether the find bar is showing. Matches are drawn while it is. */
export const setFindOpen = StateEffect.define<boolean>();

const findOpen = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    for (const effect of tr.effects) if (effect.is(setFindOpen)) return effect.value;
    return open;
  },
});

export function findIsOpen(state: EditorState): boolean {
  return state.field(findOpen, false) ?? false;
}

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const currentMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

/** Every match in the drawn part of the document; the one under the cursor stands out. */
function highlight(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state);
  if (!findIsOpen(view.state) || !query.valid) return Decoration.none;
  const marks = [];
  const at = view.state.selection.main;
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      const match = next.value;
      const mark = match.from === at.from && match.to === at.to ? currentMark : matchMark;
      marks.push(mark.range(match.from, match.to));
    }
  }
  return Decoration.set(marks, true);
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
      this.decorations = highlight(view);
    }

    update(update: { view: EditorView }): void {
      this.decorations = highlight(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The search state, the flag, and the highlighter, for `baseExtensions`. */
export function findExtensions(): Extension {
  return [search({ literal: true }), findOpen, Prec.low(highlighter)];
}

/** How many matches there are, and which one the selection is on. */
export interface MatchCount {
  /** 1-based, or 0 when the selection is not on a match. */
  current: number;
  total: number;
  /** True when counting stopped at the cap and `total` is a floor. */
  capped: boolean;
}

/**
 * Counting stops at `cap`. A regular expression over ten megabytes can
 * match a hundred thousand times, and nobody reads past "500+"; what the
 * bar has to be is instant.
 */
export function countMatches(state: EditorState, query: SearchQuery, cap = 500): MatchCount {
  if (!query.valid) return { current: 0, total: 0, capped: false };
  const at = state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === at.from && next.value.to === at.to) current = total;
    if (total >= cap) return { current, total, capped: true };
  }
  return { current, total, capped: false };
}

export {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
};
