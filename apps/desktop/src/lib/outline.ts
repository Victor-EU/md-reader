import type { OutlineEntry } from '@markdown/markdown';
import type { PdfOutlineEntry } from './pdf/engine.ts';

/**
 * What the sidebar's Outline panel draws, whatever it is drawing from
 * (ADR 0035).
 *
 * A PDF has bookmarks and they are the same idea as headings — a level,
 * a label, and somewhere to go. Where they differ is the last part.
 * `OutlineEntry` carries `from` and `to` as *source offsets*, which a
 * PDF does not have; a PDF's destination is a page number, which a
 * markdown document does not have. Overloading `from` as a page would
 * work and would be the kind of shortcut that is still being explained
 * two years later.
 *
 * So the destination is a discriminated union, and it is drawn at the
 * panel's boundary rather than pushed down into either side. The panel
 * renders a level and a label and hands the destination back; the
 * workspace is the one place that knows what each kind means.
 */
export type OutlineTarget =
  | { kind: 'offset'; id: string; from: number }
  | { kind: 'page'; page: number };

export interface OutlineRow {
  level: number;
  text: string;
  target: OutlineTarget;
}

export function headingRow(entry: OutlineEntry): OutlineRow {
  return {
    level: entry.level,
    text: entry.text,
    target: { kind: 'offset', id: entry.id, from: entry.from },
  };
}

export function bookmarkRow(entry: PdfOutlineEntry): OutlineRow {
  return { level: entry.level, text: entry.text, target: { kind: 'page', page: entry.page } };
}
