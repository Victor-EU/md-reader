import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import {
  headingLevel,
  normalizeLabel,
  type OutlineEntry,
  offsetFromPoint,
  Renderer,
  type RenderOptions,
  resolveOffset,
  Slugger,
  scanSource,
  textOf,
  toDom,
} from '@mdreader/markdown';
import type { Enhancer } from './enhance.ts';
import { Heights } from './heights.ts';

/**
 * Read mode: a window onto the rendered document, built from the same
 * parse the editor uses (design 4.2), a screenful at a time.
 *
 * Two passes, and they answer different questions. The first walks the
 * parse and writes down where every block begins and ends, what it will
 * be worth in pixels, and every id the page will have — cheap enough to
 * run over a very large file in idle slices, and it never touches the
 * DOM. The second builds the blocks the reader can actually see, and
 * takes them out of the page again when they scroll away, so that the
 * document in the window costs a screenful of elements whether the file
 * is a page long or ten megabytes (plan WP 2.7). What is not in the page
 * is a measured gap above and below it, which is what leaves the
 * scrollbar telling the truth.
 *
 * Building blocks out of order is only sound because nothing in a block
 * depends on the ones before it: the order-dependent facts — which
 * heading is `#notes` and which is `#notes-2`, which footnote is 1 — are
 * settled by the first pass, over the whole document, before any of them
 * is drawn.
 */

/**
 * How much source to hand the parser at once before the page is up, and
 * how much afterwards.
 *
 * The first call is the reader waiting, so it asks for a screenful at a
 * time. What is left is a walk to the end of the document with nothing
 * drawn, and it runs one slice per idle moment — which is at best once a
 * frame, so a small step would leave a ten megabyte file measured in
 * minutes of doing very little.
 */
const PARSE_STEP = 20_000;
const WALK_STEP = 250_000;
/** How long one parse slice may take before the view takes its turn. */
const PARSE_TIMEOUT = 30;
/** How long one idle slice may spend walking the parse. */
const IDLE_BUDGET = 8;
/** Found ahead of the fold before the first paint, so the first scroll has somewhere to go. */
const FIRST_PAINT_MARGIN = 400;
/** How far past the viewport, above and below, the page is built. */
const WINDOW_MARGIN = 800;
/**
 * How many blocks are kept, out of the page, after the reader scrolls
 * past them. Scrolling back is then a re-insertion rather than a render,
 * and a fence that Shiki has already coloured stays coloured.
 */
const KEEP = 300;
/** Where a heading lands when something scrolls to it. */
const SCROLL_MARGIN = 12;
/**
 * What folding puts on a hidden block. It is a class and not the `hidden`
 * property because the renderer already uses `hidden` for the comments it
 * folds away, and folding a section must not bring them back.
 */
const FOLDED_AWAY = 'mdr-folded-away';
/**
 * What showing the comments puts on the article. The renderer marks every
 * comment `hidden`, so the toggle is one class and no re-render — which
 * is what lets it act on a document still being walked.
 */
const SHOW_COMMENTS = 'mdr-show-comments';
/** How long a fence's copy button says it copied. */
const COPIED_FOR = 1200;
/** Blocks whose children can be blocks, and so can hold a heading. */
const CONTAINERS = new Set([
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'FootnoteDefinition',
]);

/** One top-level block: where it is, what it is worth, and whether it is in the page. */
interface Slot {
  from: number;
  to: number;
  /** The block once built, kept for a while after it leaves the page. */
  el: HTMLElement | null;
  /** In the page now. */
  live: boolean;
  /** True once its height has been measured rather than guessed at. */
  measured: boolean;
  /** The parser's name for it, which is what a guess is calibrated by. */
  kind: string;
  /** True for a block that renders to nothing, like a link definition. */
  empty: boolean;
  /** A top-level heading's level, which is what folds the blocks below it. */
  level: number | null;
  /** A top-level heading's id, which is what a fold is remembered by. */
  id: string | null;
  /** Folded away by a heading above it. */
  under: boolean;
}

export interface ReadViewOptions {
  /** The scrolling pane. The rendered document is its only child. */
  parent: HTMLElement;
  state: EditorState;
  folded?: readonly string[];
  /** Show the comments the renderer folds away (design 4.3). */
  comments?: boolean;
  /** A click in the text: switch to Edit at this offset, `y` px down the pane. */
  onEdit?: (offset: number, y: number) => void;
  onOutline?: (entries: OutlineEntry[], complete: boolean) => void;
  onFolded?: (ids: string[]) => void;
  /** A link that is not an anchor in this document. */
  onLink?: (href: string, external: boolean) => void;
  /** The copy button on a fence (design 11). */
  onCopyCode?: (text: string) => void;
  /** A click on a task checkbox: the one-byte change at `offset` (design 4.5). */
  onToggleTask?: (offset: number) => void;
  enhance?: Enhancer;
  /** Design 8's image rules for the document being read. */
  render?: RenderOptions;
}

type IdleHandle = number;

interface IdleDeadline {
  timeRemaining(): number;
}

/** WebKit has no `requestIdleCallback`; a short timeout is close enough. */
const idle: (callback: (deadline: IdleDeadline) => void) => IdleHandle =
  typeof requestIdleCallback === 'function'
    ? (callback) => requestIdleCallback(callback, { timeout: 200 })
    : (callback) =>
        setTimeout(
          () => callback({ timeRemaining: () => IDLE_BUDGET }),
          1,
        ) as unknown as IdleHandle;

const cancelIdle: (handle: IdleHandle) => void =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;

export class ReadView {
  private readonly parent: HTMLElement;
  private readonly body: HTMLElement;
  private readonly source: string;
  private readonly state: EditorState;
  /** Walks the document in order: the outline, every id, and nothing drawn. */
  private readonly outliner: Renderer;
  /** Builds blocks, in whatever order the reader reaches them. */
  private readonly renderer: Renderer;
  private readonly offsets = new WeakMap<Text, number>();
  private readonly slots: Slot[] = [];
  /** What each block is worth in pixels, and so where each one starts. */
  private readonly heights = new Heights();
  private readonly outline: OutlineEntry[] = [];
  /** Every id in the page, by the source offset of what carries it. */
  private readonly ids = new Map<number, string>();
  /** Where an `#anchor` in this document leads, by id. */
  private readonly anchors = new Map<string, number>();
  private readonly folded: Set<string>;
  /** Heading levels whose sections are folded, outermost first. */
  private stack: number[] = [];
  /** Slots holding a built block that is not in the page, oldest first. */
  private kept: Slot[] = [];
  private pos = 0;
  /** How much of the source the shared parse has covered. */
  private parsed = 0;
  private tree: Tree;
  private finished = false;
  private handle: IdleHandle | null = null;
  private frame: number | null = null;
  private alive = true;
  /** The run of slots in the page: empty when `first > last`. */
  private first = 0;
  private last = -1;
  /** The article's own padding, before the gaps are added to it. */
  private padTop = 0;
  private padBottom = 0;
  private padded = false;
  /** What blocks of a kind have measured against what they were guessed at. */
  private readonly calibration = new Map<string, { guessed: number; measured: number }>();
  /** What the estimates were worked out from, so a change can be noticed. */
  private lineHeight = 24;
  private perLine = 80;
  private readonly resize: ResizeObserver | null;

  constructor(private readonly options: ReadViewOptions) {
    this.parent = options.parent;
    this.state = options.state;
    this.source = options.state.doc.toString();
    this.tree = syntaxTree(options.state);
    // Both renderers work from one walk of the file: what it defines and
    // what it refers to are properties of the document, and walking ten
    // megabytes of it more than once would be for nothing.
    const { references, notes, mentions } = scanSource(this.source);
    // Numbering is the source's, not the render's: see `FootnoteNumbers`.
    // A note nothing refers to still takes a number, after the ones that
    // are referred to, which is where an in-order render would put it.
    const named = new Set(mentions.map((each) => each.label));
    const order = [...mentions, ...[...notes].filter((label) => !named.has(label))];
    const shared: RenderOptions = {
      ...options.render,
      references,
      footnotes: notes,
      footnoteOrder: order,
    };
    this.outliner = new Renderer(this.source, { ...shared, slugger: new Slugger() });
    this.renderer = new Renderer(this.source, { ...shared, slugger: new Slugger() });
    for (const { label, at } of mentions) {
      this.anchors.set(this.renderer.footnoteAnchor(label).backId, at);
    }
    this.folded = new Set(options.folded ?? []);
    this.body = document.createElement('article');
    this.body.className = 'read';
    this.body.classList.toggle(SHOW_COMMENTS, options.comments === true);
    this.body.tabIndex = -1;
    this.body.addEventListener('click', this.onClick);
    this.parent.appendChild(this.body);
    this.metrics();
    this.parent.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(this.onResize) : null;
    this.resize?.observe(this.parent);
    // The first screenful, now: the rest of the document can be walked in
    // idle moments, but the reader is looking at this part.
    this.discover(
      Number.POSITIVE_INFINITY,
      PARSE_STEP,
      this.parent.clientHeight + FIRST_PAINT_MARGIN,
    );
    this.update();
  }

  destroy(): void {
    this.alive = false;
    if (this.handle !== null) cancelIdle(this.handle);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.parent.removeEventListener('scroll', this.onScroll);
    this.resize?.disconnect();
    this.body.removeEventListener('click', this.onClick);
    this.body.remove();
  }

  focus(): void {
    this.body.focus({ preventScroll: true });
  }

  get scrollTop(): number {
    return this.parent.scrollTop;
  }

  set scrollTop(value: number) {
    this.parent.scrollTop = value;
    this.update();
  }

  // --- walking the document ----------------------------------------------

  /**
   * Parse and take down blocks until the budget or the height target is
   * reached. `minHeight` of 0 means "one slice of work"; the first call
   * asks for a screenful and gets it synchronously.
   */
  private discover(budgetMs: number, step: number, minHeight = 0): void {
    const until = performance.now() + budgetMs;
    while (this.alive && !this.finished) {
      // Always ask for more than the parse already has, so a block longer
      // than one slice cannot leave the loop asking the same question.
      const upto = Math.min(this.source.length, Math.max(this.pos, this.parsed) + step);
      const tree = ensureSyntaxTree(this.state, upto, PARSE_TIMEOUT) ?? syntaxTree(this.state);
      const grew = tree.length > this.parsed;
      if (tree.length >= this.tree.length) this.tree = tree;
      this.parsed = Math.max(this.parsed, tree.length);
      const complete = this.parsed >= this.source.length;
      const found = this.take(tree, complete, until);
      if (found === 0) {
        if (complete) {
          this.finished = true;
          break;
        }
        // The parser produced no whole block this turn; give it another.
        if (!grew) break;
      }
      if (performance.now() >= until) break;
      if (minHeight > 0 && this.heights.total >= minHeight) break;
    }
    this.options.onOutline?.([...this.outline], this.finished);
    if (this.alive && !this.finished && this.handle === null) this.schedule();
  }

  private schedule(): void {
    this.handle = idle((deadline) => {
      this.handle = null;
      if (!this.alive) return;
      this.discover(Math.max(IDLE_BUDGET, deadline.timeRemaining()), WALK_STEP);
      // What was found may be what the window was waiting for.
      this.update();
    });
  }

  /** Take down the whole top-level blocks the tree already covers. */
  private take(tree: Tree, complete: boolean, until: number): number {
    let node = tree.topNode.childAfter(this.pos);
    let count = 0;
    const first = this.slots.length;
    while (node) {
      // The last block of a partial tree may still grow; leave it.
      if (!complete && node.to >= tree.length) break;
      this.add(node);
      this.pos = node.to;
      count += 1;
      node = node.nextSibling;
      // Reading the clock costs more than the work between two blocks.
      if ((count & 31) === 0 && performance.now() >= until) break;
    }
    if (count > 0) this.applyFolds(first);
    return count;
  }

  /** One block: its place, its ids, and what it is probably worth. */
  private add(node: SyntaxNode): void {
    const level = headingLevel(node.name);
    // A link definition renders to nothing at all, which is a block with
    // no element and no height rather than one waiting to be built.
    const empty = node.name === 'LinkReference';
    const slot: Slot = {
      from: node.from,
      to: node.to,
      el: null,
      live: false,
      measured: empty,
      kind: node.name,
      empty,
      level,
      id: null,
      under: false,
    };
    for (const heading of this.headingNodes(node)) {
      const rendered = this.outliner.block(heading);
      if (rendered?.kind !== 'element') continue;
      const id = rendered.attrs.id ?? '';
      const at = headingLevel(heading.name) ?? 1;
      this.outline.push({
        level: at,
        text: textOf(rendered.children).trim(),
        id,
        from: heading.from,
        to: heading.to,
      });
      this.ids.set(heading.from, id);
      this.anchors.set(id, heading.from);
      if (heading.from === node.from && level !== null) slot.id = id;
    }
    if (node.name === 'FootnoteDefinition') this.noteAnchor(node);
    this.slots.push(slot);
    this.heights.push(empty ? 0 : this.estimate(slot));
  }

  /** The headings a block holds, itself included, in document order. */
  private *headingNodes(node: SyntaxNode): Generator<SyntaxNode> {
    if (headingLevel(node.name) !== null) {
      yield node;
      return;
    }
    // Only into blocks that can hold one. Walking a paragraph would mean
    // walking every emphasis and link in the document to find nothing.
    if (!CONTAINERS.has(node.name)) return;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      yield* this.headingNodes(child);
    }
  }

  /** Where `#fn-3` leads, before the note it names has been built. */
  private noteAnchor(node: SyntaxNode): void {
    const labelNode = node.getChild('FootnoteLabel');
    if (!labelNode) return;
    const label = normalizeLabel(this.source.slice(labelNode.from, labelNode.to));
    this.anchors.set(this.renderer.footnoteAnchor(label).id, node.from);
  }

  /**
   * What a block will be worth in pixels, before it has ever been drawn.
   *
   * The scrollbar of a document nobody has scrolled through is built out
   * of these, and every one of them is replaced by a measurement the
   * first time the block is on screen. Lines are counted rather than
   * guessed at, because a list and a paragraph of the same length are
   * nothing like the same height — and then the guess is corrected by
   * what blocks of that kind have actually measured, because a heading
   * is a line and a half of a larger face with a blank line above it and
   * no arithmetic here should have to know that.
   */
  private estimate(slot: Slot): number {
    const base = this.lines(slot);
    const seen = this.calibration.get(slot.kind);
    return seen && seen.guessed > 0 ? (base * seen.measured) / seen.guessed : base;
  }

  /** The block as lines of the page, which is the guess before the correction. */
  private lines(slot: Slot): number {
    const doc = this.state.doc;
    const lines = doc.lineAt(slot.to).number - doc.lineAt(slot.from).number + 1;
    const wrapped = Math.ceil((slot.to - slot.from) / this.perLine);
    return Math.max(lines, wrapped, 1) * this.lineHeight + this.lineHeight * 0.5;
  }

  /** What a measurement says about every block of that kind still to come. */
  private calibrate(slot: Slot, height: number): void {
    const seen = this.calibration.get(slot.kind) ?? { guessed: 0, measured: 0 };
    seen.guessed += this.lines(slot);
    seen.measured += height;
    this.calibration.set(slot.kind, seen);
  }

  /** What the page is set in, which is what the estimates are made of. */
  private metrics(): boolean {
    const style = getComputedStyle(this.body);
    const size = Number.parseFloat(style.fontSize) || 16;
    const height = Number.parseFloat(style.lineHeight) || size * 1.6;
    // Half the font size per character is close enough for prose in any
    // of the three families, and the first measurement replaces it.
    const perLine = Math.max(20, (this.body.clientWidth || 700) / (size * 0.5));
    const changed = height !== this.lineHeight || perLine !== this.perLine;
    this.lineHeight = height;
    this.perLine = perLine;
    // Read once, from the stylesheet, before anything was written into
    // it: what the page is inset by, before the space that stands in for
    // the blocks that are not in it.
    if (!this.padded) {
      this.padded = true;
      this.padTop = Number.parseFloat(style.paddingTop) || 0;
      this.padBottom = Number.parseFloat(style.paddingBottom) || 0;
    }
    return changed;
  }

  /**
   * The type changed under the document — the reader zoomed, or the pane
   * was resized. Every height taken in the old type is wrong; the ones
   * still on screen are measured again on the next pass, and the rest are
   * scaled, which keeps the scrollbar roughly honest until they are.
   */
  private rescale(by: number): void {
    if (!Number.isFinite(by) || by <= 0) return;
    // Every height in the document is about to change, so the reader is
    // held by the block they are looking at rather than by a number of
    // pixels that is about to mean something else.
    const anchor = this.anchorAt(this.parent.scrollTop - this.body.offsetTop - this.padTop);
    const was = this.heights.upto(anchor);
    for (const [i, slot] of this.slots.entries()) {
      if (slot.empty || slot.under) continue;
      this.heights.set(i, slot.measured ? this.heights.height(i) * by : this.estimate(slot));
    }
    this.parent.scrollTop += this.heights.upto(anchor) - was;
  }

  // --- the window ---------------------------------------------------------

  private readonly onScroll = (): void => {
    if (this.frame !== null || !this.alive) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.update();
    });
  };

  private readonly onResize = (): void => {
    if (!this.alive) return;
    const was = this.lineHeight;
    if (this.metrics()) this.rescale(this.lineHeight / was);
    this.update();
  };

  /** Put the blocks the reader can see in the page, and take out the rest. */
  private update(): void {
    if (!this.alive || this.slots.length === 0) return;
    const was = this.lineHeight;
    if (this.metrics()) this.rescale(this.lineHeight / was);
    const origin = this.body.offsetTop + this.padTop;
    const top = this.parent.scrollTop - origin;
    const wantFirst = this.heights.indexAt(top - WINDOW_MARGIN);
    const wantLast = this.heights.indexAt(top + this.parent.clientHeight + WINDOW_MARGIN);
    this.remount(wantFirst, wantLast);
    this.paint();
    this.measure(top);
  }

  private remount(wantFirst: number, wantLast: number): void {
    while (this.first <= this.last && this.first < wantFirst) this.unmount(this.first++);
    while (this.last >= this.first && this.last > wantLast) this.unmount(this.last--);
    if (this.first > this.last) {
      this.first = wantFirst;
      this.last = wantFirst - 1;
    }
    while (this.last < wantLast) this.mount(++this.last, 'end');
    while (this.first > wantFirst) this.mount(--this.first, 'start');
  }

  /**
   * Build a block if it has never been built, and put it in the page.
   *
   * The run in the page is contiguous and in order, so a block joins it
   * at one end or the other and never has to be placed among the others.
   */
  private mount(at: number, end: 'start' | 'end'): void {
    const slot = this.slots[at] as Slot;
    if (slot.empty || slot.under) return;
    if (slot.el === null) this.build(slot);
    const el = slot.el;
    if (el === null) return;
    if (end === 'end') this.body.appendChild(el);
    else this.body.insertBefore(el, this.body.firstChild);
    slot.live = true;
  }

  /** Take a block out of the page, keeping it for a scroll back. */
  private unmount(at: number): void {
    const slot = this.slots[at] as Slot;
    if (!slot.live) return;
    slot.live = false;
    slot.el?.remove();
  }

  private build(slot: Slot): void {
    const node = this.blockNode(slot.from);
    const rendered = node ? this.renderer.block(node) : null;
    const fragment =
      rendered?.kind === 'element' ? toDom([rendered], { offsets: this.offsets }).fragment : null;
    const el = (fragment?.firstElementChild ?? null) as HTMLElement | null;
    if (el === null) {
      slot.empty = true;
      slot.measured = true;
      this.heights.set(this.slots.indexOf(slot), 0);
      return;
    }
    this.dress(slot, el);
    slot.el = el;
    this.kept.push(slot);
    // Everything above the cap is let go of: it can be built again, and
    // a document read from end to end must not leave the whole of it in
    // the window's memory (plan WP 2.7). What is still in the page is
    // not a candidate, so it goes to the back of the queue instead.
    for (let guard = this.kept.length; this.kept.length > KEEP && guard > 0; guard--) {
      const old = this.kept.shift() as Slot;
      if (old.live) this.kept.push(old);
      else old.el = null;
    }
    this.options.enhance?.run([el]);
  }

  /** The top-level node a slot was taken from. */
  private blockNode(from: number): SyntaxNode | null {
    const node = this.tree.topNode.childAfter(from);
    return node && node.from === from ? node : null;
  }

  /** What a block needs that the renderer does not give it. */
  private dress(slot: Slot, el: HTMLElement): void {
    // Every heading takes the id the first pass gave it. That pass walks
    // the whole document in order, which is the only order that can say
    // which of two headings called "Notes" is `#notes` and which is
    // `#notes-2`; a block built when the reader scrolls to it knows
    // nothing about what came before it.
    for (const heading of ReadView.headingsIn(el)) {
      const id = this.ids.get(Number(heading.dataset.from ?? -1));
      if (id !== undefined) heading.id = id;
    }
    if (slot.level !== null && slot.id !== null) {
      this.addFoldControl(el, slot.id);
      el.classList.toggle('folded', this.folded.has(slot.id));
    }
    el.classList.toggle(FOLDED_AWAY, slot.under);
    for (const pre of [
      ...(el.matches('pre.mdr-code') ? [el] : []),
      ...Array.from(el.querySelectorAll<HTMLElement>('pre.mdr-code')),
    ]) {
      ReadView.addCodeChrome(pre);
    }
  }

  private static *headingsIn(el: HTMLElement): Generator<HTMLElement> {
    if (/^h[1-6]$/.test(el.tagName.toLowerCase())) yield el;
    yield* Array.from(el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'));
  }

  // --- heights ------------------------------------------------------------

  /**
   * The first slot that starts at or below `y`: what the reader is
   * looking at, rather than the one they are looking past. Pinning the
   * block above would leave a change to that block's own height moving
   * everything under it, which is the whole page.
   */
  private anchorAt(y: number): number {
    const at = this.heights.indexAt(y);
    if (this.heights.upto(at) >= y) return at;
    return Math.min(at + 1, this.slots.length - 1);
  }

  /**
   * Measure what is in the page, from the block the reader is looking at
   * downwards.
   *
   * A block is worth the distance to the next one, margins and all, which
   * is what the gap standing in for it has to be. Only from the top of
   * the viewport down, though: correcting a block above the fold would
   * move everything below it — the whole page — and the scroll would
   * have to be moved back by the same amount to keep the reader still.
   * That write stops the smooth scroll a keyboard starts, which is how
   * Home in a very long document came to land wherever the correction
   * happened to fire rather than at the top. A block above the fold
   * keeps its guess until the reader comes back to it.
   */
  private measure(top: number): void {
    // Nothing to measure from when the page itself is not on screen.
    if (this.body.offsetParent === null) return;
    let previous: { at: number; el: HTMLElement } | null = null;
    for (let i = Math.max(this.first, this.anchorAt(top)); i <= this.last; i++) {
      const slot = this.slots[i] as Slot;
      if (!slot.live || slot.el === null) continue;
      // A block the renderer hid — a comment, folded away in Read mode
      // (design 4.3) — has no box at all. Its `offsetTop` is zero, which
      // would put the block above it somewhere absurd, so it is worth
      // nothing and nothing is measured from it.
      if (slot.el.offsetParent === null) {
        this.heights.set(i, 0);
        slot.measured = true;
        continue;
      }
      if (previous !== null) {
        const above = this.slots[previous.at] as Slot;
        const height = slot.el.offsetTop - previous.el.offsetTop;
        // A block that is drawn is worth something. Anything else is the
        // page answering about a layout it does not have, and the guess
        // it already has is better than that.
        if (height > 0) {
          if (!above.measured) this.calibrate(above, height);
          above.measured = true;
          this.heights.set(previous.at, height);
        }
      }
      previous = { at: i, el: slot.el };
    }
  }

  /**
   * The gaps: what the blocks that are not in the page would have been.
   *
   * They are the article's own padding rather than elements of their
   * own, so the page is still a list of blocks and every rule written
   * for it still means what it says. `.read > :first-child` is one of
   * those rules and is what makes the measurement add up: the space
   * above a block includes the margin between it and the block before
   * it, so the one at the top of the window must not have that margin
   * again.
   */
  private paint(): void {
    const above = this.heights.upto(this.first);
    const below = Math.max(0, this.heights.total - this.heights.upto(this.last + 1));
    this.body.style.paddingTop = `${this.padTop + above}px`;
    this.body.style.paddingBottom = `${this.padBottom + below}px`;
  }

  // --- folding ------------------------------------------------------------

  private addFoldControl(heading: HTMLElement, id: string): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mdr-fold';
    button.dataset.fold = id;
    button.setAttribute('aria-expanded', String(!this.folded.has(id)));
    button.setAttribute('aria-label', `Fold ${heading.textContent ?? 'section'}`);
    heading.prepend(button);
  }

  /**
   * Fold away the blocks under every folded heading, starting at `from`.
   *
   * A folded block is worth nothing and is not built: a folded section is
   * the one case where thousands of blocks can share a single point on
   * the page, and a window measured in pixels would take in all of them.
   */
  private applyFolds(from: number): void {
    if (from === 0) this.stack = [];
    for (let i = from; i < this.slots.length; i++) {
      const slot = this.slots[i] as Slot;
      if (slot.level !== null) {
        while (this.stack.length > 0 && (this.stack.at(-1) as number) >= slot.level) {
          this.stack.pop();
        }
      }
      const under = this.stack.length > 0;
      if (under !== slot.under) {
        slot.under = under;
        slot.el?.classList.toggle(FOLDED_AWAY, under);
        if (under) {
          if (slot.live) this.unmount(i);
          this.heights.set(i, 0);
        } else {
          this.heights.set(i, this.estimate(slot));
          slot.measured = false;
        }
      }
      if (slot.level !== null && slot.id !== null && this.folded.has(slot.id)) {
        this.stack.push(slot.level);
        slot.el?.classList.add('folded');
      } else if (slot.level !== null) {
        slot.el?.classList.remove('folded');
      }
    }
  }

  toggleFold(id: string): void {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    const button = this.body.querySelector<HTMLElement>(`button[data-fold="${CSS.escape(id)}"]`);
    button?.setAttribute('aria-expanded', String(!this.folded.has(id)));
    this.applyFolds(0);
    // A fold takes blocks out of the middle of the run and an unfold puts
    // them back there, and the window is filled from its ends. So the
    // page is emptied and built again, which for a screenful of blocks
    // that are all still in hand costs no rendering at all.
    this.clear();
    this.update();
    this.options.onFolded?.([...this.folded]);
  }

  /** Take everything out of the page, for a window that has to be rebuilt. */
  private clear(): void {
    for (let i = this.first; i <= this.last; i++) this.unmount(i);
    this.first = 0;
    this.last = -1;
  }

  get foldedIds(): string[] {
    return [...this.folded];
  }

  /**
   * The type under the document changed — the reader zoomed, or gave it
   * a measure of its own. Every height was taken in the old type, so the
   * page is measured again from what is on screen.
   */
  remeasure(): void {
    const was = this.lineHeight;
    this.metrics();
    this.rescale(this.lineHeight / was);
    this.update();
  }

  /** Show or fold away the comments, without touching what is rendered. */
  setComments(shown: boolean): void {
    this.body.classList.toggle(SHOW_COMMENTS, shown);
    this.update();
  }

  /**
   * What the reader has selected, as a source range, so the annotation
   * commands work from Read mode too (design scenario S2 begins there).
   *
   * A caret gives an empty range at that offset; a selection that reaches
   * outside the page, or whose ends the offset map cannot place, gives
   * null rather than a range that would mark the wrong text.
   */
  sourceSelection(): { from: number; to: number } | null {
    const selection = this.body.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.body.contains(range.commonAncestorContainer)) return null;
    const from = resolveOffset(range.startContainer, range.startOffset, this.offsets);
    if (from === null) return null;
    if (range.collapsed) return { from, to: from };
    const to = resolveOffset(range.endContainer, range.endOffset, this.offsets);
    return to === null || to < from ? null : { from, to };
  }

  // --- scrolling ----------------------------------------------------------

  /** Walk far enough that `offset` has a place, then put it on screen. */
  scrollToOffset(offset: number): void {
    while (this.alive && !this.finished && this.pos <= offset) this.discover(50, WALK_STEP);
    const at = this.slotAt(offset);
    if (at === null) return;
    this.parent.scrollTop = Math.max(
      0,
      this.body.offsetTop + this.padTop + this.heights.upto(at) - SCROLL_MARGIN,
    );
    this.update();
  }

  scrollToId(id: string): boolean {
    // Headings and footnotes are written down as the document is walked,
    // so an anchor is found without building what it points at -- but a
    // link may name something further down than the walk has reached.
    while (this.alive && !this.finished && !this.anchors.has(id)) this.discover(50, WALK_STEP);
    const at = this.anchors.get(id);
    if (at === undefined) return false;
    this.scrollToOffset(at);
    return true;
  }

  /** The source offset of the first block on screen, for a mode switch. */
  topOffset(): number {
    if (this.slots.length === 0) return 0;
    const target = this.parent.scrollTop - this.body.offsetTop - this.padTop + SCROLL_MARGIN;
    for (let i = this.heights.indexAt(target); i < this.slots.length; i++) {
      const slot = this.slots[i] as Slot;
      if (!slot.empty && !slot.under) return slot.from;
    }
    return (this.slots.at(-1) as Slot).from;
  }

  /** The slot holding `offset`, skipping what the reader cannot see. */
  private slotAt(offset: number): number | null {
    let low = 0;
    let high = this.slots.length - 1;
    let found: number | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((this.slots[mid] as Slot).from <= offset) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    while (found !== null && found > 0 && (this.slots[found] as Slot).under) found -= 1;
    return found;
  }

  /**
   * A fence's language and its copy button (design 11).
   *
   * Both go inside the `pre` and out of flow, rather than in a header
   * element wrapped around it: the renderer's HTML is the document, it is
   * what the goldens pin, and a `div` is not allowed in a `pre` anyway.
   * The label is the fence's own info string — what the file says, not
   * our name for it — so there is no table here to drift.
   */
  private static addCodeChrome(pre: HTMLElement): void {
    if (pre.querySelector(':scope > .mdr-copy')) return;
    const language = pre.dataset.lang ?? '';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'mdr-copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy this code');
    if (language !== '') {
      const label = document.createElement('span');
      label.className = 'mdr-code-lang';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = language;
      pre.prepend(label);
    }
    pre.prepend(copy);
  }

  // --- input --------------------------------------------------------------

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const fold = target.closest<HTMLElement>('button.mdr-fold');
    if (fold?.dataset.fold) {
      this.toggleFold(fold.dataset.fold);
      return;
    }
    const copy = target.closest<HTMLElement>('button.mdr-copy');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code');
      this.options.onCopyCode?.(code?.textContent ?? '');
      // Said on the button rather than in the status bar: the pointer is
      // already here, and this is the only answer the gesture needs.
      copy.textContent = 'Copied';
      setTimeout(() => {
        if (copy.isConnected) copy.textContent = 'Copy';
      }, COPIED_FOR);
      return;
    }
    // A task checkbox is the one control in the page that changes the
    // document rather than the view. Its `data-from` is the marker's own
    // offset, which is the whole of what the toggle needs.
    const box = target.closest<HTMLInputElement>('input[type=checkbox][data-from]');
    if (box) {
      event.preventDefault();
      const at = Number(box.getAttribute('data-from'));
      if (Number.isFinite(at)) this.options.onToggleTask?.(at);
      return;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) this.scrollToId(decodeURIComponent(href.slice(1)));
      else this.options.onLink?.(href, link.hasAttribute('data-external'));
      return;
    }
    // A drag that selected text was not a click on a word.
    if (getSelection()?.isCollapsed === false) return;
    const offset = offsetFromPoint(event.clientX, event.clientY, this.offsets);
    if (offset === null) return;
    this.options.onEdit?.(offset, event.clientY - this.parent.getBoundingClientRect().top);
  };
}
