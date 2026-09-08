import { type Appearance, type CodeToken, paletteFor, type Theme } from './theme.ts';
import { scopes } from './tokens.ts';

/**
 * Theme one as Shiki sees it (design 11, plan WP 1.9).
 *
 * Typed structurally rather than against `ThemeRegistrationRaw`, so this
 * package does not depend on Shiki to describe two dozen colours. What
 * Shiki wants is exactly this shape.
 */
export interface TextMateTheme {
  name: string;
  type: Appearance;
  fg: string;
  bg: string;
  settings: { scope: string[]; settings: { foreground: string } }[];
}

/** The registered name, which is what `codeToHtml` is asked for. */
export function shikiThemeName(theme: Theme, appearance: Appearance): string {
  return `mdr-${theme.id}-${appearance}`;
}

export function shikiTheme(theme: Theme, appearance: Appearance): TextMateTheme {
  const palette = paletteFor(theme, appearance);
  const code = palette.code;
  return {
    name: shikiThemeName(theme, appearance),
    type: appearance,
    fg: code.foreground,
    // The block takes the page's own code background from the stylesheet,
    // so this only has to be something of the right shade for anything
    // that reads the theme rather than the element.
    bg: palette.papers.white.code,
    settings: Object.entries(scopes).map(([token, scope]) => ({
      scope,
      settings: { foreground: code[token as CodeToken] },
    })),
  };
}
