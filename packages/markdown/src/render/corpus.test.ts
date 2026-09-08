import type { Tree } from '@lezer/common';
import { describe, expect, it } from 'vitest';
import { corpusFiles } from '../corpus.ts';
import { parser } from '../parser.ts';
import { toHtml } from './html.ts';
import { type RenderNode, textOf } from './nodes.ts';
import { renderDocument } from './render.ts';

/**
 * The whole corpus through the Read renderer, without snapshots (plan 7.2):
 * nothing throws, every range is sound, and no construct the parser found
 * fell through to the page as literal text.
 */
const files = corpusFiles(50);

/**
 * What each construct must turn into. Counted rather than sampled, because
 * a renderer that drops one emphasis in a thousand is exactly the bug this
 * is for.
 */
const constructs: [string, (node: RenderNode) => boolean][] = [
  ['Emphasis', (n) => tag(n, 'em')],
  ['StrongEmphasis', (n) => tag(n, 'strong')],
  ['Highlight', (n) => tag(n, 'mark')],
  ['Strikethrough', (n) => tag(n, 's')],
  ['Table', (n) => tag(n, 'table')],
  // A folded callout is a `details`; every other blockquote is a blockquote.
  ['Blockquote', (n) => tag(n, 'blockquote') || tag(n, 'details')],
  ['BulletList', (n) => tag(n, 'ul')],
  ['OrderedList', (n) => tag(n, 'ol')],
  ['ListItem', (n) => tag(n, 'li')],
  ['HorizontalRule', (n) => tag(n, 'hr')],
  ['InlineMath', (n) => cls(n, 'mdr-math')],
  ['BlockMath', (n) => cls(n, 'mdr-math-block')],
  ['FencedCode', (n) => cls(n, 'mdr-code') || cls(n, 'mdr-mermaid')],
  ['CodeBlock', (n) => cls(n, 'mdr-code')],
  ['Frontmatter', (n) => cls(n, 'mdr-frontmatter')],
  ['FootnoteDefinition', (n) => cls(n, 'mdr-footnote')],
  ...([1, 2, 3, 4, 5, 6] as const).map((level): [string, (node: RenderNode) => boolean] => [
    `ATXHeading${level}`,
    (n) => tag(n, `h${level}`),
  ]),
];

function tag(node: RenderNode, name: string): boolean {
  return node.kind === 'element' && node.tag === name;
}

function cls(node: RenderNode, name: string): boolean {
  return node.kind === 'element' && (node.attrs.class ?? '').split(' ').includes(name);
}

function countTree(tree: Tree, name: string): number {
  let found = 0;
  tree.iterate({
    enter: (node) => {
      if (node.name === name) found += 1;
    },
  });
  return found;
}

function collect(nodes: readonly RenderNode[], match: (node: RenderNode) => boolean): RenderNode[] {
  const out: RenderNode[] = [];
  for (const node of nodes) {
    if (match(node)) out.push(node);
    if (node.kind === 'element') out.push(...collect(node.children, match));
  }
  return out;
}

function countNodes(nodes: readonly RenderNode[], match: (node: RenderNode) => boolean): number {
  let found = 0;
  for (const node of nodes) {
    if (match(node)) found += 1;
    if (node.kind === 'element') found += countNodes(node.children, match);
  }
  return found;
}

/**
 * Nodes whose source text the renderer is entitled not to show: a link's
 * destination and title, the label of a reference link, the language of a
 * fence, the tags of inline HTML, a footnote's label, the source of an
 * entity, a list marker the list element draws itself, a comment the
 * reader folds away, and the two blocks that render as something other
 * than their text. Everything else in a
 * document has to reach the page — the rest of this test is there because
 * a renderer that quietly drops an email address is worse than one that
 * shows it as the wrong thing.
 */
const hidden: ReadonlySet<string> = new Set([
  'CodeInfo',
  'ListMark',
  'FootnoteLabel',
  'LinkLabel',
  'LinkTitle',
  'LinkReference',
  'FootnoteReference',
  'HTMLTag',
  'HTMLBlock',
  'Entity',
  'Frontmatter',
  'CalloutType',
  'CalloutFold',
  'Comment',
  'CommentBlock',
]);

/** The source with every hidden range blanked out. */
function visibleSource(tree: Tree, source: string): string {
  const out = source.split('');
  tree.iterate({
    enter(node) {
      const parent = node.node.parent?.name;
      const isDestination = node.name === 'URL' && (parent === 'Link' || parent === 'Image');
      if (!hidden.has(node.name) && !isDestination) return true;
      for (let i = node.from; i < node.to; i++) out[i] = ' ';
      return false;
    },
  });
  return out.join('');
}

/** Words long enough that finding them by accident is unlikely. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

/** Ranges are inside the document, inside their parent, and verbatim runs are the source. */
function checkRanges(
  nodes: readonly RenderNode[],
  source: string,
  from: number,
  to: number,
): string | null {
  for (const node of nodes) {
    if (node.from < from || node.to > to || node.to < node.from) {
      return `range ${node.from}-${node.to} outside ${from}-${to}`;
    }
    if (node.kind === 'element') {
      const inner = checkRanges(node.children, source, node.from, node.to);
      if (inner) return inner;
    } else if (node.verbatim && node.text !== source.slice(node.from, node.to)) {
      return `text ${JSON.stringify(node.text)} is not the source at ${node.from}-${node.to}`;
    }
  }
  return null;
}

describe('read renderer over the corpus', () => {
  it(`renders ${files.length} files without throwing`, () => {
    for (const file of files) {
      expect(() => renderDocument(parser.parse(file.text), file.text), file.name).not.toThrow();
    }
  });

  it('keeps every range sound', () => {
    for (const file of files) {
      const nodes = renderDocument(parser.parse(file.text), file.text);
      expect(checkRanges(nodes, file.text, 0, file.text.length), file.name).toBeNull();
    }
  });

  it('renders every construct the parser found', () => {
    const missing: string[] = [];
    for (const file of files) {
      const tree = parser.parse(file.text);
      const nodes = renderDocument(tree, file.text);
      for (const [name, match] of constructs) {
        const parsed = countTree(tree, name);
        if (parsed === 0) continue;
        const rendered = countNodes(nodes, match);
        if (rendered < parsed)
          missing.push(`${file.name}: ${name} ${parsed} parsed, ${rendered} rendered`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('loses no word of the source', () => {
    const lost: string[] = [];
    for (const file of files) {
      const tree = parser.parse(file.text);
      const rendered = textOf(renderDocument(tree, file.text)).toLowerCase();
      for (const word of words(visibleSource(tree, file.text))) {
        if (!rendered.includes(word)) lost.push(`${file.name}: ${word}`);
      }
    }
    expect(lost.slice(0, 20)).toEqual([]);
  });

  it('escapes everything it puts in the page', () => {
    for (const file of files) {
      const nodes = renderDocument(parser.parse(file.text), file.text);
      const html = toHtml(nodes);
      // Text that came from the source can only appear escaped: the only
      // `<` in the output is the one that opens a tag we emitted.
      const tags = html.match(/<[a-z][a-z\d]*(?: [^>]*)?>|<\/[a-z][a-z\d]*>/g) ?? [];
      const stripped = tags.reduce((acc, t) => acc.replace(t, ''), html);
      expect(stripped.includes('<'), file.name).toBe(false);
    }
  });

  it('leaves no syntax inside the elements it produced', () => {
    // `==high==light==` is one highlight and a literal tail, so a stray
    // `==` in the page is not a bug on its own. A `==` *inside* the mark
    // it produced is: it would mean the marks were rendered, not consumed.
    const marks: [string, string[]][] = [
      ['mark', ['==']],
      ['em', ['*', '_']],
      ['strong', ['**', '__']],
      ['s', ['~~']],
    ];
    const wrong: string[] = [];
    for (const file of files) {
      const nodes = renderDocument(parser.parse(file.text), file.text);
      for (const [tagName, syntax] of marks) {
        for (const found of collect(nodes, (n) => tag(n, tagName))) {
          const inner = textOf(found.kind === 'element' ? found.children : [found]);
          for (const mark of syntax) {
            if (inner.startsWith(mark) || inner.endsWith(mark)) {
              wrong.push(`${file.name}: <${tagName}> keeps ${mark} in ${JSON.stringify(inner)}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
