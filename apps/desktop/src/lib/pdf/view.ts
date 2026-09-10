import { Heights } from '../read/heights.ts';
import type { PdfPlace } from '../workspace.svelte.ts';
import type { PdfDoc } from './document.svelte.ts';
import type { PdfHit } from './find.ts';

/**
 * A window onto a PDF, a screenful of pages at a time (ADR 0035, plan
 * WP 2.7).
 *
 * The same shape as Read mode's view and, for once, an easier one. Read
 * mode has to estimate what a block will be worth in pixels and correct
 * it after measuring, because a markdown block's height is unknown until
 * it is in the page. A PDF page's height is written in the file. So the
 * Fenwick tree is filled from the document rather than from the DOM, and
 * the scroll height is right from the first frame — a nicer property
 * than Read mode has ever had.
 *
 * What is in the page is the pages the reader can see and a little
 * either side. Each of those is a canvas the view owns and hands to the
 * engine, plus a layer of transparent text for selection and copy. A
 * page that scrolls away gives both back, and the render that was
 * drawing it is abandoned rather than finished.
 */

/** Space between pages, in CSS pixels, independent of zoom. */
const GAP = 16;
/** How far past the viewport, above and below, pages are drawn. */
const MARGIN = 600;
/** The zooms the commands step through. 1 is a point per CSS pixel. */
export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOMS[0];
export const MAX_ZOOM = ZOOMS[ZOOMS.length - 1] as number;

export interface PdfViewOptions {
  /** The scrolling element. The view fills it and owns its children. */
  parent: HTMLElement;
  pdf: PdfDoc;
  /** Where to open: the page the tab was left on, and the zoom. */
  place: PdfPlace;
  /** Called as the reader scrolls, for the status bar's page number. */
  onPlace?: (place: PdfPlace) => void;
  /**
   * A page that would not draw. Reported rather than swallowed: a blank
   * page and a page of white paper look the same, and the difference is
   * the whole of what the reader needs to know.
   */
  onTrouble?: (message: string) => void;
}

/** One page that is currently in the page. */
interface Live {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  text: HTMLElement;
  /** Abandons the render when the page scrolls away. */
  drawing: AbortController | null;
  /** The scale its pixels were drawn at, so a zoom redraws it. */
  drawn: number;
  /** Whether its text layer has been built. */
  laid: boolean;
  /** The spans of its text layer, in run order, for Find to mark. */
  spans: HTMLElement[];
  /** What each of them said before Find marked any of it. */
  texts: string[];
}

export class PdfView {
  private readonly parent: HTMLElement;
  private readonly pdf: PdfDoc;
  private readonly onPlace: ((place: PdfPlace) => void) | undefined;
  private readonly onTrouble: ((message: string) => void) | undefined;
  /** Said once per document, not once per page a bad file fails to draw. */
  private toldOfTrouble = false;
  /** The element every page is positioned inside; its height is the scroll. */
  private readonly sheet: HTMLElement;
  /** Rebuilt on a zoom, which is why it is not `readonly`. */
  private heights = new Heights();
  private readonly live = new Map<number, Live>();
  private zoom: number;
  /** Which page is in front, one-based. What the status bar shows. */
  page = 1;
  private frame = 0;
  private destroyed = false;
  private readonly onScroll: () => void;
  private readonly resize: ResizeObserver | null;
  /** What Find has found, by page, so a page drawn later is marked too. */
  private hits = new Map<number, PdfHit[]>();
  private currentHit: PdfHit | null = null;

  constructor(options: PdfViewOptions) {
    this.parent = options.parent;
    this.pdf = options.pdf;
    this.onPlace = options.onPlace;
    this.onTrouble = options.onTrouble;
    this.zoom = clampZoom(options.place.zoom);
    this.page = Math.max(1, options.place.page);
    this.sheet = document.createElement('div');
    this.sheet.className = 'pdf-sheet';
    this.parent.replaceChildren(this.sheet);
    this.fill();
    this.onScroll = () => this.schedule();
    this.parent.addEventListener('scroll', this.onScroll, { passive: true });
    // The pane is one column, so a change of window width changes where
    // the pages sit but not how tall they are.
    this.resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.draw(this.centre()));
    this.resize?.observe(this.parent);
    this.goTo(this.page, options.place.fraction);
  }

  /**
   * Lay out every page from what the file says.
   *
   * Page one's size stands in for pages that have not been measured; the
   * ones the reader reaches correct themselves and the tree absorbs it.
   * A document whose pages are all the same size — which is most of them
   * — is exact from here on.
   */
  private fill(): void {
    const nominal = this.pdf.nominal;
    for (let page = 1; page <= this.pdf.pages; page++) {
      const size = this.pdf.sizeOf(page) ?? nominal;
      this.heights.push(size.height * this.zoom + GAP);
    }
    this.sheet.style.height = `${this.heights.total}px`;
  }

  /** Rebuild the page list at a new zoom, keeping the reader's place. */
  setZoom(zoom: number): void {
    const next = clampZoom(zoom);
    if (next === this.zoom) return;
    const at = this.place();
    this.zoom = next;
    for (const page of [...this.live.keys()]) this.retire(page);
    // A fresh tree rather than a rewritten one: `Heights` only ever
    // grows, because the document it was written for only ever does. A
    // thousand pushes is nothing beside the re-render that follows.
    this.heights = new Heights();
    this.fill();
    this.goTo(at.page, at.fraction);
  }

  get scale(): number {
    return this.zoom;
  }

  /** Where the reader is: the page in front and how far down it. */
  place(): PdfPlace {
    const top = this.parent.scrollTop;
    const at = this.heights.indexAt(top);
    const start = this.heights.upto(at);
    const height = Math.max(1, this.heights.height(at) - GAP);
    return {
      page: at + 1,
      fraction: Math.max(0, Math.min(1, (top - start) / height)),
      zoom: this.zoom,
    };
  }

  /** Put a page at the top of the window. */
  goTo(page: number, fraction = 0): void {
    const at = Math.max(0, Math.min(page - 1, this.pdf.pages - 1));
    const height = Math.max(1, this.heights.height(at) - GAP);
    this.parent.scrollTop = this.heights.upto(at) + height * fraction;
    this.draw(this.parent.scrollTop);
  }

  /** The scroll position the window is centred on, for a redraw in place. */
  private centre(): number {
    return this.parent.scrollTop;
  }

  private schedule(): void {
    if (this.frame !== 0 || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(this.parent.scrollTop);
    });
  }

  /** Build the pages in the window, and take out the ones that left. */
  private draw(top: number): void {
    if (this.destroyed) return;
    const view = this.parent.clientHeight || 800;
    const from = this.heights.indexAt(Math.max(0, top - MARGIN));
    const to = this.heights.indexAt(top + view + MARGIN);
    for (const page of [...this.live.keys()]) {
      if (page - 1 < from || page - 1 > to) this.retire(page);
    }
    for (let at = from; at <= to; at++) void this.show(at + 1);
    const place = this.place();
    if (place.page !== this.page) {
      this.page = place.page;
    }
    this.onPlace?.(place);
  }

  /** Put one page in the page, drawing it if it is not already there. */
  private async show(page: number): Promise<void> {
    const at = page - 1;
    let held = this.live.get(page);
    if (!held) {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(page);
      const canvas = document.createElement('canvas');
      const text = document.createElement('div');
      text.className = 'pdf-text';
      el.append(canvas, text);
      this.sheet.append(el);
      held = { el, canvas, text, drawing: null, drawn: 0, laid: false, spans: [], texts: [] };
      this.live.set(page, held);
    }
    // The size first: a page whose real size differs from page one's
    // moves everything under it, and the reader should not see that as
    // a jump after the pixels arrive.
    const size = await this.pdf.size(page);
    if (this.destroyed || this.live.get(page) !== held) return;
    const width = size.width * this.zoom;
    const height = size.height * this.zoom;
    this.heights.set(at, height + GAP);
    this.sheet.style.height = `${this.heights.total}px`;
    held.el.style.top = `${this.heights.upto(at)}px`;
    held.el.style.width = `${width}px`;
    held.el.style.height = `${height}px`;
    const ratio = globalThis.devicePixelRatio || 1;
    const scale = this.zoom * ratio;
    if (held.drawn !== scale) {
      held.drawing?.abort();
      const drawing = new AbortController();
      held.drawing = drawing;
      held.drawn = scale;
      held.canvas.style.width = `${width}px`;
      held.canvas.style.height = `${height}px`;
      try {
        await this.pdf.render(page, scale, held.canvas, drawing.signal);
      } catch (error) {
        // A page that will not draw is a blank page and not a broken
        // pane, so the rest of the document carries on — but the reader
        // is told, because white paper and a failed render look alike.
        held.drawn = 0;
        if (!this.toldOfTrouble && !drawing.signal.aborted) {
          this.toldOfTrouble = true;
          const said = error instanceof Error ? error.message : String(error);
          this.onTrouble?.(`Page ${page} would not draw · ${said}`);
        }
      }
      if (this.destroyed || this.live.get(page) !== held) return;
    }
    if (!held.laid) {
      held.laid = true;
      await this.layText(page, held);
    }
  }

  /**
   * The transparent text over a page, which is what makes selecting and
   * copying work.
   *
   * Each run is a span placed where the run is and scaled so its glyphs
   * cover the same width the drawn ones do. The scale has to be measured
   * rather than computed, because the face the browser lends the span is
   * not the face in the file.
   */
  private async layText(page: number, held: Live): Promise<void> {
    const runs = await this.pdf.text(page);
    if (this.destroyed || this.live.get(page) !== held) return;
    const spans: { el: HTMLElement; width: number }[] = [];
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      const [left, top, width, height] = run.rect;
      const el = document.createElement('span');
      el.textContent = run.text;
      el.style.left = `${left * this.zoom}px`;
      el.style.top = `${top * this.zoom}px`;
      el.style.fontSize = `${Math.max(1, height * this.zoom)}px`;
      fragment.append(el);
      spans.push({ el, width: width * this.zoom });
    }
    held.text.replaceChildren(fragment);
    held.spans = spans.map((span) => span.el);
    held.texts = runs.map((run) => run.text);
    // One read of the layout for the whole page, after one write.
    for (const { el, width } of spans) {
      const drawn = el.getBoundingClientRect().width;
      if (drawn > 0 && width > 0) el.style.transform = `scaleX(${width / drawn})`;
    }
    this.mark(page, held);
  }

  /**
   * What Find has found, for the pane to mark (ADR 0035).
   *
   * Kept by page rather than applied straight to the DOM, because most
   * of the hits are on pages that are not in the page: a page reaching
   * the window later is marked when its text layer is built.
   */
  setHits(hits: readonly PdfHit[], current: PdfHit | null): void {
    this.hits = new Map();
    for (const hit of hits) {
      const held = this.hits.get(hit.page);
      if (held) held.push(hit);
      else this.hits.set(hit.page, [hit]);
    }
    this.currentHit = current;
    for (const [page, live] of this.live) this.mark(page, live);
  }

  /**
   * Draw what Find found onto one page's text layer.
   *
   * The marks go *inside* the run rather than on it, because a run is
   * usually a whole line and the match is usually a word. Wrapping the
   * matched characters in a `<mark>` costs no layout — an inline element
   * with a background changes nothing about where the glyphs sit — so
   * the span's measured scale is still right and the mark lands exactly
   * over the letters it is about.
   */
  private mark(page: number, held: Live): void {
    if (!held.laid) return;
    // Every run a hit touches, with the character ranges to mark in it.
    const ranges = new Map<number, { head: number; tail: number; now: boolean }[]>();
    for (const hit of this.hits.get(page) ?? []) {
      const now =
        this.currentHit !== null &&
        this.currentHit.page === hit.page &&
        this.currentHit.from === hit.from &&
        this.currentHit.head === hit.head;
      for (let at = hit.from; at < hit.to; at++) {
        const text = held.texts[at];
        if (text === undefined) continue;
        const head = at === hit.from ? hit.head : 0;
        const tail = at === hit.to - 1 ? hit.tail : text.length;
        const into = ranges.get(at);
        if (into) into.push({ head, tail, now });
        else ranges.set(at, [{ head, tail, now }]);
      }
    }
    held.spans.forEach((span, at) => {
      const text = held.texts[at] ?? '';
      const marks = ranges.get(at);
      if (!marks) {
        // Only touch a span that is currently marked; the common case
        // during a search is that most of the page is not.
        if (span.firstElementChild) span.textContent = text;
        return;
      }
      marks.sort((a, b) => a.head - b.head);
      const parts: Node[] = [];
      let at2 = 0;
      for (const { head, tail, now } of marks) {
        const from = Math.max(at2, Math.min(head, text.length));
        const to = Math.max(from, Math.min(tail, text.length));
        if (from > at2) parts.push(document.createTextNode(text.slice(at2, from)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(from, to);
        if (now) mark.className = 'here';
        parts.push(mark);
        at2 = to;
      }
      if (at2 < text.length) parts.push(document.createTextNode(text.slice(at2)));
      span.replaceChildren(...parts);
    });
  }

  /** Put a hit in the window, with a little of the page above it. */
  goToHit(hit: PdfHit): void {
    const at = Math.max(0, Math.min(hit.page - 1, this.pdf.pages - 1));
    const rect = this.pdf.sizeOf(hit.page);
    const top = this.heights.upto(at);
    const run = this.live.get(hit.page)?.spans[hit.from];
    if (run && rect) {
      // The run's own offset inside the page, so a hit near the bottom
      // of a long page does not land above the window.
      const y = top + run.offsetTop - this.parent.clientHeight / 3;
      this.parent.scrollTop = Math.max(0, y);
    } else {
      this.parent.scrollTop = top;
    }
    this.draw(this.parent.scrollTop);
  }

  /** Take a page out of the page, and abandon whatever it was drawing. */
  private retire(page: number): void {
    const held = this.live.get(page);
    if (!held) return;
    held.drawing?.abort();
    // Zero the canvas as well as dropping it: a detached canvas holds
    // its backing store until the collector gets to it, and at four
    // times zoom that is a dozen megabytes a page.
    held.canvas.width = 0;
    held.canvas.height = 0;
    held.el.remove();
    this.live.delete(page);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.parent.removeEventListener('scroll', this.onScroll);
    this.resize?.disconnect();
    for (const page of [...this.live.keys()]) this.retire(page);
    this.sheet.remove();
  }
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** The next zoom up or down the ladder from where we are. */
export function stepZoom(zoom: number, delta: 1 | -1): number {
  const at = ZOOMS.findIndex((step) => step >= zoom - 0.001);
  const next =
    ZOOMS[Math.max(0, Math.min((at === -1 ? ZOOMS.length - 1 : at) + delta, ZOOMS.length - 1))];
  return next ?? zoom;
}
