import type { Tree } from '@lezer/common';

/**
 * The closed comment vocabulary from design section 4.3. Every comment the
 * app writes starts with one of these words and a colon. A model, or the
 * regular expression below, finds every annotation without guessing.
 */
export const annotationKinds = [
  'note',
  'attention',
  'question',
  'remove',
  'keep',
  'rewrite',
] as const;

export type AnnotationKind = (typeof annotationKinds)[number];

export interface Annotation {
  kind: AnnotationKind;
  /** The remark after the colon, with surrounding whitespace removed. */
  text: string;
  /** Source range of the whole `<!-- ... -->`, marks included. */
  from: number;
  to: number;
  /** True for a comment that is a block of its own, false for one inside a paragraph. */
  block: boolean;
}

/** Anything a tree can be read against: a string or a CodeMirror `Text`. */
export type TextSource = string | { sliceString(from: number, to: number): string };

const commentRe = /^<!--\s*([A-Za-z]+)\s*:\s*([\s\S]*?)\s*-->$/;
const kinds: ReadonlySet<string> = new Set(annotationKinds);

/**
 * Classify one comment's source text. Returns null for a comment that is
 * not an annotation: no kind word, an unknown kind, or extra text outside
 * the comment. The kind is matched case-insensitively and normalized,
 * because models sometimes capitalize; the app always writes lowercase.
 */
export function classifyComment(source: string): { kind: AnnotationKind; text: string } | null {
  const m = commentRe.exec(source);
  if (!m) return null;
  const kind = (m[1] ?? '').toLowerCase();
  if (!kinds.has(kind)) return null;
  return { kind: kind as AnnotationKind, text: m[2] ?? '' };
}

function slice(doc: TextSource, from: number, to: number): string {
  return typeof doc === 'string' ? doc.slice(from, to) : doc.sliceString(from, to);
}

/**
 * Every annotation in a tree, in document order. A post-pass over the
 * stock `Comment` and `CommentBlock` nodes; the tree is not changed.
 *
 * Two facts about the stock parser this relies on, pinned by tests: a
 * comment inside a paragraph is a `Comment` node, and a comment starting
 * a line is a `CommentBlock` that runs to the end of the line holding
 * `-->`. Text after `-->` on that line is part of the block, so such a
 * block is not an annotation; the app writes block comments on their own
 * line.
 */
export function annotations(tree: Tree, doc: TextSource): Annotation[] {
  const found: Annotation[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'Comment' && node.name !== 'CommentBlock') return;
      const classified = classifyComment(slice(doc, node.from, node.to));
      if (classified) {
        found.push({
          ...classified,
          from: node.from,
          to: node.to,
          block: node.name === 'CommentBlock',
        });
      }
      return false;
    },
  });
  return found;
}
