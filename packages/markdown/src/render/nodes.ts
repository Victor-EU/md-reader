/**
 * What the Read renderer produces: a small tree of elements and text runs,
 * each carrying the source range it came from.
 *
 * Two adapters consume it — the DOM one Read mode mounts, and the HTML one
 * the goldens and the export of WP 3.2 use — so both render the same
 * document by construction rather than by two implementations agreeing.
 */

export interface RenderElement {
  readonly kind: 'element';
  readonly tag: string;
  /** Emitted in insertion order, so a serialization is stable (plan 7.2). */
  readonly attrs: Readonly<Record<string, string>>;
  readonly from: number;
  readonly to: number;
  readonly children: readonly RenderNode[];
}

export interface RenderText {
  readonly kind: 'text';
  readonly text: string;
  readonly from: number;
  readonly to: number;
  /**
   * True when `text` is exactly the source between `from` and `to`, which
   * is what lets a click inside the run resolve character for character.
   * Escapes and entities are the exceptions: they render one character for
   * several, so a click inside them resolves to the start of the run.
   */
  readonly verbatim: boolean;
}

export type RenderNode = RenderElement | RenderText;

/** Elements with no closing tag, which the HTML adapter must not emit one for. */
export const voidTags: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'input']);

export function element(
  tag: string,
  attrs: Record<string, string>,
  from: number,
  to: number,
  children: readonly RenderNode[] = [],
): RenderElement {
  return { kind: 'element', tag, attrs, from, to, children };
}

export function text(value: string, from: number, to: number, verbatim = true): RenderText {
  return { kind: 'text', text: value, from, to, verbatim };
}

export function isElement(node: RenderNode): node is RenderElement {
  return node.kind === 'element';
}

/**
 * The visible text of a rendered subtree, for heading ids and the outline.
 *
 * An element the renderer marked `hidden` contributes nothing: a comment
 * inside a heading is folded away in Read mode, so it has no business in
 * that heading's id or in the outline entry the reader clicks.
 */
export function textOf(nodes: readonly RenderNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.attrs.hidden === undefined) out += textOf(node.children);
  }
  return out;
}
