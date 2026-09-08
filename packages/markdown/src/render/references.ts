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
const FENCE = /^ {0,3}(?:```|~~~)/;

/**
 * Every `[label]: url "title"` definition in the source. Lines inside a
 * fenced code block are skipped, which is where a line that only looks
 * like a definition is most likely to appear.
 */
export function referenceDefinitions(source: string): Map<string, Reference> {
  const found = new Map<string, Reference>();
  let fence: string | null = null;
  for (const line of source.split('\n')) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (FENCE.test(line)) {
      fence = line.trimStart().slice(0, 3);
      continue;
    }
    const m = DEFINITION.exec(line);
    if (!m) continue;
    const label = normalizeLabel(m[1] ?? '');
    // The first definition of a label wins, as CommonMark says.
    if (label === '' || found.has(label)) continue;
    found.set(label, {
      url: m[2] ?? m[3] ?? '',
      title: m[4] ?? m[5] ?? m[6] ?? null,
    });
  }
  return found;
}
