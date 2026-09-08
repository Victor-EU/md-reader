/**
 * The palette's scorer: the best-scoring subsequence match, found with a
 * small dynamic program. Greedy matching is not enough — the first `p` of
 * `markdown-app-build-plan.md` is not the one the user meant — and the
 * matched positions are also what the palette underlines.
 */
export interface Match {
  score: number;
  /** Indices in the haystack that the query matched, for highlighting. */
  positions: number[];
}

const BASE = 10;
/** Matching where a word starts is the strongest signal a query gives. */
const BOUNDARY = 12;
/** A run of characters in a row is the next strongest. */
const CONSECUTIVE = 8;
/** Ending at a word end too: `plan` is a whole word in `build-plan.md`. */
const WORD_END = 8;
/** Skipping characters to continue the match costs a little. */
const GAP = 4;
/** A late first character costs, so an early match wins a tie. */
const LATE_START = 0.5;
/** And a shorter haystack wins the tie after that. */
const LENGTH = 0.1;

const SEPARATOR = /[\s/\\._\-#[\](),:]/;

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1] as string;
  if (SEPARATOR.test(prev)) return true;
  // camelCase: a capital after a lowercase starts a word.
  const here = text[index] as string;
  return prev === prev.toLowerCase() && here === here.toUpperCase() && here !== here.toLowerCase();
}

function isWordEnd(text: string, index: number): boolean {
  const next = text[index + 1];
  return next === undefined || SEPARATOR.test(next);
}

const MISS = Number.NEGATIVE_INFINITY;

export function match(query: string, text: string): Match | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (q === '') return { score: 0, positions: [] };
  const t = text.toLowerCase();
  if (q.length > t.length) return null;

  // row[j]: best score for the query so far, with its last character at j.
  let row = new Float64Array(t.length).fill(MISS);
  const parents: Int32Array[] = [];
  for (let i = 0; i < q.length; i++) {
    const next = new Float64Array(t.length).fill(MISS);
    const parent = new Int32Array(t.length).fill(-1);
    let bestBefore = MISS;
    let bestBeforeAt = -1;
    for (let j = 0; j < t.length; j++) {
      if (j > 0) {
        const previous = row[j - 1] as number;
        if (previous > bestBefore) {
          bestBefore = previous;
          bestBeforeAt = j - 1;
        }
      }
      if (t[j] !== q[i]) continue;
      const bonus = BASE + (isBoundary(text, j) ? BOUNDARY : 0);
      if (i === 0) {
        next[j] = bonus - j * LATE_START;
        continue;
      }
      const run = j > 0 ? (row[j - 1] as number) : MISS;
      const consecutive = run === MISS ? MISS : run + CONSECUTIVE;
      const gapped = bestBefore === MISS ? MISS : bestBefore - GAP;
      if (consecutive === MISS && gapped === MISS) continue;
      if (consecutive >= gapped) {
        next[j] = bonus + consecutive;
        parent[j] = j - 1;
      } else {
        next[j] = bonus + gapped;
        parent[j] = bestBeforeAt;
      }
    }
    parents.push(parent);
    row = next;
  }

  let end = -1;
  let best = MISS;
  for (let j = 0; j < t.length; j++) {
    const value = (row[j] as number) + (isWordEnd(text, j) ? WORD_END : 0);
    if (value > best) {
      best = value;
      end = j;
    }
  }
  if (end === -1) return null;

  const positions: number[] = [];
  let at = end;
  for (let i = q.length - 1; i >= 0; i--) {
    positions.unshift(at);
    at = (parents[i] as Int32Array)[at] as number;
  }
  return { score: best - text.length * LENGTH, positions };
}

export interface Ranked<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Rank `items` against `query`. `text` is what the query matches and what
 * the positions index into. Ties keep the input order, so an unfiltered
 * palette shows its list as the caller built it.
 */
export function rank<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): Ranked<T>[] {
  const out: (Ranked<T> & { index: number })[] = [];
  items.forEach((item, index) => {
    const m = match(query, text(item));
    if (m) out.push({ item, score: m.score, positions: m.positions, index });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.map(({ item, score, positions }) => ({ item, score, positions }));
}
