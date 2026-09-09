const BACKTICK = 0x60;
const TILDE = 0x7e;
const SPACE = 0x20;

/** One line of the source, as where it starts and where it ends. */
export interface LineRange {
  at: number;
  end: number;
}

/** Whitespace as `trimStart` treats it, for the characters a line starts with. */
function blank(code: number): boolean {
  return code === SPACE || (code >= 0x09 && code <= 0x0d);
}

/** The first character of the line that is not whitespace. */
function firstMark(source: string, at: number, end: number): number {
  let i = at;
  while (i < end && blank(source.charCodeAt(i))) i += 1;
  return i;
}

/** Three of the same fence character at `i`, or none. */
function fenceAt(source: string, i: number, end: number): number | null {
  if (i + 3 > end) return null;
  const code = source.charCodeAt(i);
  if (code !== BACKTICK && code !== TILDE) return null;
  return source.charCodeAt(i + 1) === code && source.charCodeAt(i + 2) === code ? code : null;
}

/**
 * The lines of a document that are not inside a fenced code block, as
 * ranges rather than strings.
 *
 * Both source scans below run over these: a line that only looks like a
 * definition is most likely to appear inside a fence, where it is code
 * and not a definition at all.
 *
 * Ranges, because a whole-file scan is a walk of every line of what may
 * be a hundred megabytes (design 8) and almost none of them hold
 * anything the scan is looking for. Cutting each one out of the source to
 * find that out is the cost of the walk; `scanSource` slices the few
 * lines that could matter and leaves the rest where they are.
 */
export function* lineRangesOutsideCode(source: string): Generator<LineRange> {
  let fence: number | null = null;
  let at = 0;
  while (at <= source.length) {
    const found = source.indexOf('\n', at);
    const end = found === -1 ? source.length : found;
    const mark = firstMark(source, at, end);
    if (fence !== null) {
      // A closing fence may be indented by any amount, as `trimStart` says.
      if (fenceAt(source, mark, end) === fence) fence = null;
    } else {
      // An opening one by up to three spaces, as CommonMark says.
      const opener = mark - at <= 3 ? fenceAt(source, mark, end) : null;
      if (opener !== null) fence = opener;
      else yield { at, end };
    }
    if (found === -1) break;
    at = end + 1;
  }
}

/**
 * The lines of a document that are not inside a fenced code block.
 *
 * For the scans that want one thing and are given a document to find it
 * in; a scan that wants several should walk the ranges once instead.
 */
export function* linesOutsideCode(source: string): Generator<string> {
  for (const { at, end } of lineRangesOutsideCode(source)) yield source.slice(at, end);
}

/** The same lines, each with the offset it starts at. */
export function* linesOutsideCodeAt(source: string): Generator<{ line: string; at: number }> {
  for (const { at, end } of lineRangesOutsideCode(source))
    yield { line: source.slice(at, end), at };
}
