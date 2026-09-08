import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import {
  type OutlineEntry,
  offsetFromPoint,
  Renderer,
  type RenderOptions,
  resolveOffset,
  toDom,
} from '@mdreader/markdown';
import type { Enhancer } from './enhance.ts';

/**
 * Read mode: the rendered document, built from the same parse the editor
 * uses (design 4.2), in chunks.
 *
 * The first screenful is parsed and rendered synchronously so the page is
 * there when the tab appears; the rest follows in idle slices. A 1 MB
 * document is tens of thousands of elements, which is far more than one
 * frame of DOM work, and the Phase 1 gate measures this path.
 */

/** How much source to hand the parser per slice. */
const PARSE_STEP = 20_000;
/** How long one parse slice may take before the renderer takes its turn. */
const PARSE_TIMEOUT = 30;
/** How long one idle slice may spend building DOM. */
const IDLE_BUDGET = 8;
/** Rendered ahead of the fold, so the first scroll has somewhere to go. */
const FIRST_PAINT_MARGIN = 400;
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
 * is what lets it act on a document still being rendered in chunks.
 */
const SHOW_COMMENTS = 'mdr-show-comments';
/** How long a fence's copy button says it copied. */
const COPIED_FOR = 1200;

interface Block {
  el: HTMLElement;
  /** The heading level when this block is a top-level heading. */
  level: number | null;
  id: string | null;
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
  private readonly renderer: Renderer;
  private readonly offsets = new WeakMap<Text, number>();
  private readonly blocks: Block[] = [];
  private readonly outline: OutlineEntry[] = [];
  private readonly folded: Set<string>;
  /** Heading levels whose sections are folded, outermost first. */
  private stack: number[] = [];
  private pos = 0;
  /** How much of the source the shared parse has covered. */
  private parsed = 0;
  private finished = false;
  private handle: IdleHandle | null = null;
  private alive = true;

  constructor(private readonly options: ReadViewOptions) {
    this.parent = options.parent;
    this.state = options.state;
    this.source = options.state.doc.toString();
    this.renderer = new Renderer(this.source, options.render);
    this.folded = new Set(options.folded ?? []);
    this.body = document.createElement('article');
    this.body.className = 'read';
    this.body.classList.toggle(SHOW_COMMENTS, options.comments === true);
    this.body.tabIndex = -1;
    this.body.addEventListener('click', this.onClick);
    this.parent.appendChild(this.body);
    // The first screenful, now: everything below it can wait for an idle
    // moment, but the reader is looking at this part.
    this.pump(Number.POSITIVE_INFINITY, this.parent.clientHeight + FIRST_PAINT_MARGIN);
  }

  destroy(): void {
    this.alive = false;
    if (this.handle !== null) cancelIdle(this.handle);
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
  }

  // --- rendering ----------------------------------------------------------

  /**
   * Parse and render until the budget or the height target is reached.
   * `minHeight` of 0 means "one slice of work"; the first call asks for a
   * screenful and gets it synchronously.
   */
  private pump(budgetMs: number, minHeight: number): void {
    const until = performance.now() + budgetMs;
    while (this.alive && !this.finished) {
      // Always ask for more than the parse already has, so a block longer
      // than one slice cannot leave the loop asking the same question.
      const upto = Math.min(this.source.length, Math.max(this.pos, this.parsed) + PARSE_STEP);
      const tree = ensureSyntaxTree(this.state, upto, PARSE_TIMEOUT) ?? syntaxTree(this.state);
      const grew = tree.length > this.parsed;
      this.parsed = Math.max(this.parsed, tree.length);
      const complete = this.parsed >= this.source.length;
      const rendered = this.renderFrom(tree, complete, until, minHeight);
      if (rendered === 0) {
        if (complete) {
          this.finished = true;
          break;
        }
        // The parser produced no whole block this turn; give it another.
        if (!grew) break;
      }
      if (performance.now() >= until) break;
      if (minHeight > 0 && this.body.scrollHeight >= minHeight) break;
    }
    this.options.onOutline?.([...this.outline], this.finished);
    if (this.alive && !this.finished && this.handle === null) this.schedule();
  }

  private schedule(): void {
    this.handle = idle((deadline) => {
      this.handle = null;
      if (!this.alive) return;
      this.pump(Math.max(IDLE_BUDGET, deadline.timeRemaining()), 0);
    });
  }

  /** Render whole top-level blocks the tree already covers. */
  private renderFrom(tree: Tree, complete: boolean, until: number, minHeight: number): number {
    let node = tree.topNode.childAfter(this.pos);
    let count = 0;
    const added: HTMLElement[] = [];
    const first = this.blocks.length;
    while (node) {
      // The last block of a partial tree may still grow; leave it.
      if (!complete && node.to >= tree.length) break;
      const rendered = this.renderer.block(node);
      this.pos = node.to;
      count += 1;
      if (rendered?.kind === 'element') {
        const { fragment } = toDom([rendered], { offsets: this.offsets });
        const el = fragment.firstElementChild as HTMLElement | null;
        if (el) {
          this.body.appendChild(fragment);
          this.record(el);
          added.push(el);
        }
      }
      node = node.nextSibling;
      if (performance.now() >= until) break;
      // Measuring costs a layout, so it happens every few blocks rather
      // than every one; first paint only has to fill the viewport.
      if (minHeight > 0 && count % 16 === 0 && this.body.scrollHeight >= minHeight) break;
    }
    if (added.length > 0) {
      this.applyFolds(first);
      this.options.enhance?.run(added);
    }
    return count;
  }

  /** Note a block for folding and the outline, and give a heading its control. */
  private record(el: HTMLElement): void {
    const level = /^h([1-6])$/.exec(el.tagName.toLowerCase());
    const block: Block = {
      el,
      level: level?.[1] ? Number(level[1]) : null,
      id: el.id === '' ? null : el.id,
    };
    this.blocks.push(block);
    if (block.level !== null && block.id !== null) this.addFoldControl(el, block.id);
    for (const pre of [
      ...(el.matches('pre.mdr-code') ? [el] : []),
      ...Array.from(el.querySelectorAll<HTMLElement>('pre.mdr-code')),
    ]) {
      ReadView.addCodeChrome(pre);
    }
    for (const heading of [
      ...(block.level !== null ? [el] : []),
      ...Array.from(el.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')),
    ]) {
      const at = /^h([1-6])$/.exec(heading.tagName.toLowerCase())?.[1];
      if (!at) continue;
      this.outline.push({
        level: Number(at),
        text: (heading.textContent ?? '').trim(),
        id: heading.id,
        from: Number(heading.dataset.from ?? 0),
        to: Number(heading.dataset.to ?? 0),
      });
    }
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

  /** Hide the blocks under every folded heading, starting at `from`. */
  private applyFolds(from: number): void {
    if (from === 0) this.stack = [];
    for (let i = from; i < this.blocks.length; i++) {
      const block = this.blocks[i] as Block;
      if (block.level !== null) {
        while (this.stack.length > 0 && (this.stack.at(-1) as number) >= block.level) {
          this.stack.pop();
        }
      }
      block.el.classList.toggle(FOLDED_AWAY, this.stack.length > 0);
      if (block.level !== null && block.id !== null && this.folded.has(block.id)) {
        this.stack.push(block.level);
        block.el.classList.add('folded');
      } else if (block.level !== null) {
        block.el.classList.remove('folded');
      }
    }
  }

  toggleFold(id: string): void {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    const button = this.body.querySelector<HTMLElement>(`button[data-fold="${CSS.escape(id)}"]`);
    button?.setAttribute('aria-expanded', String(!this.folded.has(id)));
    this.applyFolds(0);
    this.options.onFolded?.([...this.folded]);
  }

  get foldedIds(): string[] {
    return [...this.folded];
  }

  /** Show or fold away the comments, without touching what is rendered. */
  setComments(shown: boolean): void {
    this.body.classList.toggle(SHOW_COMMENTS, shown);
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

  /** Render far enough that `offset` is in the page, then put it on screen. */
  scrollToOffset(offset: number): void {
    while (this.alive && !this.finished && this.pos < offset) this.pump(50, 0);
    const block = this.blockAt(offset);
    if (!block) return;
    this.parent.scrollTop = Math.max(0, block.offsetTop - SCROLL_MARGIN);
  }

  scrollToId(id: string): boolean {
    let target = this.body.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    while (this.alive && !target && !this.finished) {
      this.pump(50, 0);
      target = this.body.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    }
    if (!target) return false;
    const top = target.getBoundingClientRect().top - this.body.getBoundingClientRect().top;
    this.parent.scrollTop = Math.max(0, top - SCROLL_MARGIN);
    return true;
  }

  /** The source offset of the first block on screen, for a mode switch. */
  topOffset(): number {
    const visible = this.blocks.filter((block) => ReadView.shown(block));
    if (visible.length === 0) return 0;
    const target = this.parent.scrollTop + SCROLL_MARGIN;
    let low = 0;
    let high = visible.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const el = (visible[mid] as Block).el;
      if (el.offsetTop + el.offsetHeight > target) {
        found = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return Number((visible[found] as Block).el.dataset.from ?? 0);
  }

  /** A block the reader cannot see: folded away, or hidden by the renderer. */
  private static shown(block: Block): boolean {
    return !block.el.hidden && !block.el.classList.contains(FOLDED_AWAY);
  }

  private blockAt(offset: number): HTMLElement | null {
    let found: HTMLElement | null = null;
    for (const block of this.blocks) {
      if (!ReadView.shown(block)) continue;
      if (Number(block.el.dataset.from ?? 0) > offset) break;
      found = block.el;
    }
    return found;
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
