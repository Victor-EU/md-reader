import type { SyntaxNode, Tree } from '@lezer/common';
import {
  element,
  type RenderElement,
  type RenderNode,
  type RenderText,
  text,
  textOf,
} from './nodes.ts';
import { normalizeLabel, type Reference, referenceDefinitions } from './references.ts';
import { Slugger } from './slug.ts';

export interface RenderOptions {
  /** Shared with the outline so heading ids agree; see `headings`. */
  slugger?: Slugger;
  /** Scanned from the source by default; passed in only by tests. */
  references?: Map<string, Reference>;
}

const HEADING = /^(?:ATX|Setext)Heading([1-6])$/;

export function headingLevel(name: string): number | null {
  const m = HEADING.exec(name);
  return m?.[1] ? Number(m[1]) : null;
}

/** Schemes a rendered `href` or `src` may carry. Everything else renders as text. */
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|[^a-z]|[a-z][a-z\d+\-.]*[^a-z\d+\-.:])/i;

/** Links that leave the app, and so open in the system browser. */
const EXTERNAL = /^(?:https?|mailto|tel):/i;

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('data:image/')) return trimmed;
  return SAFE_URL.test(trimmed) ? trimmed : null;
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

  constructor(
    private readonly source: string,
    options: RenderOptions = {},
  ) {
    this.slugger = options.slugger ?? new Slugger();
    this.references = options.references ?? referenceDefinitions(source);
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
        // The whitelist of design 5.2 arrives with WP 1.5; until then every
        // HTML block shows as the literal text it is, which is safe by default.
        return element('pre', { class: 'mdr-html' }, node.from, node.to, [
          text(this.slice(node.from, node.to), node.from, node.to),
        ]);
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

  private blockquote(node: SyntaxNode): RenderElement {
    const header = node.getChild('CalloutHeader');
    if (!header) {
      return element('blockquote', {}, node.from, node.to, this.blockChildren(node));
    }
    const type = header.getChild('CalloutType');
    const kind = type ? this.slice(type.from, type.to).toLowerCase() : 'note';
    const title = header.getChild('CalloutTitle');
    const label = title
      ? this.inline(title, title.from, title.to)
      : [text(kind.charAt(0).toUpperCase() + kind.slice(1), header.from, header.to, false)];
    const body = this.blockChildren(node, header);
    return element(
      'blockquote',
      { class: 'mdr-callout', 'data-callout': kind },
      node.from,
      node.to,
      [element('div', { class: 'mdr-callout-title' }, header.from, header.to, label), ...body],
    );
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

  private frontmatter(node: SyntaxNode): RenderElement {
    // WP 1.5 turns this into the properties widget; until then it is the
    // YAML as written, which is at least honest about what the file holds.
    const runs = this.verbatimRuns(node, 'FrontmatterContent');
    return element('div', { class: 'mdr-frontmatter' }, node.from, node.to, [
      element('pre', {}, runs[0]?.from ?? node.from, runs.at(-1)?.to ?? node.to, runs),
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
    const out: RenderNode[] = [];
    let pos = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from) continue;
      if (child.from >= to) break;
      if (child.from > pos) this.pushText(out, pos, child.from);
      const rendered = this.inlineNode(child);
      if (rendered) out.push(...rendered);
      pos = Math.max(pos, child.to);
    }
    if (to > pos) this.pushText(out, pos, to);
    return out;
  }

  private pushText(out: RenderNode[], from: number, to: number): void {
    if (to <= from) return;
    out.push(text(this.slice(from, to), from, to));
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
        return [this.image(node)];
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
      case 'HTMLTag':
        // Literal text until the whitelist of WP 1.5.
        return [text(this.slice(node.from, node.to), node.from, node.to)];
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
        return node.parent?.name === 'Autolink'
          ? [text(this.slice(node.from, node.to), node.from, node.to)]
          : null;
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
    const raw = url ? this.slice(url.from, url.to) : this.slice(node.from + 1, node.to - 1);
    const href = safeUrl(raw.includes('@') && !raw.includes(':') ? `mailto:${raw}` : raw);
    const attrs: Record<string, string> = href === null ? {} : { href, 'data-external': '' };
    return element('a', attrs, node.from, node.to, [
      text(raw, url ? url.from : node.from + 1, url ? url.to : node.to - 1),
    ]);
  }

  private image(node: SyntaxNode): RenderElement {
    const target = this.destination(node);
    const label = this.labelRange(node);
    const alt = this.slice(label.from, label.to);
    const src = target ? safeUrl(target.url) : null;
    // Relative images need the asset protocol and the per-document scope of
    // WP 1.5; until then the alt text stands in, rather than a broken icon.
    if (src === null || !/^(?:https?:|data:)/i.test(src)) {
      const attrs: Record<string, string> = { class: 'mdr-image' };
      if (target) attrs['data-src'] = target.url;
      return element('span', attrs, node.from, node.to, [text(alt, label.from, label.to)]);
    }
    const attrs: Record<string, string> = { src, alt };
    if (target?.title) attrs.title = target.title;
    return element('img', attrs, node.from, node.to);
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
