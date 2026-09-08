import type { SyntaxNode } from '@lezer/common';
import { pairTags, parseTag } from '../render/whitelist.ts';
import { meaningOfColor, type PaletteMeaning } from './palette.ts';

/**
 * Comment anchoring, from design 4.3: a comment placed directly after an
 * inline element is anchored to it; a comment on its own line is anchored
 * to the following block.
 *
 * "Directly after" means nothing but whitespace between the element and
 * the comment. That is what makes the rule explainable and stable under
 * editing: `**bold** and some words <!-- note: x -->` anchors to nothing
 * in particular, and saying so is better than guessing at "the sentence".
 *
 * The extractor and the editor's comment widget both ask here, so the
 * note in the margin points at exactly the span Copy for AI names.
 */

/** What a comment is attached to. */
export type AnchorKind = 'highlight' | 'strikethrough' | 'color' | 'block';

export interface Anchor {
  kind: AnchorKind;
  from: number;
  to: number;
  /** For a colour, the palette meaning it stands for; null when it is the reader's own colour. */
  meaning: PaletteMeaning | null;
}

export type Read = (from: number, to: number) => string;

/** Inline elements a comment can be anchored to, by node name. */
const INLINE_ANCHORS: Record<string, AnchorKind> = {
  Highlight: 'highlight',
  Strikethrough: 'strikethrough',
};

/**
 * The opening tag of the `span` that `close` closes, when `close` is the
 * end of a coloured span. Null for any other tag, and for a close tag
 * whose opener is not a colour we could render.
 */
export function colorSpanOpening(close: SyntaxNode, read: Read): SyntaxNode | null {
  const parent = close.parent;
  if (!parent) return null;
  const tags: SyntaxNode[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.name === 'HTMLTag') tags.push(node);
  }
  const parsed = tags.map((node) => parseTag(read(node.from, node.to)));
  const closers = pairTags(parsed);
  // Lezer hands out a fresh `SyntaxNode` per visit, so the tag we were
  // given is never the same object as the one the walk above produced.
  const at = tags.findIndex((node) => node.from === close.from && node.to === close.to);
  if (at === -1) return null;
  const open = closers.indexOf(at);
  if (open === -1) return null;
  const tag = parsed[open];
  if (tag?.name !== 'span') return null;
  return colorOf(tag.attrs.style ?? '') === null ? null : (tags[open] as SyntaxNode);
}

/** The colour a `style` attribute sets, or null when it sets anything else. */
export function colorOf(style: string): string | null {
  const m = /^\s*color\s*:\s*([^;]+?)\s*;?\s*$/i.exec(style);
  return m?.[1] ?? null;
}

/**
 * What a comment node is anchored to, or null when it stands on its own.
 *
 * `Comment` is the inline case and looks backwards at its own siblings;
 * `CommentBlock` is the block case and looks forwards at the next block.
 */
export function commentAnchor(comment: SyntaxNode, read: Read): Anchor | null {
  if (comment.name === 'CommentBlock') {
    const next = comment.nextSibling;
    // A note before another note is about the document, not about that
    // note; quoting the comment beneath it would only be confusing.
    if (!next || next.name === 'CommentBlock') return null;
    return { kind: 'block', from: next.from, to: next.to, meaning: null };
  }
  const previous = comment.prevSibling;
  if (!previous) return null;
  // Nothing but whitespace may sit between the element and its note.
  if (read(previous.to, comment.from).trim() !== '') return null;
  const kind = INLINE_ANCHORS[previous.name];
  if (kind) return { kind, from: previous.from, to: previous.to, meaning: null };
  if (previous.name !== 'HTMLTag') return null;
  const open = colorSpanOpening(previous, read);
  if (!open) return null;
  const style = parseTag(read(open.from, open.to))?.attrs.style ?? '';
  const color = colorOf(style);
  return {
    kind: 'color',
    from: open.from,
    to: previous.to,
    meaning: color === null ? null : meaningOfColor(color),
  };
}
