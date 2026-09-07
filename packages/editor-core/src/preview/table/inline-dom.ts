import type { Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';

const wrappers: Record<string, string> = {
  Emphasis: 'em',
  StrongEmphasis: 'strong',
  Highlight: 'mark',
  Strikethrough: 's',
  Link: 'a',
  Image: 'span',
};

const hidden: ReadonlySet<string> = new Set([
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'URL',
  'LinkTitle',
  'LinkLabel',
  'HighlightMark',
  'StrikethroughMark',
  'MathMark',
  'TableDelimiter',
  'Comment',
]);

/**
 * Render the inline markdown of a source range as DOM: emphasis, strong,
 * code, links, highlight, strikethrough, math as code, escapes resolved,
 * comments and delimiters omitted. Used by the table widget for cells
 * that are not being edited. A small ancestor of the Read renderer that
 * WP 1.4 builds in `packages/markdown`.
 */
export function renderInline(
  tree: Tree,
  doc: Text,
  from: number,
  to: number,
  parent: HTMLElement,
): void {
  let pos = from;
  const stack: HTMLElement[] = [parent];
  const top = () => stack[stack.length - 1] as HTMLElement;
  const flushTo = (p: number) => {
    if (p > pos) top().appendChild(document.createTextNode(doc.sliceString(pos, p)));
    pos = Math.max(pos, p);
  };
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.from < from || node.to > to) return true;
      const wrapper = wrappers[node.name];
      if (wrapper) {
        flushTo(node.from);
        const el = document.createElement(wrapper);
        if (node.name === 'Link') {
          const url = node.node.getChild('URL');
          if (url) el.setAttribute('href', doc.sliceString(url.from, url.to));
        }
        if (node.name === 'Image') el.className = 'mdr-image';
        top().appendChild(el);
        stack.push(el);
        return true;
      }
      if (hidden.has(node.name)) {
        flushTo(node.from);
        pos = node.to;
        return false;
      }
      switch (node.name) {
        case 'InlineCode':
        case 'InlineMath': {
          flushTo(node.from);
          const marks = node.node.getChildren(node.name === 'InlineCode' ? 'CodeMark' : 'MathMark');
          const inner =
            marks.length >= 2
              ? doc.sliceString(marks[0]?.to ?? node.from, marks[marks.length - 1]?.from ?? node.to)
              : doc.sliceString(node.from, node.to);
          const el = document.createElement('code');
          if (node.name === 'InlineMath') el.className = 'mdr-math';
          el.textContent = inner;
          top().appendChild(el);
          pos = node.to;
          return false;
        }
        case 'Escape':
          flushTo(node.from);
          top().appendChild(document.createTextNode(doc.sliceString(node.from + 1, node.to)));
          pos = node.to;
          return false;
        case 'HardBreak':
          flushTo(node.from);
          top().appendChild(document.createElement('br'));
          pos = node.to;
          return false;
        default:
          return true;
      }
    },
    leave(node) {
      if (node.from < from || node.to > to) return;
      if (wrappers[node.name]) {
        flushTo(node.to);
        stack.pop();
      }
    },
  });
  flushTo(to);
}
