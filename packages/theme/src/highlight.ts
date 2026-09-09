import type { Tag } from '@lezer/highlight';
import { type CodeToken, tokenVariable } from './theme.ts';
import { lezerTags } from './tokens.ts';

/**
 * The code tokens as CodeMirror sees them: what `HighlightStyle.define`
 * takes.
 *
 * Structural typing again — `TagStyle` lives in `@codemirror/language`,
 * and a palette should not have to depend on an editor to say that a
 * keyword is plum.
 */
export interface TagColor {
  tag: readonly Tag[];
  color: string;
}

/**
 * One style, for every theme (plan WP 2.6).
 *
 * The colours are the page's own variables rather than a theme's hexes,
 * which is what lets a window change theme, appearance or paper without
 * reconfiguring a single editor. Read mode's fences name the same
 * tokens, so the two highlighters cannot drift apart: they are reading
 * the same sixteen variables.
 */
export function codeHighlight(): TagColor[] {
  return Object.entries(lezerTags).map(([token, tag]) => ({
    tag,
    color: `var(${tokenVariable(token as CodeToken)})`,
  }));
}
