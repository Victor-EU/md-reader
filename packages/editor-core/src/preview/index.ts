import type { Extension } from '@codemirror/state';
import { previewPlugin } from './plugin.ts';
import { previewTheme } from './theme.ts';

export { buildDecorations, type PreviewDecorations, type VisibleRange } from './build.ts';
export { type RevealRange, revealRanges } from './reveal.ts';
export { markdownHighlightStyle, previewTheme } from './theme.ts';
export { toggleTaskAt } from './widgets.ts';

/** Live preview: decorations over the source, with the reveal rule. */
export function livePreview(): Extension {
  return [previewPlugin, previewTheme];
}
