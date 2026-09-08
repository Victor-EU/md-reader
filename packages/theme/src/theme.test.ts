import { describe, expect, it } from 'vitest';
import { themeCss } from './css.ts';
import { codeHighlight } from './highlight.ts';
import { shikiTheme } from './shiki.ts';
import {
  type Appearance,
  codeTokens,
  noteKinds,
  paletteFor,
  paperIsDark,
  papers,
  themeOne,
} from './theme.ts';
import { lezerTags, scopes } from './tokens.ts';

const appearances: Appearance[] = ['light', 'dark'];

describe('theme one', () => {
  it('gives every token, paper and meaning a colour in both appearances', () => {
    for (const appearance of appearances) {
      const palette = paletteFor(themeOne, appearance);
      for (const token of codeTokens) expect(palette.code[token]).toMatch(/^#[0-9a-f]{6}$/);
      for (const paper of papers) {
        expect(palette.papers[paper].bg).toMatch(/^#[0-9a-f]{6}$/);
        expect(palette.papers[paper].fg).toMatch(/^#[0-9a-f]{6}$/);
      }
      for (const kind of noteKinds) expect(palette.notes[kind]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('describes every token to both highlighters', () => {
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

  it('hands both highlighters the same colour for the same token', () => {
    for (const appearance of appearances) {
      const code = paletteFor(themeOne, appearance).code;
      const shiki = shikiTheme(themeOne, appearance);
      const cm = codeHighlight(themeOne, appearance);
      expect(shiki.fg).toBe(code.foreground);
      const shikiColors = shiki.settings.map((rule) => rule.settings.foreground).sort();
      const cmColors = cm.map((rule) => rule.color).sort();
      expect(shikiColors).toEqual(cmColors);
    }
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
    await expect(themeCss(themeOne)).toMatchFileSnapshot('./theme.css');
  });
});
