import type { Override, Settings } from '@mdreader/ipc';
import {
  type Appearance,
  DEFAULT_THEME,
  type Family,
  type Paper,
  paperIsDark,
  type Theme,
  themes,
} from '@mdreader/theme';

/**
 * The reading preferences, applied (design 11, plan WP 1.9, plan WP 2.6).
 *
 * The palette itself is a stylesheet with all four themes generated into
 * it, so everything here is choosing between blocks that already exist:
 * three attributes on the root element for the theme, the appearance and
 * the paper, and three custom properties for the family, the size and
 * the measure. Nothing recomputes a colour at runtime, and nothing is
 * re-rendered when one of them changes.
 */

/**
 * The sizes Cmd+= and Cmd+- step through, mirroring `SIZES` in
 * `crates/core/src/state.rs`. Rust puts a value that is not on the scale
 * back on it, so a drift between the two costs a rounding, not a bug.
 */
export const SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28];
export const DEFAULT_SIZE = 16;
export const MEASURE_RANGE = { min: 45, max: 110 };
export const DEFAULT_MEASURE = 68;

/** Every preference with a value, which is what the window works from. */
export type Reading = Required<Settings>;

export const DEFAULT_SETTINGS: Reading = {
  autosave: true,
  theme: DEFAULT_THEME,
  appearance: 'system',
  paper: 'white',
  family: 'sans',
  size: DEFAULT_SIZE,
  measure: DEFAULT_MEASURE,
};

/**
 * The themes, with their ids narrowed to what a settings file may hold.
 *
 * The colours are the theme package's and the value space is Rust's, and
 * this is the one place the two are said to be the same list;
 * `appearance.test.ts` is what checks that they are.
 */
export const THEMES: readonly { id: Reading['theme']; theme: Theme }[] = themes.map((theme) => ({
  id: theme.id as Reading['theme'],
  theme,
}));

function clampSize(size: number): number {
  return SIZES.reduce(
    (best, step) => (Math.abs(step - size) < Math.abs(best - size) ? step : best),
    DEFAULT_SIZE,
  );
}

/**
 * Fill in what a settings file left out and put the numbers back on the
 * scale. A file written by an older build has fields missing; one edited
 * by hand can say anything at all.
 */
export function readingSettings(settings: Settings | null | undefined): Reading {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    size: clampSize(merged.size),
    measure: Math.min(Math.max(Math.round(merged.measure), MEASURE_RANGE.min), MEASURE_RANGE.max),
  };
}

/** `system` answered by the OS, which is what the palette needs to know. */
export function resolveAppearance(
  setting: Settings['appearance'],
  systemDark: boolean,
): Appearance {
  if (setting === 'light' || setting === 'dark') return setting;
  return systemDark ? 'dark' : 'light';
}

/** One step along the scale. Cmd+= goes up, Cmd+- goes down (design 4.5). */
export function zoomed(size: number, steps: number): number {
  const at = SIZES.indexOf(clampSize(size));
  const next = Math.min(Math.max(at + steps, 0), SIZES.length - 1);
  return SIZES[next] ?? DEFAULT_SIZE;
}

export function canZoom(size: number, steps: number): boolean {
  return zoomed(size, steps) !== clampSize(size);
}

/**
 * An override, or null when it says nothing at all.
 *
 * Rust answers for a path it has never been told about with every field
 * empty, which is the same thing as no override; this is the one place
 * that distinction is made, so nothing else has to make it.
 */
export function overrideOf(over: Override | null | undefined): Override | null {
  if (!over) return null;
  const said =
    over.paper != null || over.family != null || over.size != null || over.measure != null;
  return said ? over : null;
}

/**
 * The app's settings with one document's own on top of them (design 11).
 *
 * An override says only what it changes, so a null or a missing field is
 * not a value: it is the document following the app, which is what makes
 * changing the app's size move every document that was never given one.
 */
export function withOverride(settings: Reading, over: Override | null | undefined): Reading {
  if (!over) return settings;
  return readingSettings({
    ...settings,
    ...(over.paper == null ? {} : { paper: over.paper }),
    ...(over.family == null ? {} : { family: over.family }),
    ...(over.size == null ? {} : { size: over.size }),
    ...(over.measure == null ? {} : { measure: over.measure }),
  });
}

/** Whether the page the reader is looking at is a dark one. */
export function pageIsDark(settings: Reading, systemDark: boolean): boolean {
  return paperIsDark(resolveAppearance(settings.appearance, systemDark), settings.paper as Paper);
}

const FAMILIES: Record<Family, string> = {
  sans: 'var(--family-sans)',
  serif: 'var(--family-serif)',
  mono: 'var(--family-mono)',
};

/**
 * Dress the window. `data-theme` picks the palette, `data-appearance` the
 * chrome and `data-paper` the page; between them the generated stylesheet
 * already knows every colour, so this only ever writes six values.
 */
export function applyAppearance(root: HTMLElement, settings: Reading, systemDark: boolean): void {
  root.dataset.theme = settings.theme;
  root.dataset.appearance = resolveAppearance(settings.appearance, systemDark);
  root.dataset.paper = settings.paper as Paper;
  root.style.setProperty('--read-family', FAMILIES[settings.family as Family]);
  root.style.setProperty('--read-size', `${settings.size}px`);
  root.style.setProperty('--read-measure', `${settings.measure}ch`);
}
