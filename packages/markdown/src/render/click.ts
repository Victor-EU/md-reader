/**
 * Click-to-edit: turn a point in the rendered document into a source
 * offset (design 7.1). The DOM adapter records where every verbatim text
 * run starts, so the common case is a lookup plus the offset inside the
 * text node — the caret lands on the character under the pointer, not at
 * the start of the block.
 */

function isText(node: Node): node is Text {
  return node.nodeType === 3;
}

/** The text length inside `root` that precedes `node`, in document order. */
function textBefore(root: Element, node: Text): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) break;
    total += (current as Text).length;
  }
  return total;
}

export function resolveOffset(
  container: Node,
  offsetInNode: number,
  offsets: WeakMap<Text, number>,
): number | null {
  if (isText(container)) {
    const base = offsets.get(container);
    if (base !== undefined) return base + Math.min(offsetInNode, container.length);
    // A subtree whose text another renderer rewrote — a highlighted code
    // block — still holds the source verbatim, so counting gets there.
    const verbatim = container.parentElement?.closest('[data-verbatim]');
    if (verbatim) {
      const from = Number(verbatim.getAttribute('data-from'));
      return from + textBefore(verbatim, container) + Math.min(offsetInNode, container.length);
    }
  }
  const el = container instanceof Element ? container : container.parentElement;
  const anchored = el?.closest('[data-from]');
  return anchored ? Number(anchored.getAttribute('data-from')) : null;
}

interface CaretPoint {
  node: Node;
  offset: number;
}

/** The caret under a point, through whichever API the engine has. */
export function caretAt(x: number, y: number, doc: Document = document): CaretPoint | null {
  const withPosition = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = withPosition.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = withPosition.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The source offset under a point, or null when the point is not in text. */
export function offsetFromPoint(
  x: number,
  y: number,
  offsets: WeakMap<Text, number>,
  doc: Document = document,
): number | null {
  const caret = caretAt(x, y, doc);
  return caret ? resolveOffset(caret.node, caret.offset, offsets) : null;
}
