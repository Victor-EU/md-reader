import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parser } from './parser.ts';
import { assertWellFormed } from './test-helpers.ts';
import { dumpTree } from './tree.ts';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * One snapshot per fixture. The `.tree` files beside the fixtures are the
 * reviewed, expected parse; a diff there is a parser change and must be
 * read, not regenerated blindly.
 */
describe('fixtures', () => {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    it(file, async () => {
      const doc = readFileSync(join(dir, file), 'utf8');
      const tree = parser.parse(doc);
      assertWellFormed(tree, doc);
      await expect(dumpTree(tree, doc)).toMatchFileSnapshot(
        join(dir, file.replace(/\.md$/, '.tree')),
      );
    });
  }
});
