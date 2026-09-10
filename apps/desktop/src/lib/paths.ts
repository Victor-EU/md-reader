/** Path helpers that work on both separators, since one build serves both. */

const SEPARATOR = /[/\\]/;

export function segments(path: string): string[] {
  return path.split(SEPARATOR).filter((part) => part !== '');
}

export function basename(path: string): string {
  return segments(path).pop() ?? path;
}

export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? '' : path.slice(0, cut);
}

/** Whether a path names a place from the root rather than from a folder. */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[/\\]/.test(path);
}

/**
 * `relative` resolved against `dir`, with `.` and `..` applied. Absolute
 * paths are returned as they are, so `/pictures/x.png` in a document means
 * the same place whichever folder the document sits in.
 *
 * Separators follow whatever `dir` already uses, because the result is
 * handed straight back to the platform that produced the path.
 */
export function resolvePath(dir: string, relative: string): string {
  if (isAbsolute(relative)) return relative;
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const parts = segments(dir);
  const prefix = dir.startsWith('/') ? '/' : '';
  for (const part of segments(relative)) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return prefix + parts.join(separator);
}

/**
 * Tab labels: the file name, extended leftwards with parent directories
 * until it is unique among the open tabs. Two `index.md` tabs read
 * `docs/index.md` and `site/index.md`, which is the only way a tab strip
 * of same-named files is usable.
 */
export function tabLabels(
  paths: readonly (string | null)[],
  fallbacks: readonly string[],
): string[] {
  const parts = paths.map((path) => (path === null ? null : segments(path)));
  const labels = parts.map((p, i) =>
    p === null ? (fallbacks[i] ?? 'Untitled') : (p.at(-1) ?? ''),
  );
  for (let depth = 2; depth < 12; depth++) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    const ambiguous = labels.some((label) => (counts.get(label) ?? 0) > 1);
    if (!ambiguous) break;
    let changed = false;
    labels.forEach((label, i) => {
      const p = parts[i];
      if (!p || (counts.get(label) ?? 0) < 2 || p.length < depth) return;
      labels[i] = p.slice(-depth).join('/');
      changed = true;
    });
    if (!changed) break;
  }
  return labels;
}

/**
 * Whether a path names a PDF (ADR 0035).
 *
 * By extension, the way an image is recognised, and for the same reason:
 * this is asked of a path the OS handed over, before anything has been
 * read. A file whose name says nothing opens as a document, which is
 * what it has always done.
 */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/**
 * Whether `path` is `dir` or something under it. Prefix matching alone
 * would put `/notes-old/x.md` inside `/notes`, so the separator is part
 * of the question.
 */
export function inside(dir: string, path: string): boolean {
  if (path === dir) return true;
  const root = /[/\\]$/.test(dir) ? dir : `${dir}/`;
  return path.startsWith(root) || path.startsWith(root.replace(/\/$/, '\\'));
}

/**
 * A directory as a palette row shows it: the last `depth` segments, with a
 * leading ellipsis when there was more. Full paths are too long to read at
 * a glance, and the tail is the part that tells two files apart.
 */
export function shortenDir(path: string, depth = 2): string {
  const parts = segments(path);
  if (parts.length <= depth) return path;
  return `…/${parts.slice(-depth).join('/')}`;
}

/** `file:///Users/a/b.md` as dropped by the OS, back to a path. */
export function fileUrlToPath(url: string): string | null {
  if (!url.startsWith('file://')) return null;
  const decoded = decodeURIComponent(url.slice('file://'.length).replace(/^localhost/, ''));
  // `file:///C:/x` on Windows decodes to `/C:/x`.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}
