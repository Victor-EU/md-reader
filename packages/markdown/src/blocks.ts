import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * A leaf block of a document, as the semantic diff reasons about it
 * (design 7.3, plan WP 2.2).
 *
 * `from` and `to` are offsets into the source in UTF-16 code units, which
 * is what `CodeMirror` counts in and what the block diff hands back
 * ranges against.
 */
export interface DocBlock {
  /**
   * The leaf's kind, prefixed by the containers it sits in, as
   * `list>item>paragraph`.
   *
   * The prefix is not decoration. Two blocks pair only when their kinds
   * match, so it is what makes indenting a list item or pulling a
   * paragraph out of a quote a change rather than a move: the words did
   * not change, but where they are in the document did.
   */
  kind: string;
  /** What the block says, with the structure's own characters taken out. */
  text: string;
  from: number;
  to: number;
}

/**
 * Nodes the walk goes through rather than reports, and the token each
 * one contributes to the kind of what is inside it. `Document` is a
 * container that says nothing, because everything is inside it.
 */
const containers: Record<string, string> = {
  Document: '',
  Blockquote: 'quote',
  BulletList: 'list',
  // Its own token, so turning a bulleted list into a numbered one is a
  // change to every item in it. Which number an item carries is not: the
  // marks are skipped below, and renumbering a list says nothing new.
  OrderedList: 'olist',
  ListItem: 'item',
  Table: 'table',
  FootnoteDefinition: 'footnote',
};

/**
 * The two marks a container puts in front of its content. They are how
 * the structure is written down rather than anything the structure
 * holds, and the kind of what is inside already says which container it
 * came from.
 */
const marks = new Set(['ListMark', 'QuoteMark']);

const leaves: Record<string, string> = {
  Paragraph: 'paragraph',
  Task: 'paragraph',
  TableHeader: 'table_row',
  TableRow: 'table_row',
  // The `| --- |` line under the header. A row of the table by any other
  // name: changing an alignment is an edit to it.
  TableDelimiter: 'table_row',
  FencedCode: 'code',
  CodeBlock: 'code',
  BlockMath: 'math',
  HTMLBlock: 'html',
  CommentBlock: 'comment',
  Comment: 'comment',
  HorizontalRule: 'rule',
  Frontmatter: 'frontmatter',
  CalloutHeader: 'callout',
  LinkReference: 'reference',
};

/**
 * Kinds whose whitespace is content. Collapsing the newlines inside a
 * fenced block would call two different programs the same one, so these
 * keep their source exactly, minus the quote marks a blockquote puts down
 * the left of every line it holds.
 */
const verbatim = new Set(['code', 'math', 'html', 'frontmatter']);

const heading = /^(?:ATX|Setext)Heading([1-6])$/;

function leafKind(name: string): string {
  const level = heading.exec(name);
  if (level) return `heading${level[1]}`;
  // Anything the dialect grows later still becomes a block rather than
  // falling out of the document: a diff that cannot see a construct
  // reports no change to it, which is the one answer it must never give.
  return leaves[name] ?? name.toLowerCase();
}

/** The quote marks a blockquote leaves at the head of a continuation line. */
const quoted = /^(?:[ \t]*>)+[ \t]?/;

/**
 * What the block says, as opposed to how it is laid out.
 *
 * Rewrapping a paragraph is the case this exists for: an agent that
 * reflows a document to 80 columns has changed every line of it and said
 * nothing different, and a diff that reports that is the one design 7.3
 * calls wrong for prose.
 */
function normalize(kind: string, source: string): string {
  const lines = source.split('\n').map((line) => line.replace(quoted, ''));
  if (verbatim.has(kind)) return lines.join('\n');
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Every leaf of the tree, in document order (design 7.3 step 1).
 *
 * The walk goes into containers and reports everything else, so the
 * blocks tile the document: what falls between two of them is blank
 * lines and the marks that make the structure, which the kinds already
 * carry.
 */
export function flattenBlocks(tree: Tree, source: string): DocBlock[] {
  const out: DocBlock[] = [];
  const walk = (node: SyntaxNode, context: string): void => {
    if (marks.has(node.name)) return;
    const token = containers[node.name];
    if (token === undefined) {
      // The leaf's own kind decides how it is normalized; the containers
      // it sits in are the rest of the kind but say nothing about
      // whether its whitespace is content.
      const leaf = leafKind(node.name);
      out.push({
        kind: context + leaf,
        text: normalize(leaf, source.slice(node.from, node.to)),
        from: node.from,
        to: node.to,
      });
      return;
    }
    const inner = token === '' ? context : `${context + token}>`;
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child, inner);
  };
  walk(tree.topNode, '');
  return out;
}

/**
 * How many blocks the two lists share at each end.
 *
 * This is the difference between a keystroke costing a diff of one
 * paragraph and one of the whole document: what is sent to the engine is
 * the middle, and in the ordinary case of somebody typing there is
 * almost nothing in it.
 */
export function commonBlocks(
  old: readonly DocBlock[],
  fresh: readonly DocBlock[],
): { head: number; tail: number } {
  const same = (a: DocBlock | undefined, b: DocBlock | undefined) =>
    a !== undefined && b !== undefined && a.kind === b.kind && a.text === b.text;
  const limit = Math.min(old.length, fresh.length);
  let head = 0;
  while (head < limit && same(old[head], fresh[head])) head += 1;
  let tail = 0;
  while (tail < limit - head && same(old[old.length - 1 - tail], fresh[fresh.length - 1 - tail]))
    tail += 1;
  return { head, tail };
}
