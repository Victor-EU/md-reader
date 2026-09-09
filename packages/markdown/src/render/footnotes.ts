import { normalizeLabel } from './references.ts';
import { linesOutsideCode, linesOutsideCodeAt } from './scan.ts';

const DEFINITION = /^ {0,3}\[\^([^[\]\n]+)\]:/;
const REFERENCE = /\[\^([^[\]\n]+)\](?!:)/g;

/**
 * The labels every `[^label]:` in the source defines, scanned from the
 * source for the same reason link references are (see `references.ts`):
 * a reference sits above its definition, and Read mode renders the chunk
 * holding the reference long before it parses the one holding the note.
 */
export function footnoteDefinitions(source: string): Set<string> {
  const found = new Set<string>();
  for (const line of linesOutsideCode(source)) {
    const label = noteDefinedOn(line);
    if (label !== null) found.add(label);
  }
  return found;
}

/**
 * The label one line defines, if it defines one.
 *
 * The `[^` in the line is looked for before the pattern is: a document is
 * mostly prose, and at ten megabytes the cheap answer for the lines that
 * hold no note at all is most of the work.
 */
export function noteDefinedOn(line: string): string | null {
  if (!line.includes('[^')) return null;
  const m = DEFINITION.exec(line);
  return m?.[1] ? normalizeLabel(m[1]) : null;
}

/** The labels one line refers to, with where in the line each starts. */
export function notesMentionedOn(line: string): { label: string; column: number }[] {
  if (!line.includes('[^')) return [];
  const out: { label: string; column: number }[] = [];
  for (const match of line.matchAll(REFERENCE)) {
    out.push({ label: normalizeLabel(match[1] as string), column: match.index ?? 0 });
  }
  return out;
}

/** The first mention of one label, and where the source makes it. */
export interface FootnoteReference {
  label: string;
  /** Offset of the `[` that opens it. */
  at: number;
}

/**
 * Every label the source refers to, in the order it first mentions each.
 *
 * The numbers a reader sees run 1, 2, 3 down the page, which is a fact
 * about the document and not about the order a view got round to drawing
 * it in. Read mode builds blocks as the reader reaches them (plan WP
 * 2.7), so this pass is the only place left where "first mention" still
 * means what it says; see `FootnoteNumbers.seed`.
 */
export function footnoteReferences(source: string): FootnoteReference[] {
  const seen = new Set<string>();
  const out: FootnoteReference[] = [];
  for (const { line, at } of linesOutsideCodeAt(source)) {
    // A definition line refers to nothing; it is what is referred to.
    if (noteDefinedOn(line) !== null) continue;
    for (const { label, column } of notesMentionedOn(line)) {
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label, at: at + column });
    }
  }
  return out;
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
  /** Labels a reference to which has been rendered. */
  private readonly drawn = new Set<string>();
  /** Where the source first mentions a label, once a pass has said. */
  private readonly mentions = new Map<string, number>();

  /**
   * `reserve` claims an id, returning the one that was free. Anchors share
   * the page with heading ids, so the renderer passes its slugger.
   */
  constructor(private readonly reserve: (id: string) => string = (id) => id) {}

  /**
   * Hand out the numbers for these labels in this order, before anything
   * has been rendered.
   *
   * A view that builds blocks in the order the reader reaches them (plan
   * WP 2.7) cannot let the render decide the numbering, so it settles it
   * from the source first and every label is answered for by the time it
   * is drawn. Seeding also claims the `fn-N` ids ahead of every heading,
   * which is what makes them the same ids whichever block is built
   * first, and records where each label is first mentioned, which is
   * what the back link needs when the reference below is drawn before
   * the one above.
   */
  seed(mentions: Iterable<string | FootnoteReference>): void {
    for (const mention of mentions) {
      const label = typeof mention === 'string' ? mention : mention.label;
      this.number(label);
      if (typeof mention !== 'string') this.mentions.set(normalizeLabel(label), mention.at);
    }
  }

  /** The anchor for a label, assigning the next number the first time it is seen. */
  anchor(label: string): FootnoteAnchor {
    const anchor = this.number(label);
    this.drawn.add(normalizeLabel(label));
    return anchor;
  }

  private number(label: string): FootnoteAnchor {
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

  /**
   * Whether the reference at `at` is the one the note links back to.
   *
   * Seeded, that is the first mention the source makes, whichever
   * reference happens to be drawn first; unseeded, it is the first one
   * drawn, which for a render that starts at the top is the same one.
   */
  first(label: string, at: number): boolean {
    const key = normalizeLabel(label);
    const mention = this.mentions.get(key);
    return mention === undefined ? !this.drawn.has(key) : mention === at;
  }

  /** Whether anything refers to this note, which is what carries a back link. */
  referenced(label: string): boolean {
    const key = normalizeLabel(label);
    return this.mentions.has(key) || this.drawn.has(key);
  }
}
