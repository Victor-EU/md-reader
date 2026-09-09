import { type CodeToken, codeTokens } from './theme.ts';
import { scopes } from './tokens.ts';

/**
 * The theme Shiki is registered with (design 11, plan WP 2.6).
 *
 * It is not a palette. Shiki's job here is to say which of the sixteen
 * token names a run of characters is, and a TextMate theme is the only
 * way to ask it: colour is the answer it has. So every token is given a
 * colour that stands for nothing but itself, and the render turns that
 * colour back into the token's name and writes the name on the span.
 *
 * What follows from that is the whole point. A fence carries token
 * names, so the theme, the appearance and the paper are all just
 * variables the page resolves; changing any of them repaints every
 * fence already on screen without re-tokenizing a line.
 *
 * Typed structurally rather than against `ThemeRegistrationRaw`, so this
 * package does not depend on Shiki to describe two dozen colours. What
 * Shiki wants is exactly this shape.
 */
export interface TextMateTheme {
  name: string;
  type: 'light';
  fg: string;
  bg: string;
  settings: { scope: string[]; settings: { foreground: string } }[];
}

/** The registered name, which is what `codeToTokens` is asked for. */
export const tokenThemeName = 'mdr-tokens';

/**
 * The stand-in colour for a token: its position in `codeTokens`, written
 * as a colour. Distinct by construction, and far enough from anything a
 * grammar or a fallback would produce to be unmistakable.
 */
function sentinel(token: CodeToken): string {
  const at = codeTokens.indexOf(token) + 1;
  return `#0000${at.toString(16).padStart(2, '0')}`;
}

const byColor = new Map(codeTokens.map((token) => [sentinel(token), token]));

export function tokenTheme(): TextMateTheme {
  return {
    name: tokenThemeName,
    type: 'light',
    fg: sentinel('foreground'),
    // Nothing reads this: the fence's ground is the paper's, from the
    // stylesheet. It has to be a colour, so it is white.
    bg: '#ffffff',
    settings: Object.entries(scopes).map(([token, scope]) => ({
      scope,
      settings: { foreground: sentinel(token as CodeToken) },
    })),
  };
}

/**
 * The token a highlighted run stands for. Anything else — a colour from
 * a theme that is not this one — is `null`, and the run is left as the
 * page's own code colour rather than painted a colour nobody chose.
 */
export function tokenOfColor(color: string | undefined): CodeToken | null {
  return color === undefined ? null : (byColor.get(color.toLowerCase()) ?? null);
}
