import type { SyntaxNode, Tree } from '@lezer/common';
import { calloutType } from './callouts.ts';
import { FootnoteNumbers, footnoteDefinitions } from './footnotes.ts';
import {
  element,
  type RenderElement,
  type RenderNode,
  type RenderText,
  text,
  textOf,
} from './nodes.ts';
import { properties } from './properties.ts';
import { normalizeLabel, type Reference, referenceDefinitions } from './references.ts';
import { Slugger } from './slug.ts';
import { HtmlStack, tagRenders, tokenizeHtml } from './whitelist.ts';

/** What the view may do with one image source (design 8). */
export interface ImageTarget {
  /** The URL to load, or null when the image stays a placeholder. */
  url: string | null;
  /** Why it is not loaded, so the placeholder can say. */
  blocked?: 'remote' | 'unavailable';
}

/**
 * Turns the source of an image into something the view may load. The
 * desktop app resolves a relative path against the document's folder and
 * hands back an asset URL; a headless render has no folder and no
 * permission to reach the network, so it loads nothing.
 */
export type ImageResolver = (src: string) => ImageTarget;

/** Only a data URL is safe without a folder to resolve against or a reader to ask. */
const noImages: ImageResolver = (src) => {
  if (/^data:image\//i.test(src)) return { url: src };
  return {
    url: null,
    blocked: /^(?:[a-z][a-z\d+\-.]*:|\/\/)/i.test(src) ? 'remote' : 'unavailable',
  };
};

export interface RenderOptions {
  /** Shared with the outline so heading ids agree; see `headings`. */
  slugger?: Slugger;
  /** Scanned from the source by default; passed in only by tests. */
  references?: Map<string, Reference>;
  /** The labels footnote definitions give; scanned from the source by default. */
  footnotes?: Set<string>;
  /** Design 8's image rules. Loads nothing when left out. */
  image?: ImageResolver;
}

const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;

export function headingLevel(name: string): number | null {
  const m = HEADING.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}

const SCHEME = /^[a-z][a-z\d+\-.]*:/i;

/** Schemes a rendered `href` or `src` may carry. Everything else renders as text. */
const SAFE_SCHEME = /^(?:https?|mailto|tel)$/i;

/** Links that leave the app, and so open in the system browser. */
const EXTERNAL = /^(?:https?|mailto|tel):/i;

/**
 * The destination of text that is its own link, by GFM's rules: `www.` is
 * a web address, and something with an `@` and no scheme is an address to
 * write to.
 */
function autoHref(raw: string): string {
  if (/^www\./i.test(raw)) return `http://${raw}`;
  if (raw.includes('@') && !SCHEME.test(raw)) return `mailto:${raw}`;
  return raw;
}

/**
 * The address as it may be written into the page, or null when it may not.
 * A destination with no scheme is a path inside the document's own world
 * and is always safe; one with a scheme is safe only if the scheme is.
 */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('data:image/')) return trimmed;
  const scheme = SCHEME.exec(trimmed)?.[0].slice(0, -1);
  if (scheme === undefined) return trimmed;
  return SAFE_SCHEME.test(scheme) ? trimmed : null;
}

/**
 * The named entities a written document actually uses. The full HTML5 table
 * is two thousand names and thirty kilobytes; anything outside this list
 * stays literal, which is what it looked like in the source anyway.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  laquo: '\u00ab',
  raquo: '\u00bb',
  deg: '\u00b0',
  middot: '\u00b7',
  bull: '\u2022',
  dagger: '\u2020',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  sect: '\u00a7',
  para: '\u00b6',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  minus: '\u2212',
  frac12: '\u00bd',
  larr: '\u2190',
  rarr: '\u2192',
  uarr: '\u2191',
  darr: '\u2193',
  harr: '\u2194',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  infin: '\u221e',
  asymp: '\u2248',
  equiv: '\u2261',
  emsp: '\u2003',
  ensp: '\u2002',
  thinsp: '\u2009',
  check: '\u2713',
};

/** Decode one entity node's source, or leave it as it stands. */
function decodeEntity(source: string): string {
  const m = /^&(?:#(\d+)|#[xX]([\da-fA-F]+)|([a-zA-Z]+));$/.exec(source);
  if (!m) return source;
  if (m[1]) return String.fromCodePoint(Number(m[1]));
  if (m[2]) return String.fromCodePoint(Number.parseInt(m[2], 16));
  return NAMED[(m[3] ?? '').toLowerCase()] ?? source;
}

/** Nodes that are syntax: they render to nothing wherever they appear. */
const dropped: ReadonlySet<string> = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'CodeMark',
  'CodeInfo',
  'EmphasisMark',
  'HighlightMark',
  'StrikethroughMark',
  'LinkTitle',
  'MathMark',
  'FrontmatterMark',
  'CalloutMark',
  'CalloutType',
  'CalloutFold',
  'TableDelimiter',
  'LinkReference',
  'FootnoteMark',
  'FootnoteLabel',
]);

/**
 * The tree-to-node renderer (design 6.2). It walks the same Lezer tree the
 * editor parses, so Read and Edit can never disagree about what a document
 * is, and gives every element the source range that makes click-to-edit
 * land on the right character.
 *
 * One instance per rendering pass. Read mode renders a long document in
 * chunks and keeps the instance between them, so heading ids stay unique
 * across the whole document.
 */
export class Renderer {
  readonly slugger: Slugger;
  private readonly references: Map<string, Reference>;
  private readonly footnoteLabels: Set<string>;
  private readonly footnotes: FootnoteNumbers;
  private readonly resolveImage: ImageResolver;

  constructor(
    private readonly source: string,
    options: RenderOptions = {},
  ) {
    this.slugger = options.slugger ?? new Slugger();
    this.references = options.references ?? referenceDefinitions(source);
    this.footnoteLabels = options.footnotes ?? footnoteDefinitions(source);
    // Footnote anchors share the heading namespace, so they go through the
    // same slugger: a heading called "Fn 1" cannot steal `#fn-1`.
    this.footnotes = new FootnoteNumbers((id) => this.slugger.slug(id));
    this.resolveImage = options.image ?? noImages;
  }

  /** Every top-level block of a tree, in document order. */
  document(tree: Tree): RenderNode[] {
    const out: RenderNode[] = [];
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
      const node = this.block(child);
      if (node) out.push(node);
    }
    return out;
  }

  /** One block. Null when the block renders to nothing, as a definition does. */
  block(node: SyntaxNode): RenderNode | null {
    const level = headingLevel(node.name);
    if (level !== null) return this.heading(node, level);

    switch (node.name) {
      case 'Paragraph':
        return element('p', {}, node.from, node.to, this.inlineChildren(node));
      case 'Blockquote':
        return this.blockquote(node);
      case 'BulletList':
        return element('ul', {}, node.from, node.to, this.listItems(node));
      case 'OrderedList':
        return element('ol', this.orderedAttrs(node), node.from, node.to, this.listItems(node));
      case 'FencedCode':
      case 'CodeBlock':
        return this.code(node);
      case 'BlockMath':
        return this.blockMath(node);
      case 'Table':
        return this.table(node);
      case 'HorizontalRule':
        return element('hr', {}, node.from, node.to);
      case 'Frontmatter':
        return this.frontmatter(node);
      case 'HTMLBlock':
        return this.htmlBlock(node);
      case 'FootnoteDefinition':
        return this.footnote(node);
      case 'CommentBlock':
      case 'Comment':
        return this.comment(node);
      case 'LinkReference':
        return null;
      default:
        return this.unknownBlock(node);
    }
  }

  // --- blocks -------------------------------------------------------------

  private heading(node: SyntaxNode, level: number): RenderElement {
    let from = node.from;
    let to = node.to;
    for (let m = node.firstChild; m; m = m.nextSibling) {
      if (m.name !== 'HeaderMark') continue;
      if (m.from === node.from) from = this.slice(m.to, m.to + 1) === ' ' ? m.to + 1 : m.to;
      // A Setext underline or a closing `###` ends the heading's content.
      else to = Math.max(from, this.slice(m.from - 1, m.from).trim() === '' ? m.from - 1 : m.from);
    }
    const children = this.inline(node, from, to);
    const id = this.slugger.slug(textOf(children));
    return element(`h${level}`, { id }, node.from, node.to, children);
  }

  /**
   * A blockquote, or the callout it starts with. A fold sign makes the
   * callout a `details` element, which is how a collapsed section
   * survives without a line of script and reopens where the reader left
   * it — the `+` and `-` of Obsidian's syntax mean exactly `open` and
   * closed.
   */
  private blockquote(node: SyntaxNode): RenderElement {
    const header = node.getChild('CalloutHeader');
    if (!header) {
      return element('blockquote', {}, node.from, node.to, this.blockChildren(node));
    }
    const typeNode = header.getChild('CalloutType');
    const type = calloutType(typeNode ? this.slice(typeNode.from, typeNode.to) : '');
    const title = header.getChild('CalloutTitle');
    const label = title
      ? this.inline(title, title.from, title.to)
      : [text(type.title, header.from, header.to, false)];
    const body = this.blockChildren(node, header);
    const fold = header.getChild('CalloutFold');
    const sign = fold ? this.slice(fold.from, fold.to) : '';
    const attrs: Record<string, string> = { class: 'mdr-callout', 'data-callout': type.name };
    if (!type.known) attrs['data-callout-unknown'] = '';
    if (sign === '') {
      return element('blockquote', attrs, node.from, node.to, [
        element('div', { class: 'mdr-callout-title' }, header.from, header.to, label),
        ...body,
      ]);
    }
    if (sign === '+') attrs.open = '';
    return element('details', attrs, node.from, node.to, [
      element('summary', { class: 'mdr-callout-title' }, header.from, header.to, label),
      ...body,
    ]);
  }

  private orderedAttrs(node: SyntaxNode): Record<string, string> {
    const mark = node.firstChild?.getChild('ListMark');
    const start = mark ? Number.parseInt(this.slice(mark.from, mark.to), 10) : 1;
    return Number.isFinite(start) && start !== 1 ? { start: String(start) } : {};
  }

  /**
   * A list is tight when no blank line separates its items or the blocks
   * inside them; CommonMark drops the paragraph wrapper in that case, and
   * so does every renderer a reader has seen.
   */
  private tight(list: SyntaxNode): boolean {
    let previous: SyntaxNode | null = null;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (previous && /\n[ \t]*\n/.test(this.slice(previous.to, item.from))) return false;
      let inner: SyntaxNode | null = null;
      for (let child = item.firstChild; child; child = child.nextSibling) {
        if (child.name === 'ListMark') continue;
        if (inner && /\n[ \t]*\n/.test(this.slice(inner.to, child.from))) return false;
        inner = child;
      }
      previous = item;
    }
    return true;
  }

  private listItems(list: SyntaxNode): RenderNode[] {
    const tight = this.tight(list);
    const out: RenderNode[] = [];
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      out.push(this.listItem(item, tight));
    }
    return out;
  }

  private listItem(item: SyntaxNode, tight: boolean): RenderElement {
    const children: RenderNode[] = [];
    let task = false;
    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (child.name === 'ListMark') continue;
      if (child.name === 'Task') {
        task = true;
        children.push(...this.task(child));
        continue;
      }
      if (tight && child.name === 'Paragraph') {
        children.push(...this.inlineChildren(child));
        continue;
      }
      const node = this.block(child);
      if (node) children.push(node);
    }
    return element('li', task ? { class: 'mdr-task' } : {}, item.from, item.to, children);
  }

  private task(node: SyntaxNode): RenderNode[] {
    const marker = node.getChild('TaskMarker');
    const out: RenderNode[] = [];
    if (marker) {
      const checked = this.slice(marker.from, marker.to) !== '[ ]';
      const attrs: Record<string, string> = { type: 'checkbox', disabled: '' };
      if (checked) attrs.checked = '';
      out.push(element('input', attrs, marker.from, marker.to));
    }
    const from = marker ? Math.min(node.to, marker.to + 1) : node.from;
    out.push(...this.inline(node, from, node.to));
    return out;
  }

  private code(node: SyntaxNode): RenderElement {
    const info = node.getChild('CodeInfo');
    const language = info ? (this.slice(info.from, info.to).trim().split(/\s+/)[0] ?? '') : '';
    const runs = this.verbatimRuns(node, 'CodeText');
    const first = runs[0];
    // A fence's first run starts on the line after the opening marker; the
    // newline belongs to the marker, not to the code.
    if (first?.kind === 'text' && first.text.startsWith('\n')) {
      runs[0] = text(first.text.slice(1), first.from + 1, first.to, first.verbatim);
    }
    const contentFrom = runs[0]?.from ?? node.from;
    const contentTo = runs.at(-1)?.to ?? node.to;
    if (language.toLowerCase() === 'mermaid') {
      // The diagram is rendered asynchronously into this element (WP 1.4).
      return element(
        'div',
        { class: 'mdr-mermaid', 'data-lang': 'mermaid' },
        node.from,
        node.to,
        runs,
      );
    }
    const codeAttrs: Record<string, string> = {};
    if (language !== '') codeAttrs.class = `language-${language}`;
    // Shiki replaces the text nodes inside; the flag says the element's own
    // text is the source, so a click can still be resolved by counting.
    if (runs.length === 1) codeAttrs['data-verbatim'] = '';
    const preAttrs: Record<string, string> = { class: 'mdr-code' };
    if (language !== '') preAttrs['data-lang'] = language;
    return element('pre', preAttrs, node.from, node.to, [
      element('code', codeAttrs, contentFrom, contentTo, runs),
    ]);
  }

  private blockMath(node: SyntaxNode): RenderElement {
    const runs = this.verbatimRuns(node, 'MathContent');
    return element(
      'div',
      { class: 'mdr-math-block', 'data-tex': textOf(runs) },
      node.from,
      node.to,
      runs,
    );
  }

  /**
   * Frontmatter as the properties panel of design 5.1, or as the YAML it
   * is when the block holds a shape the panel would misrepresent.
   */
  private frontmatter(node: SyntaxNode): RenderElement {
    const runs = this.verbatimRuns(node, 'FrontmatterContent');
    const from = runs[0]?.from ?? node.from;
    const to = runs.at(-1)?.to ?? node.to;
    const found = runs.length === 0 ? [] : properties(this.slice(from, to), from);
    if (found === null) {
      return element('div', { class: 'mdr-frontmatter' }, node.from, node.to, [
        element('pre', {}, from, to, runs),
      ]);
    }
    const rows = found.map((property) =>
      element('div', { class: 'mdr-property' }, property.from, property.to, [
        element('span', { class: 'mdr-property-key' }, property.from, property.valueFrom, [
          text(property.key, property.from, property.from + property.key.length),
        ]),
        element(
          'span',
          { class: 'mdr-property-value' },
          property.valueFrom,
          property.to,
          property.items
            ? property.items.map((item, i) =>
                element('span', { class: 'mdr-property-item' }, property.to, property.to, [
                  text(item, property.to, property.to, false),
                  ...(i < (property.items?.length ?? 0) - 1
                    ? [text(', ', property.to, property.to, false)]
                    : []),
                ]),
              )
            : [text(property.value, property.valueFrom, property.valueTo)],
        ),
      ]),
    );
    return element('div', { class: 'mdr-frontmatter mdr-properties' }, node.from, node.to, rows);
  }

  /**
   * A footnote where the file puts it, numbered by the order the document
   * first refers to it.
   *
   * GitHub moves every note into a section at the end. Moving blocks would
   * cost this renderer the property everything else here depends on —
   * that a rendered element sits at its own source range, in source order,
   * so a click lands on the right character and a chunk can be rendered
   * without reading the rest of the file.
   */
  private footnote(node: SyntaxNode): RenderElement {
    const labelNode = node.getChild('FootnoteLabel');
    const label = labelNode ? this.slice(labelNode.from, labelNode.to) : '';
    // A note referred to nowhere above has nothing to link back to.
    const referenced = !this.footnotes.unseen(label);
    const anchor = this.footnotes.anchor(label);
    const body = this.blockChildren(node);
    const back = element(
      'a',
      { href: `#${anchor.backId}`, class: 'mdr-fn-back', 'aria-label': 'Back to reference' },
      node.to,
      node.to,
      [text('\u21a9', node.to, node.to, false)],
    );
    const last = body.at(-1);
    if (!referenced) {
      // nothing to add
    } else if (last?.kind === 'element' && last.tag === 'p') {
      body[body.length - 1] = element('p', last.attrs, last.from, last.to, [
        ...last.children,
        text(' ', node.to, node.to, false),
        back,
      ]);
    } else {
      body.push(back);
    }
    return element(
      'div',
      { class: 'mdr-footnote', id: anchor.id, 'data-footnote': label },
      node.from,
      node.to,
      [
        element('span', { class: 'mdr-fn-number' }, node.from, node.from, [
          text(`${anchor.number}.`, node.from, node.from, false),
        ]),
        element('div', { class: 'mdr-fn-body' }, body[0]?.from ?? node.from, node.to, body),
      ],
    );
  }

  /**
   * A block of raw HTML: the whitelist's elements when every tag in the
   * block is one the whitelist renders, and the literal text of the block
   * otherwise (design 5.3).
   *
   * Pairing stops at the block's own edges. An HTML block ends at a blank
   * line, so a `<details>` written with blank lines inside it is several
   * blocks and its tags show as text. Read mode renders a long document
   * one top-level block at a time and cannot look ahead for a closing tag
   * without giving that up, and a rule that holds everywhere is worth more
   * here than one that holds until a document gets long.
   */
  private htmlBlock(node: SyntaxNode): RenderElement {
    const source = this.slice(node.from, node.to);
    const tokens = tokenizeHtml(source, node.from);
    if (tokens.every((token) => !token.tag || tagRenders(token.source))) {
      const stack = this.htmlStack();
      let loose = false;
      for (const token of tokens) {
        if (token.tag && stack.tag(token.source, token.from, token.to)) continue;
        if (!token.tag && token.source.trim() === '') continue;
        // Text or a tag with nowhere to go: the block is not a structure
        // this whitelist can build, so all of it stays as written.
        if (!stack.inElement) {
          loose = true;
          break;
        }
        stack.push(text(token.source, token.from, token.to));
      }
      const nodes = loose ? [] : stack.finish();
      const only = nodes.length === 1 ? nodes[0] : null;
      if (only?.kind === 'element') return only;
      if (nodes.some((child) => child.kind === 'element')) {
        return element('div', { class: 'mdr-html-block' }, node.from, node.to, nodes);
      }
    }
    return element('pre', { class: 'mdr-html' }, node.from, node.to, [
      text(source, node.from, node.to),
    ]);
  }

  /**
   * Comments are folded away in Read mode (design 4.3); the element is here
   * so the toggle of WP 1.6 has something to show.
   *
   * A comment block ends at the line that closes it, so anything the author
   * wrote after `-->` on that line is ordinary visible text and is rendered
   * as such — hiding the whole node would make it disappear.
   */
  private comment(node: SyntaxNode): RenderNode {
    const source = this.slice(node.from, node.to);
    const close = source.indexOf('-->');
    const commentTo = close === -1 ? node.to : node.from + close + 3;
    const hidden = element('span', { class: 'mdr-comment', hidden: '' }, node.from, commentTo, [
      text(this.slice(node.from, commentTo), node.from, commentTo),
    ]);
    const trailing = this.slice(commentTo, node.to);
    if (trailing.trim() === '') return hidden;
    return element('div', { class: 'mdr-comment-block' }, node.from, node.to, [
      hidden,
      element('p', {}, commentTo, node.to, [text(trailing, commentTo, node.to)]),
    ]);
  }

  private table(node: SyntaxNode): RenderElement {
    const delimiter = node.getChild('TableDelimiter');
    const align = delimiter ? this.alignments(delimiter) : [];
    const head: RenderNode[] = [];
    const body: RenderNode[] = [];
    for (let row = node.firstChild; row; row = row.nextSibling) {
      if (row.name === 'TableHeader') head.push(this.tableRow(row, align, 'th'));
      else if (row.name === 'TableRow') body.push(this.tableRow(row, align, 'td'));
    }
    const sections: RenderNode[] = [];
    if (head.length > 0) {
      sections.push(
        element('thead', {}, head[0]?.from ?? node.from, head.at(-1)?.to ?? node.to, head),
      );
    }
    if (body.length > 0) {
      sections.push(
        element('tbody', {}, body[0]?.from ?? node.from, body.at(-1)?.to ?? node.to, body),
      );
    }
    // The table scrolls inside its own container rather than widening the
    // page (design 11); the wrapper is that container.
    return element('div', { class: 'mdr-table-wrap' }, node.from, node.to, [
      element('table', {}, node.from, node.to, sections),
    ]);
  }

  private alignments(delimiter: SyntaxNode): (string | null)[] {
    return this.slice(delimiter.from, delimiter.to)
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => {
        const spec = cell.trim();
        const left = spec.startsWith(':');
        const right = spec.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return left ? 'left' : null;
      });
  }

  private tableRow(row: SyntaxNode, align: (string | null)[], tag: string): RenderElement {
    const cells: RenderNode[] = [];
    let column = 0;
    for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
      if (cell.name !== 'TableCell') continue;
      const alignment = align[column];
      const attrs: Record<string, string> = alignment ? { style: `text-align:${alignment}` } : {};
      cells.push(element(tag, attrs, cell.from, cell.to, this.inline(cell, cell.from, cell.to)));
      column += 1;
    }
    return element('tr', {}, row.from, row.to, cells);
  }

  /** The named children of a block, joined into one run of text per line. */
  private verbatimRuns(node: SyntaxNode, name: string): RenderNode[] {
    const runs: RenderNode[] = [];
    let previous: RenderText | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== name) continue;
      // Inside a blockquote the line breaks belong to the quote marks, so
      // they are not part of any content node; put them back.
      if (previous && !previous.text.endsWith('\n')) {
        runs.push(text('\n', previous.to, previous.to, false));
      }
      const run = text(this.slice(child.from, child.to), child.from, child.to);
      runs.push(run);
      previous = run;
    }
    return runs;
  }

  /** The block children of a container, skipping syntax and anything before `after`. */
  private blockChildren(node: SyntaxNode, after?: SyntaxNode): RenderNode[] {
    const out: RenderNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (dropped.has(child.name)) continue;
      if (after && child.from < after.to) continue;
      const rendered = this.block(child);
      if (rendered) out.push(rendered);
    }
    return out;
  }

  private unknownBlock(node: SyntaxNode): RenderNode | null {
    const children = this.blockChildren(node);
    if (children.length === 0) return null;
    return element('div', { class: 'mdr-block' }, node.from, node.to, children);
  }

  // --- inline -------------------------------------------------------------

  private inlineChildren(node: SyntaxNode): RenderNode[] {
    return this.inline(node, node.from, node.to);
  }

  /**
   * The inline content of `node` between two offsets: every child rendered
   * in order, with the text between them emitted as it stands. Because the
   * gaps are verbatim slices of the source, a click inside one resolves to
   * the character under the pointer without any further bookkeeping.
   */
  private inline(node: SyntaxNode, from: number, to: number): RenderNode[] {
    const stack = this.htmlStack();
    let pos = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from) continue;
      if (child.from >= to) break;
      if (child.from > pos) this.pushText(stack, pos, child.from);
      if (child.name === 'HTMLTag') {
        // An allowed tag opens or closes an element; anything else is the
        // text it looks like (design 5.3).
        if (!stack.tag(this.slice(child.from, child.to), child.from, child.to)) {
          this.pushText(stack, child.from, child.to);
        }
      } else {
        const rendered = this.inlineNode(child);
        if (rendered) stack.pushAll(rendered);
      }
      pos = Math.max(pos, child.to);
    }
    if (to > pos) this.pushText(stack, pos, to);
    return stack.finish();
  }

  private htmlStack(): HtmlStack {
    return new HtmlStack({ image: (attrs, from, to) => this.imageNode(attrs, from, to) });
  }

  private pushText(stack: HtmlStack, from: number, to: number): void {
    if (to <= from) return;
    stack.push(text(this.slice(from, to), from, to));
  }

  private inlineNode(node: SyntaxNode): RenderNode[] | null {
    switch (node.name) {
      case 'Emphasis':
        return [element('em', {}, node.from, node.to, this.inlineChildren(node))];
      case 'StrongEmphasis':
        return [element('strong', {}, node.from, node.to, this.inlineChildren(node))];
      case 'Highlight':
        return [element('mark', {}, node.from, node.to, this.inlineChildren(node))];
      case 'Strikethrough':
        return [element('s', {}, node.from, node.to, this.inlineChildren(node))];
      case 'InlineCode':
        return [element('code', {}, node.from, node.to, this.inlineChildren(node))];
      case 'InlineMath':
        return [this.inlineMath(node)];
      case 'Link':
        return this.link(node);
      case 'Autolink':
        return [this.autolink(node)];
      case 'Image':
        return [this.markdownImage(node)];
      case 'HardBreak':
        return [element('br', {}, node.from, node.to)];
      case 'Escape':
        return [text(this.slice(node.from + 1, node.to), node.from, node.to, false)];
      case 'Entity': {
        const source = this.slice(node.from, node.to);
        const decoded = decodeEntity(source);
        return [text(decoded, node.from, node.to, decoded === source)];
      }
      case 'Comment':
        return [this.comment(node)];
      case 'FootnoteReference':
        return this.footnoteReference(node);
      case 'LinkMark':
      case 'LinkLabel': {
        // Kept as text when the brackets around them are not a link at all.
        const parent = node.parent;
        if (parent?.name === 'Link' && !this.resolves(parent)) {
          return [text(this.slice(node.from, node.to), node.from, node.to)];
        }
        return null;
      }
      case 'URL':
        // GFM's extended autolinks — a bare `https://…`, `www.…`, or an
        // email address — are a `URL` with no link around it, and so is
        // the address in `[label](https://example.com` with no closing
        // paren. Inside a link that resolved a `URL` is syntax, but that
        // one sits past the label, where `link` never walks. So every
        // `URL` reaching here is text the reader must see.
        return [this.autoLink(this.slice(node.from, node.to), node.from, node.to)];
      case 'TaskMarker':
        return null;
      default:
        if (dropped.has(node.name)) return null;
        return this.inlineChildren(node);
    }
  }

  private inlineMath(node: SyntaxNode): RenderElement {
    const marks = node.getChildren('MathMark');
    const from = marks[0]?.to ?? node.from;
    const to = marks[1]?.from ?? node.to;
    const tex = this.slice(from, to);
    return element('span', { class: 'mdr-math', 'data-tex': tex }, node.from, node.to, [
      text(tex, from, to),
    ]);
  }

  /** The visible content of a link or image: what sits between its brackets. */
  private labelRange(node: SyntaxNode): { from: number; to: number } {
    const marks = node.getChildren('LinkMark');
    const open = marks[0];
    const close = marks.find((mark) => this.slice(mark.from, mark.to) === ']');
    return {
      from: open ? open.to : node.from,
      to: close ? close.from : node.to,
    };
  }

  /**
   * Whether a `Link` node is one. Lezer emits `Link` for any `[text]`, so
   * without this check every bracketed aside reads as a link.
   */
  private resolves(link: SyntaxNode): boolean {
    return this.destination(link) !== null;
  }

  private destination(link: SyntaxNode): Reference | null {
    const url = link.getChild('URL');
    if (url) {
      const title = link.getChild('LinkTitle');
      return {
        url: this.slice(url.from, url.to),
        title: title ? this.slice(title.from + 1, title.to - 1) : null,
      };
    }
    const labelNode = link.getChild('LinkLabel');
    const explicit = labelNode ? this.slice(labelNode.from + 1, labelNode.to - 1) : '';
    const label = this.labelRange(link);
    const key = explicit.trim() !== '' ? explicit : this.slice(label.from, label.to);
    return this.references.get(normalizeLabel(key)) ?? null;
  }

  private link(node: SyntaxNode): RenderNode[] {
    const target = this.destination(node);
    const label = this.labelRange(node);
    const children = this.inline(node, label.from, label.to);
    if (!target) return this.inline(node, node.from, node.to);
    const href = safeUrl(target.url);
    if (href === null) return children;
    const attrs: Record<string, string> = { href };
    if (target.title !== null && target.title !== '') attrs.title = target.title;
    // Only an absolute URL leaves the app. A `#` link scrolls the document,
    // and a relative one waits for the folder workspace of WP 2.4.
    if (EXTERNAL.test(href)) attrs['data-external'] = '';
    return [element('a', attrs, node.from, node.to, children)];
  }

  private autolink(node: SyntaxNode): RenderElement {
    const url = node.getChild('URL');
    const from = url ? url.from : node.from + 1;
    const to = url ? url.to : node.to - 1;
    return this.autoLink(this.slice(from, to), node.from, node.to, from, to);
  }

  /** A link whose text is its own destination. */
  private autoLink(
    raw: string,
    from: number,
    to: number,
    textFrom = from,
    textTo = to,
  ): RenderElement {
    const href = safeUrl(autoHref(raw));
    const attrs: Record<string, string> = href === null ? {} : { href };
    if (href !== null && EXTERNAL.test(href)) attrs['data-external'] = '';
    return element('a', attrs, from, to, [text(raw, textFrom, textTo)]);
  }

  /**
   * A reference to a footnote, as the number the reader follows. A label
   * nothing defines is left as the text it is, the way an unresolved
   * `[bracket]` is.
   */
  private footnoteReference(node: SyntaxNode): RenderNode[] {
    const labelNode = node.getChild('FootnoteLabel');
    const label = labelNode ? this.slice(labelNode.from, labelNode.to) : '';
    if (!this.footnoteLabels.has(normalizeLabel(label))) {
      return [text(this.slice(node.from, node.to), node.from, node.to)];
    }
    const first = this.footnotes.unseen(label);
    const anchor = this.footnotes.anchor(label);
    const attrs: Record<string, string> = { href: `#${anchor.id}`, class: 'mdr-fnref' };
    // Only the first reference carries the id the note links back to.
    if (first) attrs.id = anchor.backId;
    return [
      element('sup', { class: 'mdr-fnref-sup' }, node.from, node.to, [
        element('a', attrs, node.from, node.to, [
          text(String(anchor.number), node.from, node.to, false),
        ]),
      ]),
    ];
  }

  /**
   * One image, from markdown or from a whitelisted `<img>`. Whether the
   * file may be loaded is design 8's question and the resolver's answer;
   * a source that stays unloaded shows its alt text and says why, which
   * is more use to a reader than a broken icon.
   */
  private imageNode(attrs: Record<string, string>, from: number, to: number): RenderNode {
    const src = attrs.src ?? '';
    const alt = attrs.alt ?? '';
    const target: ImageTarget = safeUrl(src) === null ? { url: null } : this.resolveImage(src);
    if (target.url === null) {
      const placeholder: Record<string, string> = { class: 'mdr-image' };
      if (src !== '') placeholder['data-src'] = src;
      if (target.blocked) placeholder['data-blocked'] = target.blocked;
      // With no alt text the source is the only thing left to show, and an
      // empty span would leave the reader with nothing at all.
      return element('span', placeholder, from, to, [
        text(alt === '' ? src : alt, from, to, false),
      ]);
    }
    const out: Record<string, string> = { ...attrs, src: target.url, alt };
    return element('img', out, from, to);
  }

  private markdownImage(node: SyntaxNode): RenderNode {
    const target = this.destination(node);
    const label = this.labelRange(node);
    const attrs: Record<string, string> = {
      src: target?.url ?? '',
      alt: this.slice(label.from, label.to),
    };
    if (target?.title) attrs.title = target.title;
    return this.imageNode(attrs, node.from, node.to);
  }

  private slice(from: number, to: number): string {
    return this.source.slice(Math.max(0, from), Math.max(0, to));
  }
}

/** Render a whole tree. Read mode renders in chunks; everything else uses this. */
export function renderDocument(
  tree: Tree,
  source: string,
  options: RenderOptions = {},
): RenderNode[] {
  return new Renderer(source, options).document(tree);
}
