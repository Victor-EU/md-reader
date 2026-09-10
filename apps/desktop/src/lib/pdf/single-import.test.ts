import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One file may import `pdfjs-dist`, and this is what holds it to that
 * (ADR 0035).
 *
 * The rule is easy to break by accident — a type import for
 * convenience, a constant borrowed from the library — and each break
 * costs nothing at all until the day the engine is swapped, when it
 * costs everything. The `Enhancer` port has the same shape and has held
 * on intention alone; this one is worth enforcing because the thing it
 * keeps out is bigger.
 *
 * Only source directories are walked. The Vite plugin that copies the
 * library's data out of `node_modules`, and the test runner's
 * `optimizeDeps` list, both have to name the package and both sit
 * outside `src/`, which is the line this draws.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const SKIP = new Set(['node_modules', 'target', 'dist', 'public', '.git', '.vitest', 'corpus']);
const CODE = /\.(ts|mts|js|mjs|svelte)$/;
const ADAPTER = join('apps', 'desktop', 'src', 'lib', 'pdf', 'pdfjs.ts');
const PORT = join('apps', 'desktop', 'src', 'lib', 'pdf', 'engine.ts');
const SELF = join('apps', 'desktop', 'src', 'lib', 'pdf', 'single-import.test.ts');

/** Every source file in the workspace, as paths relative to the root. */
function sources(dir: string, inSrc: boolean, into: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, inSrc || entry.name === 'src', into);
    else if (inSrc && CODE.test(entry.name)) into.push(relative(ROOT, path));
  }
  return into;
}

/**
 * What a file imports. Static and dynamic both, because a lazy import
 * of the library is exactly the shape the rule has to catch.
 */
function imports(file: string): string[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const found = [...source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)];
  return found.map((match) => match[1] as string);
}

describe('the pdf.js adapter is the only file that imports pdfjs-dist', () => {
  const files = sources(ROOT, false, []);

  it('finds the source tree it is meant to be walking', () => {
    // A walk that silently found nothing would pass every other test
    // here, which is the one way this file could stop doing its job.
    expect(files).toContain(ADAPTER);
    expect(files).toContain(PORT);
    expect(files.length).toBeGreaterThan(50);
  });

  it('is imported nowhere else', () => {
    const importing = files.filter((file) =>
      imports(file).some((specifier) => specifier.startsWith('pdfjs-dist')),
    );
    expect(importing).toEqual([ADAPTER]);
  });

  it('leaves no pdf.js type in the port itself', () => {
    // The port is what the shell is allowed to know, and it is written
    // to be satisfiable by PDFium too. A pdf.js type in it would make it
    // a description of one library rather than of PDF viewing.
    expect(readFileSync(join(ROOT, PORT), 'utf8')).not.toMatch(/pdfjs-dist/);
  });

  it('imports from the library rather than from its viewer', () => {
    // `pdfjs-dist/web/` is the bundled viewer, and it is how a PDF's own
    // JavaScript would come back: scripting runs in `pdf.sandbox.mjs`,
    // which only the viewer loads. The core API has no annotation layer
    // and so no scripting path at all, which is the durable answer to
    // CVE-2026-16633.
    const specifiers = imports(ADAPTER).filter((s) => s.startsWith('pdfjs-dist'));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^pdfjs-dist(\/build\/.+)?$/);
    }
  });

  it('walks past the build plumbing, which is allowed to name it', () => {
    // Naming the exemption here rather than in `SKIP` keeps it visible.
    const plugin = join('apps', 'desktop', 'pdfjs-assets.ts');
    expect(readFileSync(join(ROOT, plugin), 'utf8')).toContain('pdfjs-dist');
    expect(files).not.toContain(plugin);
    expect(plugin.split(sep)).not.toContain('src');
    // This file names the package all over, and is the enforcement
    // rather than a use of it; it passes only because it imports none.
    expect(files).toContain(SELF);
    expect(imports(SELF).filter((s) => s.startsWith('pdfjs-dist'))).toEqual([]);
  });
});
