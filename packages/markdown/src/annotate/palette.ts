/**
 * The colour palette with meanings, from design 4.3.
 *
 * A colour alone says nothing to a model, so every colour here stands for
 * one of the comment vocabulary's words and picking it pre-fills a comment
 * with that word. The five are the palette; `note` is the sixth comment
 * kind and has no colour, because a plain remark is not about the look of
 * the text it follows.
 */

export const paletteMeanings = ['attention', 'question', 'remove', 'keep', 'rewrite'] as const;

export type PaletteMeaning = (typeof paletteMeanings)[number];

export interface PaletteEntry {
  meaning: PaletteMeaning;
  /** What the toolbar calls it, and what Copy for AI writes. */
  title: string;
  /**
   * The colour written into the file. Mid-tones on purpose: the file
   * carries a literal hex to whoever opens it next, and the same value
   * has to stay legible on a white page and on a dark one.
   */
  color: string;
}

export const palette: readonly PaletteEntry[] = [
  { meaning: 'attention', title: 'Attention', color: '#d97706' },
  { meaning: 'question', title: 'Question', color: '#8b5cf6' },
  { meaning: 'remove', title: 'Remove', color: '#dc2626' },
  { meaning: 'keep', title: 'Keep', color: '#16a34a' },
  { meaning: 'rewrite', title: 'Rewrite', color: '#0ea5e9' },
];

const byMeaning = new Map(palette.map((entry) => [entry.meaning, entry]));
const byColor = new Map(palette.map((entry) => [entry.color.toLowerCase(), entry]));

export function paletteEntry(meaning: PaletteMeaning): PaletteEntry {
  return byMeaning.get(meaning) as PaletteEntry;
}

/** Expand `#abc` so a short form written by hand still matches the palette. */
function expandHex(color: string): string {
  const m = /^#([\da-f])([\da-f])([\da-f])$/i.exec(color.trim());
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : color.trim();
}

/**
 * The meaning a colour stands for, or null when it is a colour the reader
 * wrote themselves. An unrecognised colour is still an annotation — the
 * file says something is coloured — it just carries no palette word.
 */
export function meaningOfColor(color: string): PaletteMeaning | null {
  return byColor.get(expandHex(color).toLowerCase())?.meaning ?? null;
}

/** The `style` attribute a colour is written with, matching what the whitelist normalises to. */
export function colorStyle(color: string): string {
  return `color:${color}`;
}
