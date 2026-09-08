import { Facet } from '@codemirror/state';
import type { ImageResolver } from '@mdreader/markdown';

/**
 * Anything a block widget needs that the editor cannot supply itself.
 *
 * Live preview renders math and diagrams into elements carrying the same
 * class names the Read renderer emits, and hands them to the same
 * enhancer the app already gives Read mode. One implementation of KaTeX
 * and Mermaid serves both views, and `editor-core` keeps no dependency on
 * either (design 6.2).
 */
export interface PreviewOptions {
  /** Renders `.mdr-math-block` and `.mdr-mermaid` elements in place. */
  enhance?: { run(roots: readonly HTMLElement[]): void };
  /** Turns an image source into a URL the view may load (design 8). */
  image?: ImageResolver;
}

const empty: PreviewOptions = {};

export const previewOptions = Facet.define<PreviewOptions, PreviewOptions>({
  combine: (values) => (values.length === 0 ? empty : Object.assign({}, ...values)),
});
