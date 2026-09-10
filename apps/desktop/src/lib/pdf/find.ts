import type { TextRun } from './engine.ts';

/**
 * Find over a PDF (ADR 0035).
 *
 * It cannot be the code path a CodeMirror search takes, because there is
 * no buffer: what a PDF has is a list of runs per page, each a few
 * characters and a rectangle, in the order the file draws them. So a
 * page is joined into one string, searched, and the matches are mapped
 * back to the runs they cover — which is what the pane marks and what
 * takes the reader to the page.
 *
 * Nothing here knows about pdf.js, or about the view. It is the part
 * that can be tested without either.
 */

/**
 * Where a query matched: a page, the runs the match covers, and where it
 * begins and ends inside the first and last of them.
 *
 * The characters matter as well as the runs. A run is often a whole
 * line, and marking the line because five letters of it matched is the
 * difference between a find that helps and one that says "somewhere
 * around here".
 */
export interface PdfHit {
  /** One-based, the way a PDF numbers its own pages. */
  page: number;
  /** The first run the match touches, as an index into the page's list. */
  from: number;
  /** One past the last run it touches. */
  to: number;
  /** Where the match starts inside run `from`. */
  head: number;
  /** Where it ends, one past, inside run `to - 1`. */
  tail: number;
}

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regexp?: boolean;
}

/** A page's runs as one string, with where each run begins in it. */
export function pageString(runs: readonly TextRun[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let text = '';
  for (const run of runs) {
    starts.push(text.length);
    text += run.text;
  }
  return { text, starts };
}

/**
 * The query as a regular expression over one page's text.
 *
 * Returns null for a query that cannot be one, which is an unfinished
 * regular expression the reader is still typing. The bar says so; this
 * says nothing and finds nothing, which is the same answer an empty
 * query gets.
 */
export function queryRegExp(query: string, options: FindOptions = {}): RegExp | null {
  if (query === '') return null;
  // A backslash the reader typed is a backslash, unless they ticked the
  // box that makes it the engine's — the same rule the editor's search
  // follows, so one query means one thing in both.
  const source = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
  try {
    return new RegExp(bounded, options.caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

/** Which run a position in the joined text falls in. */
function runAt(starts: readonly number[], at: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Every match on one page, in reading order.
 *
 * A zero-width match — `a*` against a page with no `a` in it — would
 * otherwise loop forever, so the walk always moves on.
 */
export function hitsInPage(runs: readonly TextRun[], page: number, pattern: RegExp): PdfHit[] {
  if (runs.length === 0) return [];
  const { text, starts } = pageString(runs);
  const hits: PdfHit[] = [];
  const walker = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  walker.lastIndex = 0;
  let match = walker.exec(text);
  while (match !== null) {
    const end = match.index + Math.max(1, match[0].length);
    const from = runAt(starts, match.index);
    const last = runAt(starts, end - 1);
    hits.push({
      page,
      from,
      to: last + 1,
      head: match.index - (starts[from] as number),
      tail: end - (starts[last] as number),
    });
    walker.lastIndex = end;
    match = walker.exec(text);
  }
  return hits;
}

/**
 * The hit to go to from where the reader is, forward or back.
 *
 * Wraps, as every editor does, and starts from the page in front rather
 * than from the top: the reader pressed Enter looking at a page, and the
 * next match is the one after what they can see.
 */
export function stepHit(
  hits: readonly PdfHit[],
  current: number,
  page: number,
  forward: boolean,
): number {
  if (hits.length === 0) return -1;
  if (current >= 0 && current < hits.length) {
    return (current + (forward ? 1 : hits.length - 1)) % hits.length;
  }
  if (forward) {
    const at = hits.findIndex((hit) => hit.page >= page);
    return at === -1 ? 0 : at;
  }
  for (let at = hits.length - 1; at >= 0; at--) {
    if ((hits[at] as PdfHit).page <= page) return at;
  }
  return hits.length - 1;
}
