import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { blockUnits, hasInlineContent, inlineUnits, loneImage } from './nodes.ts';

export interface RevealRange {
  from: number;
  to: number;
  /** True for a block unit (heading marks, fence lines), false for an inline unit. */
  block: boolean;
}

/**
 * The reveal rule from design 7.1, as one pure function of the selection
 * and the syntax tree: the source ranges whose syntax is shown.
 *
 * A selection range touches a node when they overlap or when a cursor
 * sits at either edge of it, which is what Lezer's `iterate` visits. For
 * each selection range the units it touches are collected: the outermost
 * inline unit, and every block unit. A heading is a block unit whose
 * inline content still has units of its own, so the walk continues into
 * it; a code fence is not, so it stops there.
 *
 * Every decision about what is hidden flows from this list, which is why
 * it is tested as a table and kept free of any view or DOM dependency.
 */
export function revealRanges(state: EditorState): RevealRange[] {
  const tree = syntaxTree(state);
  const found: RevealRange[] = [];
  for (const range of state.selection.ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        // A paragraph holding nothing but an image is a block widget, so
        // touching it has to give the source back like any other block.
        if (loneImage(node.node, (from, to) => state.doc.sliceString(from, to))) {
          found.push({ from: node.from, to: node.to, block: true });
          return true;
        }
        if (inlineUnits.has(node.name)) {
          found.push({ from: node.from, to: node.to, block: false });
          return false;
        }
        if (blockUnits.has(node.name)) {
          found.push({ from: node.from, to: node.to, block: true });
          return hasInlineContent(node.name);
        }
        return true;
      },
    });
  }
  found.sort((a, b) => a.from - b.from || a.to - b.to || Number(a.block) - Number(b.block));
  return found.filter((r, i) => i === 0 || !sameRange(r, found[i - 1] as RevealRange));
}

export function sameRange(a: RevealRange, b: RevealRange): boolean {
  return a.from === b.from && a.to === b.to && a.block === b.block;
}

export function sameReveal(a: readonly RevealRange[], b: readonly RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => sameRange(r, b[i] as RevealRange));
}
