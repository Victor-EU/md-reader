import type { SyntaxNode, Tree } from '@lezer/common';
import { parseTag } from '../render/whitelist.ts';
import { type Anchor, colorOf, colorSpanOpening, commentAnchor, type Read } from './anchor.ts';
import { type CommentRecord, classifyComment, type TextSource } from './comments.ts';
import { meaningOfColor, type PaletteMeaning } from './palette.ts';

/**
 * The annotation extractor (build plan WP 1.6): every mark the reader made
 * and every comment they wrote, paired by the adjacency rule, as records
 * an agent can act on. Copy for AI writes them out, and `list_annotations`
 * over MCP will return the same list.
 *
 * The records name source ranges, so a caller can scroll to one, and the
 * anchor text is the source under the mark rather than a rendering of it.
 * An agent reading `the **first** step` is looking at what the file says,
 * which is the point of the round trip.
 */

/** What the reader did to the span. A comment with no mark is its own kind. */
export type AnnotationMark = 'highlight' | 'strikethrough' | 'color' | 'comment';

export interface Annotation {
  mark: AnnotationMark;
  /** For a colour, the palette meaning; null for a colour the reader chose themselves. */
  meaning: PaletteMeaning | null;
  /** The text the mark covers, collapsed to one line; empty for a comment with no anchor. */
  anchor: string;
  /** The marked span, the block a block comment leads, or the comment itself. */
  from: number;
  to: number;
  /** The comment paired with this mark, when there is one. */
  comment: CommentRecord | null;
}

/** How much of an anchor Copy for AI quotes before cutting it short. */
const ANCHOR_LIMIT = 100;

function slice(doc: TextSource, from: number, to: number): string {
  return typeof doc === 'string' ? doc.slice(from, to) : doc.sliceString(from, to);
}

/** One line of text for a quote, cut at a word boundary when it is long. */
export function anchorText(source: string): string {
  const flat = source.replace(/\s+/g, ' ').trim();
  if (flat.length <= ANCHOR_LIMIT) return flat;
  const cut = flat.slice(0, ANCHOR_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > ANCHOR_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A mark before its comment, if any, is attached to it. */
interface Mark {
  mark: AnnotationMark;
  meaning: PaletteMeaning | null;
  from: number;
  to: number;
  /** Where the text under the mark starts and ends, inside the range. */
  textFrom: number;
  textTo: number;
}

function markedSpan(node: SyntaxNode, markName: string, mark: AnnotationMark): Mark {
  const marks = node.getChildren(markName);
  const open = marks[0];
  const close = marks[1];
  return {
    mark,
    meaning: null,
    from: node.from,
    to: node.to,
    textFrom: open ? open.to : node.from,
    textTo: close ? close.from : node.to,
  };
}

/**
 * Every annotation in a tree, in document order.
 *
 * One pass collects the marks and the comments, and a second attaches each
 * comment to the mark its anchor names. A comment anchored to a block
 * becomes a record of its own quoting that block; a comment anchored to
 * nothing becomes a record quoting nothing, because it is still something
 * the reader said and dropping it would lose their words.
 */
export function extractAnnotations(tree: Tree, doc: TextSource): Annotation[] {
  const read: Read = (from, to) => slice(doc, from, to);
  const marks: Mark[] = [];
  const colors = new Map<number, Mark>();
  const comments: { record: CommentRecord; anchor: Anchor | null }[] = [];
  tree.iterate({
    enter(node) {
      switch (node.name) {
        case 'Highlight':
          marks.push(markedSpan(node.node, 'HighlightMark', 'highlight'));
          return false;
        case 'Strikethrough':
          marks.push(markedSpan(node.node, 'StrikethroughMark', 'strikethrough'));
          return false;
        case 'HTMLTag':
          collectSpan(node.node, read, marks, colors);
          return false;
        case 'Comment':
        case 'CommentBlock': {
          const classified = classifyComment(read(node.from, node.to));
          if (classified) {
            comments.push({
              record: {
                ...classified,
                from: node.from,
                to: node.to,
                block: node.name === 'CommentBlock',
              },
              anchor: commentAnchor(node.node, read),
            });
          }
          return false;
        }
        default:
          return true;
      }
    },
  });
  return assemble(marks, comments, read);
}

/**
 * A coloured span, from either end. The opening tag starts the record and
 * the closing tag finishes it, so a span whose tag is never closed keeps
 * the empty extent it opened with and quotes nothing — which is what the
 * renderer shows for it too.
 */
function collectSpan(node: SyntaxNode, read: Read, marks: Mark[], colors: Map<number, Mark>): void {
  const tag = parseTag(read(node.from, node.to));
  if (tag?.name !== 'span') return;
  if (tag.kind === 'open') {
    const color = colorOf(tag.attrs.style ?? '');
    if (color === null) return;
    const mark: Mark = {
      mark: 'color',
      meaning: meaningOfColor(color),
      from: node.from,
      to: node.to,
      textFrom: node.to,
      textTo: node.to,
    };
    marks.push(mark);
    colors.set(node.from, mark);
    return;
  }
  if (tag.kind !== 'close') return;
  const open = colorSpanOpening(node, read);
  const mark = open ? colors.get(open.from) : undefined;
  if (!mark) return;
  mark.to = node.to;
  mark.textTo = node.from;
}

function assemble(
  marks: readonly Mark[],
  comments: readonly { record: CommentRecord; anchor: Anchor | null }[],
  read: Read,
): Annotation[] {
  const byRange = new Map(marks.map((mark) => [`${mark.from}:${mark.to}`, mark]));
  const attached = new Map<Mark, CommentRecord>();
  const loose: Annotation[] = [];
  for (const { record, anchor } of comments) {
    const inline = anchor && anchor.kind !== 'block' ? byRange.get(key(anchor)) : undefined;
    if (inline && !attached.has(inline)) {
      attached.set(inline, record);
      continue;
    }
    const block = anchor?.kind === 'block' ? anchor : null;
    loose.push({
      mark: 'comment',
      meaning: null,
      anchor: block ? anchorText(read(block.from, block.to)) : '',
      from: block ? block.from : record.from,
      to: block ? block.to : record.to,
      comment: record,
    });
  }
  const out: Annotation[] = marks.map((mark) => ({
    mark: mark.mark,
    meaning: mark.meaning,
    anchor: anchorText(read(mark.textFrom, mark.textTo)),
    from: mark.from,
    to: mark.to,
    comment: attached.get(mark) ?? null,
  }));
  out.push(...loose);
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}

function key(anchor: Anchor): string {
  return `${anchor.from}:${anchor.to}`;
}
