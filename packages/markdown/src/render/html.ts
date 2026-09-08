import { type RenderNode, voidTags } from './nodes.ts';

/**
 * The HTML-string adapter. The rendering goldens are its output, and the
 * export of WP 3.2 will be too; Read mode uses the DOM adapter beside it,
 * built from the same nodes.
 */

const TEXT = /[&<>]/g;
const ATTR = /[&<>"]/g;
const REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const escapeText = (value: string) => value.replace(TEXT, (c) => REPLACEMENTS[c] as string);
const escapeAttr = (value: string) => value.replace(ATTR, (c) => REPLACEMENTS[c] as string);

/**
 * Elements whose children are always other blocks, so each child can go on
 * its own line. Whitespace between blocks does not render, and a golden a
 * human has to review should not be one long line.
 */
const containers: ReadonlySet<string> = new Set([
  'div',
  'ul',
  'ol',
  'blockquote',
  'details',
  'table',
  'thead',
  'tbody',
  'tr',
]);

export interface HtmlOptions {
  /** Emit `data-from` and `data-to`. On for the goldens, off for a diff by eye. */
  ranges?: boolean;
  /** Break container children onto their own lines. */
  indent?: boolean;
}

export function toHtml(nodes: readonly RenderNode[], options: HtmlOptions = {}): string {
  const ranges = options.ranges ?? true;
  const indent = options.indent ?? true;
  const out: string[] = [];
  write(out, nodes, { ranges, indent }, 0, true);
  return out.join('');
}

interface Settings {
  ranges: boolean;
  indent: boolean;
}

function write(
  out: string[],
  nodes: readonly RenderNode[],
  settings: Settings,
  depth: number,
  block: boolean,
): void {
  for (const node of nodes) {
    if (block && settings.indent)
      out.push(depth === 0 && out.length === 0 ? '' : '\n', '  '.repeat(depth));
    if (node.kind === 'text') {
      out.push(escapeText(node.text));
      continue;
    }
    const attrs: string[] = [];
    for (const [name, value] of Object.entries(node.attrs)) {
      attrs.push(value === '' ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`);
    }
    if (settings.ranges) attrs.push(` data-from="${node.from}" data-to="${node.to}"`);
    out.push(`<${node.tag}${attrs.join('')}>`);
    if (voidTags.has(node.tag)) continue;
    const nested = containers.has(node.tag);
    write(out, node.children, settings, depth + 1, nested);
    if (nested && settings.indent && node.children.length > 0) out.push('\n', '  '.repeat(depth));
    out.push(`</${node.tag}>`);
  }
}
