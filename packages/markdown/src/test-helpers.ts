import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from './parser.ts';

export interface Found {
  name: string;
  from: number;
  to: number;
  text: string;
  node: SyntaxNode;
}

/** Parse and check the tree's structure, so every unit test also guards well-formedness. */
export function parse(doc: string): Tree {
  const tree = parser.parse(doc);
  assertWellFormed(tree, doc);
  return tree;
}

/** Every node name in document order, root included. */
export function names(doc: string): string[] {
  const out: string[] = [];
  parse(doc).iterate({
    enter(node) {
      out.push(node.name);
    },
  });
  return out;
}

/** Every node with the given name, with its source text. */
export function find(doc: string, name: string, tree: Tree = parse(doc)): Found[] {
  const out: Found[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === name) {
        out.push({
          name,
          from: node.from,
          to: node.to,
          text: doc.slice(node.from, node.to),
          node: node.node,
        });
      }
    },
  });
  return out;
}

/** The formula of a math node: its `MathContent` pieces joined. */
export function mathSource(node: SyntaxNode, doc: string): string {
  let out = '';
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'MathContent') out += doc.slice(c.from, c.to);
  }
  return out;
}

/**
 * Throw when a tree is structurally wrong: the root does not span the
 * document, a child leaves its parent's range, or siblings overlap.
 */
export function assertWellFormed(tree: Tree, doc: string): void {
  if (tree.length !== doc.length)
    throw new Error(`tree length ${tree.length} != doc length ${doc.length}`);
  const stack: { name: string; from: number; to: number; cursor: number }[] = [];
  tree.iterate({
    enter(node) {
      const parent = stack[stack.length - 1];
      if (node.from > node.to) throw new Error(`${node.name} ${node.from}-${node.to} is inverted`);
      if (parent) {
        if (node.from < parent.cursor || node.to > parent.to) {
          throw new Error(
            `${node.name} ${node.from}-${node.to} escapes ${parent.name} ${parent.from}-${parent.to} (cursor ${parent.cursor})`,
          );
        }
        parent.cursor = node.to;
      }
      stack.push({ name: node.name, from: node.from, to: node.to, cursor: node.from });
    },
    leave() {
      stack.pop();
    },
  });
}
