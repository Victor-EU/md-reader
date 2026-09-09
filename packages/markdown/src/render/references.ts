/**
 * Link reference definitions, scanned from the source rather than read out
 * of the tree.
 *
 * Read mode renders a long document in chunks, and a chunk must not depend
 * on how much of the document has been parsed: `[text][ref]` has to render
 * as a link whether its definition is above or below the chunk. Scanning
 * the whole source once gives every chunk the same answer as a whole
 * document render, which is the property the golden tests rely on.
 */

import { linesOutsideCode } from './scan.ts';

export interface Reference {
  url: string;
  title: string | null;
}

/** A label as CommonMark matches it: trimmed, inner whitespace collapsed, case folded. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

const DEFINITION =
  /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[ \t]*(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))?[ \t]*$/;

/** The definition one line makes, if it makes one. */
export function referenceOn(line: string): { label: string; target: Reference } | null {
  const m = DEFINITION.exec(line);
  if (!m) return null;
  // `[^1]: url` is a footnote, not a link reference; see `footnotes.ts`.
  const raw = m[1] ?? '';
  if (raw.startsWith('^')) return null;
  const label = normalizeLabel(raw);
  if (label === '') return null;
  return {
    label,
    target: { url: m[2] ?? m[3] ?? '', title: m[4] ?? m[5] ?? m[6] ?? null },
  };
}

/**
 * Every `[label]: url "title"` definition in the source. Lines inside a
 * fenced code block are skipped, which is where a line that only looks
 * like a definition is most likely to appear.
 *
 * One of the three whole-file scans; `scanSource` does all three in one
 * walk, which is what anything reading a large file should use.
 */
export function referenceDefinitions(source: string): Map<string, Reference> {
  const found = new Map<string, Reference>();
  for (const line of linesOutsideCode(source)) {
    const made = referenceOn(line);
    // The first definition of a label wins, as CommonMark says.
    if (made !== null && !found.has(made.label)) found.set(made.label, made.target);
  }
  return found;
}
