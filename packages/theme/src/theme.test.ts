import { describe, expect, it } from 'vitest';
import { pageCss, themeCss } from './css.ts';
import { codeHighlight } from './highlight.ts';
import { tokenOfColor, tokenTheme } from './shiki.ts';
import {
  type Appearance,
  type CodeToken,
  codeTokens,
  DEFAULT_THEME,
  noteKinds,
  type Paper,
  paletteFor,
  paperIsDark,
  papers,
  type Theme,
  themeById,
  themes,
  tokenVariable,
} from './theme.ts';
import { lezerTags, scopes } from './tokens.ts';

const appearances: Appearance[] = ['light', 'dark'];

/** The relative luminance of a `#rrggbb`, as WCAG defines it. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe('every theme', () => {
  it('gives every token, paper and meaning a colour in both appearances', () => {
    for (const theme of themes) {
      for (const appearance of appearances) {
        const palette = paletteFor(theme, appearance);
        for (const token of codeTokens) {
          expect(palette.code[token], `${theme.id} ${appearance} ${token}`).toMatch(
            /^#[0-9a-f]{6}$/,
          );
        }
        for (const paper of papers) {
          expect(palette.papers[paper].bg).toMatch(/^#[0-9a-f]{6}$/);
          expect(palette.papers[paper].fg).toMatch(/^#[0-9a-f]{6}$/);
          expect(palette.papers[paper].code).toMatch(/^#[0-9a-f]{6}$/);
        }
        for (const kind of noteKinds) expect(palette.notes[kind]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('has an id and a name of its own, and the default is one of them', () => {
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
    expect(new Set(themes.map((theme) => theme.name)).size).toBe(themes.length);
    expect(themes.map((theme) => theme.id)).toContain(DEFAULT_THEME);
    expect(themeById(DEFAULT_THEME).id).toBe(DEFAULT_THEME);
    // A settings file can name a theme this build does not have, and a
    // window with no palette is worse than one in the wrong palette.
    expect(themeById('a theme from the future').id).toBe(DEFAULT_THEME);
    expect(themeById(null).id).toBe(DEFAULT_THEME);
  });

  /** Every theme answers for the same callout types, or a rule matches nothing. */
  it('names the same callout types as the others', () => {
    const first = Object.keys((themes[0] as Theme).light.callouts).sort();
    for (const theme of themes) {
      for (const appearance of appearances) {
        expect(Object.keys(paletteFor(theme, appearance).callouts).sort(), theme.id).toEqual(first);
      }
    }
  });
});

/**
 * What "curated" has to mean if four of them are offered (design 11).
 *
 * A theme is a set of colours somebody liked, which is exactly the sort
 * of thing that ships one unreadable combination out of thirty-two: four
 * themes, two appearances, four papers. These are the floors, in WCAG
 * contrast ratios, and they are per role rather than one number:
 *
 * - The page's ink on its paper is AAA body text. This is the app.
 * - Code in a fence is body text too, so AA; a comment is meant to be
 *   quieter and is allowed the large-text floor instead.
 * - The chrome's own text is AAA, its muted text and its accent AA.
 * - A callout's colour is a bold title and a four-pixel bar, so the
 *   large-text floor is the honest one.
 *
 * The five note colours are not in the list, and cannot be: they are
 * written into the file as literal hexes (design 4.3), so they belong to
 * the document rather than to the theme. `appearance.test.ts` pins them
 * to the annotation palette instead.
 */
describe('the contrast floor', () => {
  const INK = 7;
  const TOKEN = 4.5;
  const QUIET = 3;

  /** Which palette colours the page: the black paper is dark in a light window. */
  const pageSide = (appearance: Appearance, paper: Paper): Appearance =>
    paperIsDark(appearance, paper) ? 'dark' : 'light';

  for (const theme of themes) {
    for (const appearance of appearances) {
      it(`holds for ${theme.name} in ${appearance}`, () => {
        const { ui } = paletteFor(theme, appearance);
        expect(contrast(ui.fg, ui.bg), 'chrome text').toBeGreaterThanOrEqual(INK);
        expect(contrast(ui.muted, ui.bg), 'muted text').toBeGreaterThanOrEqual(TOKEN);
        expect(contrast(ui.accent, ui.bg), 'accent').toBeGreaterThanOrEqual(TOKEN);
        expect(contrast(ui.dirty, ui.bg), 'the unsaved dot').toBeGreaterThanOrEqual(QUIET);
        // The front of the window — the tab that is open and the bar
        // under it — is `active` rather than `bg` (plan WP 2.8), and the
        // same chrome text is drawn on it.
        expect(contrast(ui.fg, ui.active), 'chrome text in front').toBeGreaterThanOrEqual(INK);
        expect(contrast(ui.muted, ui.active), 'muted text in front').toBeGreaterThanOrEqual(TOKEN);
        expect(contrast(ui.accent, ui.active), 'accent in front').toBeGreaterThanOrEqual(TOKEN);
        expect(contrast(ui.dirty, ui.active), 'the unsaved dot in front').toBeGreaterThanOrEqual(
          QUIET,
        );

        for (const paper of papers) {
          const page = paletteFor(theme, appearance).papers[paper];
          const side = paletteFor(theme, pageSide(appearance, paper));
          const where = `${paper} paper`;
          expect(contrast(page.fg, page.bg), `${where}: ink`).toBeGreaterThanOrEqual(INK);
          for (const token of codeTokens) {
            const floor = token === 'comment' ? QUIET : TOKEN;
            expect(
              contrast(side.code[token], page.code),
              `${where}: ${token}`,
            ).toBeGreaterThanOrEqual(floor);
          }
          for (const [type, color] of Object.entries(side.callouts)) {
            expect(contrast(color, page.bg), `${where}: ${type}`).toBeGreaterThanOrEqual(QUIET);
          }
        }
      });
    }
  }
});

describe('the two highlighters', () => {
  it('describes every token to both of them', () => {
    const named = codeTokens.filter((token) => token !== 'foreground');
    expect(Object.keys(scopes).sort()).toEqual([...named].sort());
    expect(Object.keys(lezerTags).sort()).toEqual([...named].sort());
  });

  // A scope in two lists is a colour that depends on which rule Shiki
  // happens to try first, which is the one thing this file must not have.
  it('claims no scope twice', () => {
    const seen = new Set<string>();
    for (const list of Object.values(scopes)) {
      for (const scope of list) {
        expect(seen.has(scope), `${scope} is claimed twice`).toBe(false);
        seen.add(scope);
      }
    }
  });

  it('claims no lezer tag twice', () => {
    const seen = new Set<unknown>();
    for (const list of Object.values(lezerTags)) {
      for (const tag of list) {
        expect(seen.has(tag)).toBe(false);
        seen.add(tag);
      }
    }
  });

  /**
   * Neither of them holds a colour: one writes token names onto the
   * page, the other reads the variables those names are coloured by
   * (plan WP 2.6). That is what makes a fence look the same in Read mode
   * as its source does in Source mode, in every theme rather than in the
   * one they were both compiled against.
   */
  it('reaches the palette by name rather than by colour', () => {
    const shiki = tokenTheme();
    expect(tokenOfColor(shiki.fg)).toBe('foreground');
    const named = shiki.settings.map((rule) => tokenOfColor(rule.settings.foreground));
    expect(named).toEqual(Object.keys(scopes));
    expect(new Set(named).size).toBe(named.length);
    expect(tokenOfColor('#ff00ff')).toBeNull();
    expect(tokenOfColor(undefined)).toBeNull();

    const cm = codeHighlight();
    expect(cm.map((rule) => rule.color)).toEqual(
      Object.keys(lezerTags).map((token) => `var(${tokenVariable(token as CodeToken)})`),
    );
  });

  /** The one paper that is dark whichever way the window is (design 11). */
  it('reads the black paper as dark in a light window', () => {
    expect(paperIsDark('light', 'black')).toBe(true);
    expect(paperIsDark('light', 'cream')).toBe(false);
    expect(paperIsDark('dark', 'white')).toBe(true);
  });
});

describe('the generated stylesheet', () => {
  it('is what the JSON says', async () => {
    await expect(themeCss(themes)).toMatchFileSnapshot('./theme.css');
  });
});

/**
 * What an exported page wears (plan WP 3.2). The window picks a theme
 * with three attributes a script writes; a page with no script gets the
 * same variables with the choice already made, and these are the ways
 * the two can be said to agree.
 */
describe('one theme, resolved', () => {
  const one = themeById('one');

  it('needs no attribute to say which theme it is', () => {
    const css = pageCss(one, 'light', 'white');
    expect(css).toContain(':root {');
    expect(css).not.toContain('[data-theme=');
    expect(css).not.toContain('@media');
  });

  it('says what the generated stylesheet would have selected', () => {
    for (const appearance of ['light', 'dark'] as const) {
      for (const paper of papers) {
        const resolved = pageCss(themeById('grove'), appearance, paper);
        const palette = paletteFor(themeById('grove'), appearance);
        const page = paletteFor(
          themeById('grove'),
          paperIsDark(appearance, paper) ? 'dark' : 'light',
        );
        expect(resolved).toContain(`color-scheme: ${appearance};`);
        // The paper follows the window; the ink on it follows the paper.
        expect(resolved).toContain(`--page-bg: ${palette.papers[paper].bg};`);
        expect(resolved).toContain(`--tok-keyword: ${page.code.keyword};`);
      }
    }
  });

  it('carries the rules that are not variables, so a fence is coloured', () => {
    const css = pageCss(one, 'dark', 'white');
    expect(css).toContain('.mdr-code .tok-keyword {');
    expect(css).toContain('[data-callout="warning"] {');
    expect(css).toContain('--mdr-note: var(--note-rewrite);');
  });
});
