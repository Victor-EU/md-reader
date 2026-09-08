const FENCE = /^ {0,3}(?:```|~~~)/;

/**
 * The lines of a document that are not inside a fenced code block.
 *
 * Both source scans below run over these: a line that only looks like a
 * definition is most likely to appear inside a fence, where it is code
 * and not a definition at all.
 */
export function* linesOutsideCode(source: string): Generator<string> {
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
    yield line;
  }
}
