import type { SyntaxNode } from '@lezer/common';

/**
 * Node names the live preview reasons about. Kept in one place so the
 * reveal rule and the decoration builder cannot drift apart.
 */

/**
 * Inline formatting whose syntax stays hidden until the selection touches
 * it. The outermost such ancestor is the reveal unit, so editing inside
 * `**bold *and italic***` shows every mark of the whole run: hiding the
 * outer marks while the inner ones are open makes boundary edits guesswork.
 */
export const inlineUnits: ReadonlySet<string> = new Set([
  'Emphasis',
  'StrongEmphasis',
  'InlineCode',
  'Link',
  'Image',
  'Autolink',
  'Highlight',
  'Strikethrough',
  'InlineMath',
  'Escape',
  'FootnoteReference',
]);

/**
 * Blocks whose block-level syntax hides or dims until the selection
 * touches the block: the `#` of a heading, the fence lines of a code
 * block, and later the whole widget for tables, math, and frontmatter.
 */
export const blockUnits: ReadonlySet<string> = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'FencedCode',
  'CodeBlock',
  'BlockMath',
  'Frontmatter',
  'Table',
  'HTMLBlock',
  'CommentBlock',
  'HorizontalRule',
]);

/** Block units whose content is inline text with its own units inside. */
const inlineContentBlocks: ReadonlySet<string> = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
]);

export function hasInlineContent(name: string): boolean {
  return inlineContentBlocks.has(name);
}

/**
 * The `Image` a paragraph consists of, when the paragraph is nothing
 * else and sits at the top level. That paragraph is a block widget, so
 * the reveal rule has to treat it as a block even though a paragraph is
 * not otherwise one; both callers ask here so they cannot disagree.
 */
export function loneImage(
  node: SyntaxNode,
  read: (from: number, to: number) => string,
): SyntaxNode | null {
  if (node.name !== 'Paragraph' || node.parent?.name !== 'Document') return null;
  const image = node.firstChild;
  if (image?.name !== 'Image' || image.nextSibling) return null;
  const around = read(node.from, image.from) + read(image.to, node.to);
  return around.trim() === '' ? image : null;
}

export function headingLevel(name: string): number | null {
  const m = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}
