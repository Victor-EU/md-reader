import { createEditorState } from '@markdown/editor-core';
import { generateDocument } from '@markdown/markdown';
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
 * layout. The rest of the document is walked in idle slices, and the
 * time to reach the end of it is recorded as well — it is not part of the
 * budget, but a view that took a minute to find the end of a long
 * document would be a problem the budget alone would not show.
 *
 * The ten megabyte file is design 8's Read-only case and plan WP 2.7's
 * subject. Two numbers say whether the window works: `blocks`, which is
 * what the page costs and must not grow with the file, and `jump`, the
 * worst screenful-sized scroll, which is what the reader feels.
 */
/**
 * The design's promise is a tenth of a second at a megabyte. What the
 * two smaller sizes are held to is what they measure with room for a
 * slower machine, so that a regression fails the build rather than
 * quietly using up the promise's headroom (plan WP 3.3).
 */
const sizes: [string, number][] = [
  ['100KB', 100_000],
  ['1MB', 1_000_000],
  ['10MB', 10_000_000],
];
const budgets: Record<string, number> = { '100KB': 50, '1MB': 60, '10MB': 100 };
/** What one screenful of scrolling may take. Measured at 1 to 3 ms. */
const JUMP_BUDGET_MS = 8;

const round = (n: number) => Math.round(n * 10) / 10;
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('read mode first paint', () => {
  let host: HTMLDivElement;
  const results: Record<string, unknown>[] = [];

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 600px; width: 800px; overflow: auto; position: relative;';
    document.body.appendChild(host);
    // One small document first, scrolled through, so the numbers are
    // steady state rather than the first run's module loading and JIT.
    const warm = new ReadView({
      parent: host,
      state: createEditorState(generateDocument(20_000, 3)),
    });
    void host.offsetHeight;
    for (let i = 0; i < 4; i++) {
      host.scrollTop += host.clientHeight;
      void host.offsetHeight;
    }
    warm.destroy();
    host.scrollTop = 0;
  });

  afterEach(async () => {
    host.remove();
    await server.commands.writeFile(
      `results/read-paint-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  for (const [label, bytes] of sizes) {
    const budget = budgets[label] ?? 100;
    it(`${label}: first paint under ${budget} ms`, async () => {
      const doc = generateDocument(bytes, 11);
      let complete = false;
      const t0 = performance.now();
      const state = createEditorState(doc);
      const built = performance.now() - t0;
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
      const walk = performance.now() - t0;

      // A reader moving down the document a screenful at a time. The view
      // answers a scroll in the frame after it, so waiting for that frame
      // would measure the frame; what is timed here is the work itself —
      // build what has come into view, let go of what has left, and read
      // back the heights — with the layout it dirtied forced after it.
      const jumps: number[] = [];
      let deepest = 0;
      for (let i = 0; i < 20 && host.scrollTop + host.clientHeight < host.scrollHeight - 1; i++) {
        const start = performance.now();
        view.scrollTop = host.scrollTop + host.clientHeight;
        void host.offsetHeight;
        jumps.push(performance.now() - start);
        deepest = Math.max(deepest, host.querySelector('.read')?.children.length ?? 0);
        await nextFrame();
      }
      jumps.sort((a, b) => a - b);

      const row = {
        size: label,
        firstPaint: round(firstPaint),
        state: round(built),
        toFrame: round(toFrame),
        walk: round(walk),
        jump: round(jumps[jumps.length >> 1] ?? 0),
        jumpMax: round(jumps.at(-1) ?? 0),
        blocks: deepest,
        height: host.scrollHeight,
        bytes: doc.length,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      view.destroy();
      expect(row.firstPaint, `${label} first paint`).toBeLessThan(budget);
      expect(complete, `${label} reached the end`).toBe(true);
      // The page holds a window onto the document, not the document.
      expect(row.blocks, `${label} blocks in the page`).toBeLessThan(200);
      expect(row.jump, `${label} scroll`).toBeLessThan(JUMP_BUDGET_MS);
      expect(row.jumpMax, `${label} worst scroll`).toBeLessThan(JUMP_BUDGET_MS * 3);
      // A document nothing has parsed is what a launch has; a window
      // that took a minute to find the end of one would be a problem the
      // first paint alone would not show.
      expect(row.walk, `${label} reaching the end`).toBeLessThan(bytes < 5_000_000 ? 2_000 : 8_000);
    });
  }
});
