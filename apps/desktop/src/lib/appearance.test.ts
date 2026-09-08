import { calloutTypes, palette } from '@mdreader/markdown';
import { codeTokens, noteKinds, paletteFor, papers, themeOne } from '@mdreader/theme';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SIZE,
  MEASURE_RANGE,
  pageIsDark,
  readingSettings,
  resolveAppearance,
  SIZES,
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
 * Theme one is a file in another package, and these are the places it
 * has to agree with this one.
 */
describe('theme one against the rest of the app', () => {
  it('has a colour for every callout type the renderer can produce', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const { callouts } = paletteFor(themeOne, appearance);
      for (const type of calloutTypes) {
        expect(callouts[type], `${type} in ${appearance}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      // And no colour for a type the renderer will never emit, which
      // would be a rule nothing can match.
      expect(Object.keys(callouts).sort()).toEqual([...calloutTypes].sort());
    }
  });

  /**
   * A colour from the palette is written into the file as a literal hex
   * (design 4.3). The chip the reader sees in a light window has to be
   * that colour, or the app is showing one thing and saving another.
   */
  it('colours a note chip the colour the file carries', () => {
    const light = paletteFor(themeOne, 'light');
    for (const entry of palette) {
      expect(light.notes[entry.meaning], entry.meaning).toBe(entry.color);
    }
  });

  it('names every meaning, paper and token the app asks for', () => {
    expect([...noteKinds].sort()).toEqual(['note', ...palette.map((e) => e.meaning)].sort());
    expect([...papers]).toEqual(['white', 'cream', 'pad', 'black']);
    expect(codeTokens).toContain('foreground');
  });
});
