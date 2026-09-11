import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/**
 * How long a lookup may spend parsing its way to a block: the longest
 * CodeMirror's own background parse holds the page for in one go.
 */
const REACH_BUDGET_MS = 100;

/**
 * How many blocks a lookup may parse after its milliseconds are gone.
 *
 * A budget in milliseconds is a budget the machine can spend without us: a
 * process descheduled for a moment comes back to find its hundred
 * milliseconds gone and not one block parsed for them. Steps are ours to
 * count whatever the clock did, and each of these is one call that parses
 * at least one block before it looks at the clock again.
 *
 * Three steps is what the reader's own block costs, whether it sits a page
 * into the document or five thousand paragraphs into it: the parse reuses
 * everything it had before the edit and walks on from there, so the
 * distance is the edit's, not the document's. Twenty leaves room for that
 * to be wrong and still stops well short of parsing a document nobody has
 * parsed yet, which is a wait the keystroke must not be held for.
 */
const REACH_STEPS = 20;

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
 * the edit touched and little else -- first on the clock, then, if the
 * machine spent that without giving the parse any of it, on a count of
 * blocks. It settles for the tree as it is only once both are gone.
 */
export function treeReaching(state: EditorState, pos: number): Tree {
  const tree = syntaxTree(state);
  const line = state.doc.lineAt(pos);
  if (line.from <= parsedTo(tree, state)) return tree;
  const reached = ensureSyntaxTree(state, line.to, REACH_BUDGET_MS);
  if (reached) return reached;
  for (let step = 0; step < REACH_STEPS; step++) {
    const further = ensureSyntaxTree(state, line.to, 0);
    if (further) return further;
  }
  return tree;
}
