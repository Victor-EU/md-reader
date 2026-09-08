import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { goldenSet } from '../corpus.ts';
import { parser } from '../parser.ts';
import { toHtml } from './html.ts';
import { renderDocument } from './render.ts';

/**
 * The rendering goldens of plan 7.2. One file per corpus file, reviewed by
 * a human when it changes: `vitest -u` rewrites them, and the diff in the
 * pull request is the review.
 *
 * There is one golden per file rather than one per engine. The renderer is
 * ours and builds the same nodes everywhere, so a difference between
 * Chromium and WebKit would be a bug, not a second expected output — and
 * `dom.browser.test.ts` asserts exactly that by mounting the same nodes in
 * both engines and comparing them against this same file.
 */
export function goldenPath(name: string): string {
  return fileURLToPath(
    new URL(`../../../../corpus/goldens/read/${name.replace(/\.md$/, '.html')}`, import.meta.url),
  );
}

describe('read mode goldens', () => {
  for (const file of goldenSet()) {
    it(file.name, async () => {
      const html = toHtml(renderDocument(parser.parse(file.text), file.text));
      await expect(`${html}\n`).toMatchFileSnapshot(goldenPath(file.name));
    });
  }
});
