import type { ThemeId } from '@mdreader/ipc';
import { calloutTypes, palette } from '@mdreader/markdown';
import { codeTokens, noteKinds, paletteFor, papers, themes } from '@mdreader/theme';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SIZE,
  MEASURE_RANGE,
  overrideOf,
  pageIsDark,
  type Reading,
  readingSettings,
  resolveAppearance,
  SIZES,
  withOverride,
  zoomed,
} from './appearance.ts';

describe('the reading settings', () => {
  it('fills in what a settings file left out', () => {
    expect(readingSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readingSettings({ paper: 'cream' })).toEqual({ ...DEFAULT_SETTINGS, paper: 'cream' });
  });

  // The file can be edited by hand, and a size of zero is a window
  // nobody can read their way out of.
  it('puts a size that is not on the scale back on it', () => {
    expect(readingSettings({ size: 19 }).size).toBe(18);
    expect(readingSettings({ size: 0 }).size).toBe(SIZES[0]);
    expect(readingSettings({ size: 999 }).size).toBe(SIZES.at(-1));
    expect(readingSettings({ measure: 4000 }).measure).toBe(MEASURE_RANGE.max);
    expect(readingSettings({ measure: 1 }).measure).toBe(MEASURE_RANGE.min);
  });

  it('asks the system only when the setting says to', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('light', true)).toBe('light');
    expect(resolveAppearance('dark', false)).toBe('dark');
  });

  /** Design 11's high-contrast paper, which a light window does not undo. */
  it('reads the black paper as a dark page in a light window', () => {
    expect(pageIsDark({ ...DEFAULT_SETTINGS, paper: 'black' }, false)).toBe(true);
    expect(pageIsDark({ ...DEFAULT_SETTINGS, paper: 'cream' }, false)).toBe(false);
    expect(pageIsDark({ ...DEFAULT_SETTINGS, paper: 'cream' }, true)).toBe(true);
    expect(pageIsDark({ ...DEFAULT_SETTINGS, appearance: 'light' }, true)).toBe(false);
  });

  it('steps along the scale and stops at the ends', () => {
    expect(zoomed(DEFAULT_SIZE, 1)).toBe(17);
    expect(zoomed(DEFAULT_SIZE, -1)).toBe(15);
    expect(zoomed(SIZES[0] as number, -1)).toBe(SIZES[0]);
    expect(zoomed(SIZES.at(-1) as number, 1)).toBe(SIZES.at(-1));
    expect(zoomed(19, 0)).toBe(18);
  });
});

/**
 * The themes are files in another package, and these are the places they
 * have to agree with this one.
 */
describe('the themes against the rest of the app', () => {
  it('offers exactly the themes the settings can name', () => {
    // The value space is Rust's, because the settings file is Rust's;
    // the colours are the theme package's. A theme in one and not the
    // other is a setting that dresses nothing, or a palette nothing can
    // choose.
    const named: ThemeId[] = ['one', 'slate', 'ink', 'grove'];
    expect(themes.map((theme) => theme.id)).toEqual(named);
    expect(DEFAULT_SETTINGS.theme).toBe('one');
  });

  it('has a colour for every callout type the renderer can produce', () => {
    for (const theme of themes) {
      for (const appearance of ['light', 'dark'] as const) {
        const { callouts } = paletteFor(theme, appearance);
        for (const type of calloutTypes) {
          expect(callouts[type], `${theme.id} ${type} in ${appearance}`).toMatch(/^#[0-9a-f]{6}$/);
        }
        // And no colour for a type the renderer will never emit, which
        // would be a rule nothing can match.
        expect(Object.keys(callouts).sort()).toEqual([...calloutTypes].sort());
      }
    }
  });

  /**
   * A colour from the palette is written into the file as a literal hex
   * (design 4.3). The chip the reader sees in a light window has to be
   * that colour, or the app is showing one thing and saving another —
   * and that is true of every theme, because the colour belongs to the
   * document rather than to the theme.
   */
  it('colours a note chip the colour the file carries, in every theme', () => {
    for (const theme of themes) {
      const light = paletteFor(theme, 'light');
      for (const entry of palette) {
        expect(light.notes[entry.meaning], `${theme.id} ${entry.meaning}`).toBe(entry.color);
      }
    }
  });

  it('names every meaning, paper and token the app asks for', () => {
    expect([...noteKinds].sort()).toEqual(['note', ...palette.map((e) => e.meaning)].sort());
    expect([...papers]).toEqual(['white', 'cream', 'pad', 'black']);
    expect(codeTokens).toContain('foreground');
  });
});

/** Design 11: one report in a serif, without every other document following. */
describe('a document read in its own settings', () => {
  it('changes only what it says, and leaves the rest to the app', () => {
    const app: Reading = { ...DEFAULT_SETTINGS, family: 'sans', size: 16, measure: 68 };
    const mine = withOverride(app, { family: 'serif', measure: 84 });
    expect(mine.family).toBe('serif');
    expect(mine.measure).toBe(84);
    expect(mine.size).toBe(16);
    // The chrome is the window's, and is never a document's to change.
    expect(mine.theme).toBe(app.theme);
    expect(mine.appearance).toBe(app.appearance);
  });

  it('takes a null for a field it does not speak to', () => {
    const app: Reading = { ...DEFAULT_SETTINGS, family: 'sans' };
    expect(withOverride(app, { family: null, size: 22 })).toEqual({ ...app, size: 22 });
    expect(withOverride(app, null)).toEqual(app);
    expect(withOverride(app, {})).toEqual(app);
  });

  it('puts its numbers back on the scale, as the settings do', () => {
    const mine = withOverride(DEFAULT_SETTINGS, { size: 19, measure: 4000 });
    expect(mine.size).toBe(18);
    expect(mine.measure).toBe(MEASURE_RANGE.max);
  });

  /**
   * Rust answers for a path it was never told about with every field
   * empty, and that is the same thing as no override at all.
   */
  it('is nothing at all when it says nothing at all', () => {
    expect(overrideOf(null)).toBeNull();
    expect(overrideOf({})).toBeNull();
    expect(overrideOf({ paper: null, family: null, size: null, measure: null })).toBeNull();
    expect(overrideOf({ size: 22 })).toEqual({ size: 22 });
  });
});
