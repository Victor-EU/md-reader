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
