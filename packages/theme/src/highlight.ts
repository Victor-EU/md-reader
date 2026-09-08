import type { Tag } from '@lezer/highlight';
import { type Appearance, type CodeToken, paletteFor, type Theme } from './theme.ts';
import { lezerTags } from './tokens.ts';

/**
 * Theme one as CodeMirror sees it: what `HighlightStyle.define` takes.
 *
 * Structural typing again — `TagStyle` lives in `@codemirror/language`,
 * and a palette should not have to depend on an editor to say that a
 * keyword is plum.
 */
export interface TagColor {
  tag: readonly Tag[];
  color: string;
}

export function codeHighlight(theme: Theme, appearance: Appearance): TagColor[] {
  const code = paletteFor(theme, appearance).code;
  return Object.entries(lezerTags).map(([token, tag]) => ({
    tag,
    color: code[token as CodeToken],
  }));
}
