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

export interface CommentRecord {
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

const commentRe = /^(<!--\s*)([A-Za-z]+)(\s*:\s*)([\s\S]*?)(\s*-->)$/;
const kinds: ReadonlySet<string> = new Set(annotationKinds);

/** Where the kind and the text sit inside a comment, for a renderer that shows them apart. */
export interface CommentParts {
  kind: AnnotationKind;
  text: string;
  /** Offsets of the kind word and of the text, relative to the start of the comment. */
  kindFrom: number;
  kindTo: number;
  textFrom: number;
  textTo: number;
}

/**
 * Take one comment apart. Returns null for a comment that is not an
 * annotation: no kind word, an unknown kind, or extra text outside the
 * comment. The kind is matched case-insensitively and normalized, because
 * models sometimes capitalize; the app always writes lowercase.
 */
export function commentParts(source: string): CommentParts | null {
  const m = commentRe.exec(source);
  if (!m) return null;
  const kind = (m[2] ?? '').toLowerCase();
  if (!kinds.has(kind)) return null;
  const kindFrom = (m[1] as string).length;
  const kindTo = kindFrom + (m[2] as string).length;
  const textFrom = kindTo + (m[3] as string).length;
  return {
    kind: kind as AnnotationKind,
    text: m[4] ?? '',
    kindFrom,
    kindTo,
    textFrom,
    textTo: textFrom + (m[4] as string).length,
  };
}

/** The kind and the words of one comment, or null when it is not an annotation. */
export function classifyComment(source: string): { kind: AnnotationKind; text: string } | null {
  const parts = commentParts(source);
  return parts && { kind: parts.kind, text: parts.text };
}

function slice(doc: TextSource, from: number, to: number): string {
  return typeof doc === 'string' ? doc.slice(from, to) : doc.sliceString(from, to);
}

/** A range of source, as the document counts offsets. */
export interface Span {
  from: number;
  to: number;
}

const CLOSE = '-->';

/**
 * Every comment in a tree as a source range, in document order --
 * annotations and plain remarks alike, because the reader is shown neither.
 *
 * The range stops at `-->` rather than at the end of the node. A
 * `CommentBlock` runs to the end of the line holding the close mark, and
 * anything after it on that line belongs to the block but is still
 * rendered, so ending at the node would swallow words the reader can see.
 * An unterminated comment has no close mark and runs to the end of the
 * node, which is as far as the parser thinks it goes.
 */
export function commentSpans(tree: Tree, doc: TextSource): Span[] {
  const found: Span[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== 'Comment' && node.name !== 'CommentBlock') return;
      const close = slice(doc, node.from, node.to).indexOf(CLOSE);
      found.push({
        from: node.from,
        to: close === -1 ? node.to : node.from + close + CLOSE.length,
      });
      return false;
    },
  });
  return found;
}

/**
 * Every annotation comment in a tree, in document order. A post-pass over
 * the stock `Comment` and `CommentBlock` nodes; the tree is not changed.
 *
 * Two facts about the stock parser this relies on, pinned by tests: a
 * comment inside a paragraph is a `Comment` node, and a comment starting
 * a line is a `CommentBlock` that runs to the end of the line holding
 * `-->`. Text after `-->` on that line is part of the block, so such a
 * block is not an annotation; the app writes block comments on their own
 * line.
 */
export function comments(tree: Tree, doc: TextSource): CommentRecord[] {
  const found: CommentRecord[] = [];
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
