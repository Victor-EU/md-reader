import type { Tree } from '@lezer/common';

/**
 * A readable, line-per-node rendering of a syntax tree, for snapshots and
 * debugging. Leaves show their source text so a reviewer can read a
 * snapshot without the fixture beside it.
 */
export function dumpTree(tree: Tree, doc: string): string {
  const lines: string[] = [];
  const open: number[] = [];
  let depth = 0;
  tree.iterate({
    enter(node) {
      lines.push(`${'  '.repeat(depth)}${node.name} ${node.from}-${node.to}`);
      open.push(lines.length - 1);
      depth++;
    },
    leave(node) {
      depth--;
      const index = open.pop();
      if (index !== undefined && index === lines.length - 1) {
        const text = doc.slice(node.from, node.to);
        const shown = text.length > 60 ? `${text.slice(0, 57)}...` : text;
        lines[index] += ` ${JSON.stringify(shown)}`;
      }
    },
  });
  return `${lines.join('\n')}\n`;
}
