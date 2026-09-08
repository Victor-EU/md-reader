import { createEditorState } from '@mdreader/editor-core';
import { generateDocument } from '@mdreader/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';
// The read view the app mounts, not a copy of it: what is measured here has
// to be the code that runs.
import { ReadView } from '../../../apps/desktop/src/lib/read/view.ts';

/**
 * Open to first paint in Read mode, which the Phase 1 gate budgets at
 * 100 ms for a 1 MB document.
 *
 * The measured span is everything the app does between "the file is in
 * memory" and "the first screenful is laid out": build the editor state,
 * parse as far as the viewport needs, render those blocks, and force
 * layout. The rest of the document is rendered in idle slices, and the
 * time to finish it is recorded as well — it is not part of the budget,
 * but a renderer that takes a minute to finish a long document would be a
 * problem the budget alone would not show.
 */
const BUDGET_MS = 100;
const sizes: [string, number][] = [
  ['100KB', 100_000],
  ['1MB', 1_000_000],
];

const round = (n: number) => Math.round(n * 10) / 10;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('read mode first paint', () => {
  let host: HTMLDivElement;
  const results: Record<string, unknown>[] = [];

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 600px; width: 800px; overflow: auto; position: relative;';
    document.body.appendChild(host);
    // One small document first, so the number is steady state rather than
    // the first run's module loading and JIT.
    const warm = new ReadView({
      parent: host,
      state: createEditorState(generateDocument(20_000, 3)),
    });
    void host.offsetHeight;
    warm.destroy();
  });

  afterEach(async () => {
    host.remove();
    await server.commands.writeFile(
      `tools/bench/results/read-paint-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  for (const [label, bytes] of sizes) {
    it(`${label}: first paint under ${BUDGET_MS} ms`, async () => {
      const doc = generateDocument(bytes, 11);
      let complete = false;
      const t0 = performance.now();
      const state = createEditorState(doc);
      const view = new ReadView({
        parent: host,
        state,
        onOutline: (_entries, done) => {
          complete = done;
        },
      });
      // Reading layout forces style and layout for the DOM just written.
      void host.offsetHeight;
      const firstPaint = performance.now() - t0;
      await nextFrame();
      const toFrame = performance.now() - t0;

      const deadline = performance.now() + 60_000;
      while (!complete && performance.now() < deadline) await nextFrame();
      const full = performance.now() - t0;
      const blocks = host.querySelector('.read')?.children.length ?? 0;

      const row = {
        size: label,
        firstPaint: round(firstPaint),
        toFrame: round(toFrame),
        fullRender: round(full),
        blocks,
        bytes: doc.length,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      view.destroy();
      expect(row.firstPaint, `${label} first paint`).toBeLessThan(BUDGET_MS);
      expect(complete, `${label} finished rendering`).toBe(true);
    });
  }
});
