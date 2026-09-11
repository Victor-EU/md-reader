import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/**
 * How long a lookup may spend parsing its way to a block: the longest
 * CodeMirror's own background parse holds the page for in one go.
 */
const REACH_BUDGET_MS = 100;

/**
 * The last position of the last line `tree` has parsed, or the end of the
 * document when it has all of it. A parse that runs out of time stops at a
 * line boundary, and the markdown parser takes a paragraph or a table whole
 * or not at all, so every block on the lines up to here is complete in the
 * tree, and nothing past it is in the tree at all.
 */
export function parsedTo(tree: Tree, state: EditorState): number {
  return tree.length >= state.doc.length ? state.doc.length : tree.length - 1;
}

/**
 * A syntax tree that has parsed the line holding `pos`.
 *
 * `syntaxTree` is what the parser got through in the 20 ms CodeMirror
 * gives it per transaction. A slow moment cuts that short, and every block
 * past the cut is missing from the tree until the background parse catches
 * up, a tenth of a second later at the soonest: asked about one of those
 * blocks, the tree says it is not there. This parses the rest of the way to
 * `pos` -- the parse keeps what it has done, so that is usually the block
 * the edit touched and little else -- and settles for the tree as it is
 * when even that runs out of time.
 */
export function treeReaching(state: EditorState, pos: number): Tree {
  const tree = syntaxTree(state);
  const line = state.doc.lineAt(pos);
  if (line.from <= parsedTo(tree, state)) return tree;
  return ensureSyntaxTree(state, line.to, REACH_BUDGET_MS) ?? tree;
}
