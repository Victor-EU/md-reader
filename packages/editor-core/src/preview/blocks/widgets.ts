import { WidgetType } from '@codemirror/view';
import type { PreviewOptions } from './options.ts';

/**
 * The block widgets of design 7.1 that only display: math, Mermaid, and an
 * image on a line of its own. Each replaces its source lines while the
 * selection is elsewhere, and the reveal rule gives the source back the
 * moment the cursor touches the block.
 *
 * `ignoreEvent` is false on all three: a click has to reach CodeMirror so
 * it can put the cursor in the block, which is how a reader gets from
 * looking at a formula to editing it.
 */

/** `$$ … $$` as the formula it describes, or as its source until KaTeX arrives. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    private readonly options: PreviewOptions,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex;
  }

  override ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdr-math-block';
    el.dataset.tex = this.tex;
    el.textContent = this.tex;
    this.options.enhance?.run([el]);
    return el;
  }
}

/**
 * The one fence that is a widget (design 7.1): a `mermaid` block shows its
 * diagram while the cursor is outside it. Every other fence stays editable
 * text with its language highlighted.
 */
export class DiagramWidget extends WidgetType {
  constructor(
    readonly source: string,
    private readonly options: PreviewOptions,
  ) {
    super();
  }

  override eq(other: DiagramWidget): boolean {
    return other.source === this.source;
  }

  override ignoreEvent(): boolean {
    return false;
  }

  override get estimatedHeight(): number {
    return 160;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdr-mermaid';
    el.textContent = this.source;
    this.options.enhance?.run([el]);
    return el;
  }
}

/** An image on a line of its own, loaded if design 8's rules allow it. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title: string,
    private readonly options: PreviewOptions,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.title === this.title;
  }

  override ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const target = this.options.image?.(this.src) ?? { url: null, blocked: 'unavailable' as const };
    if (target.url === null) {
      const span = document.createElement('span');
      span.className = 'mdr-image';
      span.dataset.src = this.src;
      if (target.blocked) span.dataset.blocked = target.blocked;
      span.textContent = this.alt === '' ? this.src : this.alt;
      return span;
    }
    const img = document.createElement('img');
    img.className = 'mdr-image-widget';
    img.src = target.url;
    img.alt = this.alt;
    if (this.title !== '') img.title = this.title;
    return img;
  }
}
