import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsedState, serializeDecorations } from '../test-helpers.ts';
import { buildDecorations } from './build.ts';

const fixtures = fileURLToPath(new URL('../../../markdown/fixtures/', import.meta.url));
const snapshots = fileURLToPath(new URL('../../fixtures/', import.meta.url));

/**
 * One decoration snapshot per parser fixture, with the cursor at the end
 * of the document so nothing but the last block is revealed. The
 * `.decorations` files are reviewed output: a diff is a rendering change.
 */
describe('buildDecorations', () => {
  for (const file of readdirSync(fixtures)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    it(file, async () => {
      // The editor normalizes CRLF to LF (WP 0.1), so the snapshot is of the normalized text.
      const doc = readFileSync(join(fixtures, file), 'utf8').replace(/\r\n/g, '\n');
      const state = parsedState(doc, doc.length);
      const built = buildDecorations(state, [{ from: 0, to: doc.length }]);
      await expect(serializeDecorations(built.decorations, doc)).toMatchFileSnapshot(
        join(snapshots, file.replace(/\.md$/, '.decorations')),
      );
    });
  }

  it('styles a bracketed span as a link only when it resolves', () => {
    const doc = 'see [aside] and [ok] and [text][ok] and [x][gone] and [u](/u)\n\n[OK]: /ok\n';
    const links = buildDecorations(parsedState(doc, doc.length), [
      { from: 0, to: doc.length },
    ]).decorations.filter((r) => (r.value.spec as { class?: string }).class === 'mdr-link');
    // The last one is the definition's own URL, styled as a link as before.
    expect(links.map((r) => doc.slice(r.from, r.to))).toEqual([
      '[ok]',
      '[text][ok]',
      '[u](/u)',
      '/ok',
    ]);
    const shown = serializeDecorations(
      buildDecorations(parsedState(doc, doc.length), [{ from: 0, to: doc.length }]).decorations,
      doc,
    );
    // The brackets of an unresolved reference are text and stay visible.
    expect(shown).not.toContain(`${doc.indexOf('[aside]')}-${doc.indexOf('[aside]') + 1} hide`);
    expect(shown).toContain(`${doc.indexOf('[ok]')}-${doc.indexOf('[ok]') + 1} hide`);
  });

  it('shows syntax dimmed instead of hiding it when the unit is revealed', () => {
    const doc = '# Title with **bold**\n\nx';
    const hidden = serializeDecorations(
      buildDecorations(parsedState(doc, doc.length), [{ from: 0, to: doc.length }]).decorations,
      doc,
    );
    const revealed = serializeDecorations(
      buildDecorations(parsedState(doc, 3), [{ from: 0, to: doc.length }]).decorations,
      doc,
    );
    expect(hidden).toContain('0-2 hide "# "');
    expect(hidden).toContain('13-15 hide "**"');
    expect(revealed).toContain('0-2 mark mdr-syntax "# "');
    expect(revealed).toContain('13-15 hide "**"');
    const inside = serializeDecorations(
      buildDecorations(parsedState(doc, 16), [{ from: 0, to: doc.length }]).decorations,
      doc,
    );
    expect(inside).toContain('13-15 mark mdr-syntax "**"');
  });

  it('only decorates lines inside the requested ranges', () => {
    const doc = '> a\n> b\n> c\n> d';
    const state = parsedState(doc, 0);
    const all = buildDecorations(state, [{ from: 0, to: doc.length }]);
    const some = buildDecorations(state, [{ from: 4, to: 8 }]);
    const lines = (built: typeof all) =>
      built.decorations.filter((r) => r.value.spec.kind === 'line').map((r) => r.from);
    expect(lines(all)).toEqual([0, 4, 8, 12]);
    expect(lines(some)).toEqual([4, 8]);
  });

  it('marks bullet and checkbox ranges atomic', () => {
    const doc = '- item\n- [ ] task\n1. num';
    const built = buildDecorations(parsedState(doc, doc.length), [{ from: 0, to: doc.length }]);
    expect(built.atomic.map((r) => [r.from, r.to])).toEqual([
      [0, 2],
      [7, 9],
      [9, 13],
    ]);
  });
});
