import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type WidgetType } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { loneImage } from '../nodes.ts';
import { type RevealRange, revealRanges } from '../reveal.ts';
import { tableModel } from '../table/model.ts';
import { activeCellField, setActiveCell } from '../table/state.ts';
import { TableWidget } from '../table/widget.ts';
import { type PreviewOptions, previewOptions } from './options.ts';
import { frontmatterModel, PropertiesWidget } from './properties.ts';
import { DiagramWidget, ImageWidget, MathWidget } from './widgets.ts';

const containers: ReadonlySet<string> = new Set([
  'Document',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
]);

/** Nodes that can become a widget, so the walk knows where to stop. */
const candidates: ReadonlySet<string> = new Set([
  'Table',
  'BlockMath',
  'FencedCode',
  'Frontmatter',
  'Paragraph',
]);

interface BlockState {
  deco: DecorationSet;
  /** Block reveal ranges at the time `deco` was built, to find blocks whose reveal state flipped. */
  revealed: RevealRange[];
}

/** The destination and text of an image node, as its own source spells them. */
function imageParts(node: SyntaxNode, state: EditorState): ImageWidget | null {
  const url = node.getChild('URL');
  if (!url) return null;
  const marks = node.getChildren('LinkMark');
  const open = marks[0];
  const close = marks.find((mark) => state.doc.sliceString(mark.from, mark.to) === ']');
  const alt = open && close ? state.doc.sliceString(open.to, close.from) : '';
  const title = node.getChild('LinkTitle');
  return new ImageWidget(
    state.doc.sliceString(url.from, url.to),
    alt,
    title ? state.doc.sliceString(title.from + 1, title.to - 1) : '',
    state.facet(previewOptions),
  );
}

/** The language of a fence, lower cased, or the empty string. */
function fenceLanguage(node: SyntaxNode, state: EditorState): string {
  const info = node.getChild('CodeInfo');
  if (!info) return '';
  return (state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] ?? '').toLowerCase();
}

/** The text of a fence's body, which is what a diagram is drawn from. */
function fenceBody(node: SyntaxNode, state: EditorState): string {
  let out = '';
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeText') out += state.doc.sliceString(child.from, child.to);
  }
  return out.replace(/^\n/, '');
}

/**
 * The widget one block becomes, or null when it stays source.
 *
 * Math, diagrams, and images are only widgets at the top level. A block
 * replacement covers whole lines, so one inside a list item or a
 * blockquote would hide the marker that puts it there; a table is the
 * exception the WP 0.4 prototype already settled.
 */
function widgetFor(
  node: SyntaxNode,
  state: EditorState,
  options: PreviewOptions,
): WidgetType | null {
  const top = node.parent?.name === 'Document';
  switch (node.name) {
    case 'Table': {
      const model = tableModel(node, state.doc);
      if (!model) return null;
      const active = state.field(activeCellField);
      return new TableWidget(
        model,
        state.doc.sliceString(node.from, node.to),
        syntaxTree(state),
        state.doc,
        active && active.table === node.from ? active : null,
      );
    }
    case 'BlockMath': {
      if (!top) return null;
      const marks = node.getChildren('MathMark');
      // An unclosed block is still being written; showing a formula for it
      // would be showing something the file does not say yet.
      if (marks.length < 2) return null;
      let tex = '';
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'MathContent') tex += state.doc.sliceString(child.from, child.to);
      }
      return tex.trim() === '' ? null : new MathWidget(tex, options);
    }
    case 'FencedCode': {
      if (!top || fenceLanguage(node, state) !== 'mermaid') return null;
      const body = fenceBody(node, state);
      return body.trim() === '' ? null : new DiagramWidget(body, options);
    }
    case 'Frontmatter': {
      const model = frontmatterModel(state);
      return model ? new PropertiesWidget(model.source) : null;
    }
    case 'Paragraph': {
      const image = loneImage(node, (from, to) => state.doc.sliceString(from, to));
      return image ? imageParts(image, state) : null;
    }
    default:
      return null;
  }
}

/** Widgets for every block overlapping one of `ranges` that the reveal rule does not show as source. */
function buildWidgetsIn(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  revealed: readonly RevealRange[],
): Range<Decoration>[] {
  const doc = state.doc;
  const options = state.facet(previewOptions);
  const out: Range<Decoration>[] = [];
  const seen = new Set<number>();
  for (const range of ranges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (!candidates.has(node.name)) return containers.has(node.name);
        if (seen.has(node.from)) return false;
        seen.add(node.from);
        if (revealed.some((r) => r.from < node.to && r.to > node.from)) return false;
        const widget = widgetFor(node.node, state, options);
        if (!widget) return false;
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        out.push(Decoration.replace({ widget, block: true }).range(from, to));
        return false;
      },
    });
  }
  return out;
}

/**
 * The span of the new tree whose top-level blocks were not reused from
 * the old tree. Lezer keeps the same `Tree` object for a block whose text
 * and context did not change, so walking the top-level children from
 * both ends until identity stops matching bounds every block that can
 * have changed. Null means nothing structural changed.
 */
export function changedRegion(oldTree: Tree, newTree: Tree): { from: number; to: number } | null {
  const a = oldTree.cursor();
  const b = newTree.cursor();
  let prefixEnd = 0;
  let aHas = a.firstChild();
  let bHas = b.firstChild();
  while (aHas && bHas && a.tree !== null && a.tree === b.tree) {
    prefixEnd = b.to;
    aHas = a.nextSibling();
    bHas = b.nextSibling();
  }
  if (!bHas) return aHas ? { from: prefixEnd, to: newTree.length } : null;
  const a2 = oldTree.cursor();
  const b2 = newTree.cursor();
  let suffixStart = newTree.length;
  let aH = a2.lastChild();
  let bH = b2.lastChild();
  while (aH && bH && a2.tree !== null && a2.tree === b2.tree && b2.from > prefixEnd) {
    suffixStart = b2.from;
    aH = a2.prevSibling();
    bH = b2.prevSibling();
  }
  return { from: prefixEnd, to: Math.max(prefixEnd, suffixStart) };
}

function blockReveal(state: EditorState): RevealRange[] {
  return revealRanges(state).filter((r) => r.block);
}

function sameRanges(a: readonly RevealRange[], b: readonly RevealRange[]): boolean {
  return a.length === b.length && a.every((r, i) => r.from === b[i]?.from && r.to === b[i]?.to);
}

function fullBuild(state: EditorState): BlockState {
  const revealed = blockReveal(state);
  const deco = Decoration.set(
    buildWidgetsIn(state, [{ from: 0, to: state.doc.length }], revealed),
    true,
  );
  return { deco, revealed };
}

/**
 * One block widget per table, math block, Mermaid fence, lone image, and
 * frontmatter block that the reveal rule does not show as source.
 *
 * Updated incrementally: existing widgets are mapped through the change,
 * and only the blocks Lezer reparsed, the blocks whose reveal state
 * flipped, and the tables that gained or lost the active cell are
 * rebuilt. A keystroke in a 1 MB document therefore costs a walk over the
 * reparsed blocks, not over every block. A widget spans whole lines
 * because block replacements must; a table indented in a list or prefixed
 * by `>` loses that prefix visually while it is a widget.
 */
export const blockWidgetsField = StateField.define<BlockState>({
  create: fullBuild,
  update(value, tr) {
    const oldTree = syntaxTree(tr.startState);
    const newTree = syntaxTree(tr.state);
    const dirty: { from: number; to: number }[] = [];
    let deco = value.deco;
    if (tr.docChanged) deco = deco.map(tr.changes);
    if (tr.docChanged || oldTree !== newTree) {
      const region = changedRegion(oldTree, newTree);
      if (region) dirty.push(region);
    }
    const revealed = blockReveal(tr.state);
    if (!sameRanges(revealed, value.revealed)) {
      for (const r of value.revealed)
        dirty.push({ from: tr.changes.mapPos(r.from, -1), to: tr.changes.mapPos(r.to, 1) });
      for (const r of revealed) dirty.push(r);
    }
    const oldActive = tr.startState.field(activeCellField, false) ?? null;
    const newActive = tr.state.field(activeCellField);
    if (tr.effects.some((e) => e.is(setActiveCell))) {
      if (oldActive) dirty.push(point(tr.changes.mapPos(oldActive.table, -1)));
      if (newActive) dirty.push(point(newActive.table));
    }
    if (dirty.length === 0) return { deco, revealed };
    const doc = tr.state.doc;
    const ranges = dirty.map((d) => ({
      from: doc.lineAt(Math.min(d.from, doc.length)).from,
      to: doc.lineAt(Math.min(d.to, doc.length)).to,
    }));
    deco = deco.update({
      filter: (from, to) => !ranges.some((r) => from <= r.to && to >= r.from),
      add: buildWidgetsIn(tr.state, ranges, revealed),
      sort: true,
    });
    return { deco, revealed };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

function point(pos: number): { from: number; to: number } {
  return { from: pos, to: pos };
}
