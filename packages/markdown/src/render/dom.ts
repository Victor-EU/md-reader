import { element, type RenderNode, text } from './nodes.ts';

/**
 * The DOM adapter. Read mode mounts what this builds; the HTML adapter
 * beside it turns the same nodes into a string.
 */

export interface DomResult {
  fragment: DocumentFragment;
  /**
   * Where each text node starts in the source, for the runs that are a
   * verbatim slice of it. Click-to-edit is a lookup here plus the offset
   * inside the text node, which is why it lands on the right character
   * rather than at the start of a block.
   */
  offsets: WeakMap<Text, number>;
}

export interface DomOptions {
  /** The document to create nodes in. Defaults to the global one. */
  document?: Document;
  offsets?: WeakMap<Text, number>;
}

export function toDom(nodes: readonly RenderNode[], options: DomOptions = {}): DomResult {
  const doc = options.document ?? document;
  const offsets = options.offsets ?? new WeakMap<Text, number>();
  const fragment = doc.createDocumentFragment();
  append(fragment, nodes, doc, offsets);
  return { fragment, offsets };
}

function append(
  parent: Node,
  nodes: readonly RenderNode[],
  doc: Document,
  offsets: WeakMap<Text, number>,
): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      const textNode = doc.createTextNode(node.text);
      if (node.verbatim) offsets.set(textNode, node.from);
      parent.appendChild(textNode);
      continue;
    }
    const el = doc.createElement(node.tag);
    for (const [name, value] of Object.entries(node.attrs)) el.setAttribute(name, value);
    el.setAttribute('data-from', String(node.from));
    el.setAttribute('data-to', String(node.to));
    append(el, node.children, doc, offsets);
    parent.appendChild(el);
  }
}

/**
 * Read a mounted subtree back as render nodes. The tests serialize this
 * with the same writer the goldens use, so one golden file can assert that
 * both adapters produced the same document on both engines.
 */
export function readDom(root: Node): RenderNode[] {
  const out: RenderNode[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      const value = child.nodeValue ?? '';
      if (value !== '') out.push(text(value, 0, 0));
      continue;
    }
    if (!(child instanceof Element)) continue;
    const attrs: Record<string, string> = {};
    let from = 0;
    let to = 0;
    for (const attr of Array.from(child.attributes)) {
      if (attr.name === 'data-from') from = Number(attr.value);
      else if (attr.name === 'data-to') to = Number(attr.value);
      else attrs[attr.name] = attr.value;
    }
    out.push(element(child.tagName.toLowerCase(), attrs, from, to, readDom(child)));
  }
  return out;
}
