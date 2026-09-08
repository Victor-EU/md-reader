import { normalizeLabel } from './references.ts';
import { linesOutsideCode } from './scan.ts';

const DEFINITION = /^ {0,3}\[\^([^[\]\n]+)\]:/;

/**
 * The labels every `[^label]:` in the source defines, scanned from the
 * source for the same reason link references are (see `references.ts`):
 * a reference sits above its definition, and Read mode renders the chunk
 * holding the reference long before it parses the one holding the note.
 */
export function footnoteDefinitions(source: string): Set<string> {
  const found = new Set<string>();
  for (const line of linesOutsideCode(source)) {
    const m = DEFINITION.exec(line);
    if (m?.[1]) found.add(normalizeLabel(m[1]));
  }
  return found;
}

/** Where a footnote and the text that refers to it live in the page. */
export interface FootnoteAnchor {
  /** The number the reader sees, from 1. */
  number: number;
  /** The id of the note itself. */
  id: string;
  /** The id of the first reference, which the note links back to. */
  backId: string;
}

/**
 * Footnote numbers and anchors, handed out in the order the document
 * first mentions a label — GitHub's rule, and the one a reader infers
 * from the numbers running 1, 2, 3 down the page.
 *
 * Numbering is a left-to-right pass over the document, so a chunked
 * render and a whole-document render agree. A definition whose label was
 * never referenced takes the next number when it is rendered, which is
 * the only place left to put it.
 */
export class FootnoteNumbers {
  private readonly assigned = new Map<string, FootnoteAnchor>();

  /**
   * `reserve` claims an id, returning the one that was free. Anchors share
   * the page with heading ids, so the renderer passes its slugger.
   */
  constructor(private readonly reserve: (id: string) => string = (id) => id) {}

  /** The anchor for a label, assigning the next number the first time it is seen. */
  anchor(label: string): FootnoteAnchor {
    const key = normalizeLabel(label);
    const existing = this.assigned.get(key);
    if (existing) return existing;
    const number = this.assigned.size + 1;
    const anchor: FootnoteAnchor = {
      number,
      id: this.reserve(`fn-${number}`),
      backId: this.reserve(`fnref-${number}`),
    };
    this.assigned.set(key, anchor);
    return anchor;
  }

  /** True until this label has been seen, which is what carries the back link. */
  unseen(label: string): boolean {
    return !this.assigned.has(normalizeLabel(label));
  }
}
