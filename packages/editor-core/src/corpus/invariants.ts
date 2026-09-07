import { ensureSyntaxTree } from '@codemirror/language';
import type { ChangeSet, EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { createEditorState } from '../state.ts';

export type Outcome = { ok: true } | { ok: false; reason: string; detail: string };

const ok: Outcome = { ok: true };

/** A state whose tree covers the whole document, for headless checks. */
export function fullyParsed(text: string): EditorState {
  const state = createEditorState(text);
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state.update({}).state;
}

function fullTree(state: EditorState): Tree {
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
  if (!tree) throw new Error('parse did not finish');
  return tree;
}

function show(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - 30), at + 30));
}

/** Invariant A. The document after the command is exactly the expected change applied to the one before. */
export function checkExactness(
  before: EditorState,
  after: EditorState,
  expected: ChangeSet,
): Outcome {
  const want = expected.apply(before.doc).toString();
  const got = after.doc.toString();
  if (want === got) return ok;
  let at = 0;
  while (at < want.length && at < got.length && want[at] === got[at]) at++;
  return {
    ok: false,
    reason: 'exactness',
    detail: `first difference at ${at}\n  expected ${show(want, at)}\n  actual   ${show(got, at)}`,
  };
}

/**
 * Invariant B. Outside the top-level blocks the change touched, the parse
 * tree is structurally identical before and after, positions shifted by
 * the change. A change in the gap between two blocks counts both
 * neighbours as touched, since it can create or merge blocks there.
 */
export function checkLocality(
  before: EditorState,
  after: EditorState,
  changed: { from: number; to: number },
  expected: ChangeSet,
): Outcome {
  const beforeTree = fullTree(before);
  const afterTree = fullTree(after);
  const span = touchedSpan(beforeTree, changed.from, changed.to);
  const delta = expected.newLength - expected.length;
  const headBefore = dumpRange(beforeTree, before, 0, span.from);
  const headAfter = dumpRange(afterTree, after, 0, span.from);
  if (headBefore !== headAfter) {
    return {
      ok: false,
      reason: 'locality (before the block)',
      detail: diffDumps(headBefore, headAfter),
    };
  }
  const tailBefore = dumpRange(beforeTree, before, span.to, before.doc.length);
  const tailAfter = dumpRange(afterTree, after, span.to + delta, after.doc.length);
  if (tailBefore !== tailAfter) {
    return {
      ok: false,
      reason: 'locality (after the block)',
      detail: diffDumps(tailBefore, tailAfter),
    };
  }
  return ok;
}

/** Invariant C. Loading and reading back a document is byte identical. */
export function checkIdentity(text: string): Outcome {
  const got = createEditorState(text).doc.toString();
  if (got === text) return ok;
  return { ok: false, reason: 'identity', detail: `length ${text.length} became ${got.length}` };
}

function touchedSpan(tree: Tree, from: number, to: number): { from: number; to: number } {
  let left: { from: number; to: number } | null = null;
  let right: { from: number; to: number } | null = null;
  const cursor = tree.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.from <= to) left = { from: cursor.from, to: cursor.to };
      if (cursor.to >= from && !right) right = { from: cursor.from, to: cursor.to };
    } while (cursor.nextSibling());
  }
  const a = left ?? right ?? { from, to };
  const b = right ?? left ?? { from, to };
  return { from: Math.min(a.from, b.from, from), to: Math.max(a.to, b.to, to) };
}

/** Nodes fully inside [from, to], one per line, positions relative to `from`. */
export function dumpRange(tree: Tree, state: EditorState, from: number, to: number): string {
  if (from >= to) return '';
  const lines: string[] = [];
  let depth = 0;
  const inside = (f: number, t: number) => f >= from && t <= to;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (!inside(node.from, node.to)) return true;
      const leaf = node.node.firstChild === null;
      const text = leaf
        ? ` ${JSON.stringify(state.doc.sliceString(node.from, Math.min(node.to, node.from + 40)))}`
        : '';
      lines.push(`${'  '.repeat(depth)}${node.name} ${node.from - from}-${node.to - from}${text}`);
      depth++;
      return true;
    },
    leave(node) {
      if (inside(node.from, node.to)) depth--;
    },
  });
  return lines.join('\n');
}

function diffDumps(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  return `first differing node\n  before: ${al[i] ?? '(end)'}\n  after:  ${bl[i] ?? '(end)'}`;
}
