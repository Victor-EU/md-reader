import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';
import { headingLevel } from './nodes.ts';
import { type RevealRange, revealRanges } from './reveal.ts';
import { BulletWidget, CheckboxWidget } from './widgets.ts';

export interface VisibleRange {
  from: number;
  to: number;
}

export interface PreviewDecorations {
  /** Everything the view draws, unsorted. */
  decorations: Range<Decoration>[];
  /** The widget ranges the cursor must skip over, a subset of `decorations`. */
  atomic: Range<Decoration>[];
}

const mark = (cls: string) => Decoration.mark({ class: cls, kind: 'mark' });
const M = {
  em: mark('mdr-em'),
  strong: mark('mdr-strong'),
  code: mark('mdr-code'),
  link: mark('mdr-link'),
  image: mark('mdr-image'),
  highlight: mark('mdr-mark'),
  del: mark('mdr-del'),
  math: mark('mdr-math'),
  comment: mark('mdr-comment'),
  /** Syntax that is revealed because the selection touches its unit. */
  syntax: mark('mdr-syntax'),
  /** Syntax that is always visible but should not compete with content. */
  dim: mark('mdr-dim'),
  quoteMark: mark('mdr-quote-mark'),
  olMark: mark('mdr-ol-mark'),
  calloutMarker: mark('mdr-callout-marker'),
};
const hide = Decoration.replace({ kind: 'hide' });
const bullet = Decoration.replace({ widget: new BulletWidget(), kind: 'widget' });
const checkboxOn = Decoration.replace({ widget: new CheckboxWidget(true), kind: 'widget' });
const checkboxOff = Decoration.replace({ widget: new CheckboxWidget(false), kind: 'widget' });

const lineCache = new Map<string, Decoration>();
function line(cls: string, attributes?: Record<string, string>): Decoration {
  const key = attributes ? `${cls} ${JSON.stringify(attributes)}` : cls;
  let deco = lineCache.get(key);
  if (!deco) {
    deco = Decoration.line(
      attributes ? { class: cls, attributes, kind: 'line' } : { class: cls, kind: 'line' },
    );
    lineCache.set(key, deco);
  }
  return deco;
}

/**
 * Build the live preview decorations for the given ranges of a state.
 *
 * Pure in the sense that matters: the output depends only on the state,
 * the ranges, and the reveal list, never on a view, so fixture snapshots
 * run in Node. The view plugin calls it with `view.visibleRanges`; tests
 * call it with the whole document.
 */
export function buildDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
  reveal: readonly RevealRange[] = revealRanges(state),
): PreviewDecorations {
  const builder = new Builder(state, reveal);
  const tree = syntaxTree(state);
  for (const range of ranges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => builder.visit(node, range.from, range.to),
    });
  }
  return { decorations: builder.decorations, atomic: builder.atomic };
}

class Builder {
  readonly decorations: Range<Decoration>[] = [];
  readonly atomic: Range<Decoration>[] = [];

  constructor(
    private readonly state: EditorState,
    private readonly reveal: readonly RevealRange[],
  ) {}

  private revealed(from: number, to: number, block: boolean): boolean {
    return this.reveal.some((r) => r.block === block && r.from < to && r.to > from);
  }

  /** Hide an inline mark, or show it dimmed when its unit is revealed. */
  private hideInline(from: number, to: number): void {
    if (from >= to) return;
    this.decorations.push((this.revealed(from, to, false) ? M.syntax : hide).range(from, to));
  }

  /** Hide a block mark, or show it dimmed when its block is revealed. */
  private hideBlock(from: number, to: number): void {
    if (from >= to) return;
    this.decorations.push((this.revealed(from, to, true) ? M.syntax : hide).range(from, to));
  }

  /** Keep a block mark visible, dimmed either way; a touch only changes the class. */
  private dimBlock(from: number, to: number): void {
    if (from >= to) return;
    this.decorations.push((this.revealed(from, to, true) ? M.syntax : M.dim).range(from, to));
  }

  private text(from: number, to: number): string {
    return this.state.doc.sliceString(from, to);
  }

  /** Add a line decoration to every line of [from, to] inside the visible range, minus excluded spans. */
  private lines(
    from: number,
    to: number,
    deco: Decoration,
    vFrom: number,
    vTo: number,
    exclude?: readonly VisibleRange[],
  ): void {
    const doc = this.state.doc;
    const start = Math.max(from, vFrom);
    const end = Math.min(to, vTo);
    if (start > end) return;
    let l = doc.lineAt(start);
    for (;;) {
      if (!exclude?.some((e) => l.from <= e.to && l.to >= e.from))
        this.decorations.push(deco.range(l.from));
      if (l.to >= end || l.number === doc.lines) break;
      l = doc.line(l.number + 1);
    }
  }

  private pushAtomic(deco: Decoration, from: number, to: number): void {
    this.decorations.push(deco.range(from, to));
    this.atomic.push(deco.range(from, to));
  }

  visit(node: SyntaxNodeRef, vFrom: number, vTo: number): boolean {
    switch (node.name) {
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6': {
        this.lines(node.from, node.to, line(`mdr-h${headingLevel(node.name)}`), vFrom, vTo);
        for (const m of node.node.getChildren('HeaderMark')) {
          if (m.from === node.from) {
            this.hideBlock(m.from, this.text(m.to, m.to + 1) === ' ' ? m.to + 1 : m.to);
          } else {
            this.hideBlock(this.text(m.from - 1, m.from) === ' ' ? m.from - 1 : m.from, m.to);
          }
        }
        return true;
      }
      case 'SetextHeading1':
      case 'SetextHeading2': {
        const underline = node.node.getChild('HeaderMark');
        const contentTo = underline ? Math.max(node.from, underline.from - 1) : node.to;
        this.lines(node.from, contentTo, line(`mdr-h${headingLevel(node.name)}`), vFrom, vTo);
        if (underline) this.dimBlock(underline.from, underline.to);
        return true;
      }
      case 'HeaderMark':
        return false;

      case 'Blockquote': {
        const header = node.node.getChild('CalloutHeader');
        if (header) {
          const type = header.getChild('CalloutType');
          const kind = type ? this.text(type.from, type.to).toLowerCase() : 'note';
          this.lines(
            node.from,
            node.to,
            line('mdr-quote mdr-callout', { 'data-callout': kind }),
            vFrom,
            vTo,
          );
          this.lines(header.from, header.to, line('mdr-callout-header'), vFrom, vTo);
        } else {
          this.lines(node.from, node.to, line('mdr-quote'), vFrom, vTo);
        }
        return true;
      }
      case 'QuoteMark':
        this.decorations.push(M.quoteMark.range(node.from, node.to));
        return false;
      case 'CalloutHeader': {
        const n = node.node;
        const marks = n.getChildren('CalloutMark');
        const end = n.getChild('CalloutFold')?.to ?? marks[marks.length - 1]?.to ?? node.to;
        if (end > node.from) this.decorations.push(M.calloutMarker.range(node.from, end));
        return true;
      }
      case 'CalloutMark':
      case 'CalloutType':
      case 'CalloutFold':
        return false;

      case 'ListItem': {
        const n = node.node;
        const marker = n.getChild('ListMark');
        if (marker) {
          const width = marker.to - this.state.doc.lineAt(marker.from).from + 1;
          const nested = [...n.getChildren('BulletList'), ...n.getChildren('OrderedList')].map(
            (c) => ({
              from: c.from,
              to: c.to,
            }),
          );
          const deco = line('mdr-li', { style: `padding-left:${width}ch;text-indent:-${width}ch` });
          this.lines(node.from, node.to, deco, vFrom, vTo, nested);
        }
        return true;
      }
      case 'ListMark': {
        const n = node.node;
        if (n.parent?.parent?.name === 'OrderedList') {
          this.decorations.push(M.olMark.range(node.from, node.to));
          return false;
        }
        const to = this.text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        this.pushAtomic(n.nextSibling?.name === 'Task' ? hide : bullet, node.from, to);
        return false;
      }
      case 'TaskMarker': {
        const checked = this.text(node.from, node.to) !== '[ ]';
        const to = this.text(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        this.pushAtomic(checked ? checkboxOn : checkboxOff, node.from, to);
        return false;
      }

      case 'Emphasis':
        this.decorations.push(M.em.range(node.from, node.to));
        return true;
      case 'StrongEmphasis':
        this.decorations.push(M.strong.range(node.from, node.to));
        return true;
      case 'EmphasisMark':
      case 'HighlightMark':
      case 'StrikethroughMark':
      case 'LinkMark':
      case 'LinkTitle':
      case 'LinkLabel':
        this.hideInline(node.from, node.to);
        return false;
      case 'InlineCode':
        this.decorations.push(M.code.range(node.from, node.to));
        return true;
      case 'CodeMark':
        if (node.node.parent?.name === 'InlineCode') this.hideInline(node.from, node.to);
        return false;
      case 'Link':
      case 'Autolink':
        this.decorations.push(M.link.range(node.from, node.to));
        return true;
      case 'Image':
        this.decorations.push(M.image.range(node.from, node.to));
        return true;
      case 'URL': {
        const parent = node.node.parent?.name;
        if (parent === 'Link' || parent === 'Image') this.hideInline(node.from, node.to);
        else if (parent !== 'Autolink') this.decorations.push(M.link.range(node.from, node.to));
        return false;
      }
      case 'Highlight':
        this.decorations.push(M.highlight.range(node.from, node.to));
        return true;
      case 'Strikethrough':
        this.decorations.push(M.del.range(node.from, node.to));
        return true;
      case 'InlineMath':
        this.decorations.push(M.math.range(node.from, node.to));
        return true;
      case 'MathMark':
        if (node.node.parent?.name === 'InlineMath') this.hideInline(node.from, node.to);
        else this.dimBlock(node.from, node.to);
        return false;
      case 'Escape':
        this.hideInline(node.from, node.from + 1);
        return false;
      case 'Comment':
        this.decorations.push(M.comment.range(node.from, node.to));
        return false;

      case 'FencedCode': {
        this.lines(node.from, node.to, line('mdr-fence'), vFrom, vTo);
        const active = this.revealed(node.from, node.to, true);
        const edge = line(
          active ? 'mdr-fence-edge mdr-fence-active' : 'mdr-fence-edge mdr-fence-dim',
        );
        for (const m of node.node.getChildren('CodeMark'))
          this.lines(m.from, m.from, edge, vFrom, vTo);
        return false;
      }
      case 'CodeBlock':
        this.lines(node.from, node.to, line('mdr-fence'), vFrom, vTo);
        return false;
      case 'BlockMath':
        this.lines(node.from, node.to, line('mdr-math-block'), vFrom, vTo);
        for (const m of node.node.getChildren('MathMark')) this.dimBlock(m.from, m.to);
        return false;
      case 'Frontmatter':
        this.lines(node.from, node.to, line('mdr-frontmatter'), vFrom, vTo);
        for (const m of node.node.getChildren('FrontmatterMark')) this.dimBlock(m.from, m.to);
        return false;
      case 'Table':
        this.lines(node.from, node.to, line('mdr-table'), vFrom, vTo);
        return false;
      case 'HorizontalRule':
        this.lines(node.from, node.to, line('mdr-hr'), vFrom, vTo);
        return false;
      case 'HTMLBlock':
        this.lines(node.from, node.to, line('mdr-html'), vFrom, vTo);
        return false;
      case 'CommentBlock':
        this.lines(node.from, node.to, line('mdr-comment-block'), vFrom, vTo);
        return false;
      default:
        return true;
    }
  }
}
