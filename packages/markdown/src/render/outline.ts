import type { Tree } from '@lezer/common';
import { textOf } from './nodes.ts';
import { headingLevel, Renderer, type RenderOptions } from './render.ts';

/** One heading, as the outline panel and heading folding both see it. */
export interface OutlineEntry {
  level: number;
  text: string;
  /** The same id the renderer puts on the heading, so `#anchor` links work. */
  id: string;
  from: number;
  to: number;
}

/**
 * The headings of a tree, in document order.
 *
 * It renders each heading with the same renderer Read mode uses, so the
 * ids here and the ids in the document are produced by one implementation
 * walking in one order, and cannot drift.
 */
export function headings(tree: Tree, source: string, options: RenderOptions = {}): OutlineEntry[] {
  const renderer = new Renderer(source, options);
  const out: OutlineEntry[] = [];
  tree.iterate({
    enter: (node) => {
      const level = headingLevel(node.name);
      if (level === null) return true;
      const rendered = renderer.block(node.node);
      if (rendered?.kind === 'element') {
        out.push({
          level,
          text: textOf(rendered.children).trim(),
          id: rendered.attrs.id ?? '',
          from: node.from,
          to: node.to,
        });
      }
      return false;
    },
  });
  return out;
}
