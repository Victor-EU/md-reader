import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { generateDocument } from '@markdown/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';
import { Workspace } from '../../../apps/desktop/src/lib/workspace.svelte.ts';
import { ms } from './runner.ts';

/**
 * What it costs to open a document and to change how it is shown (plan
 * 7.4's mode switch time, plan WP 3.3's ten megabyte file).
 *
 * The other benches each measure one mode. This one measures the seams
 * between them, which is where a large document is felt: opening one
 * counts its words for the status bar and walks it for the outline, and
 * changing mode throws one view away and builds another. All of it
 * happens on the document the reader is looking at, so all of it is in
 * front of them.
 *
 * `count` and `outline` are the second ask rather than the first. The
 * first is inside `open`, where the window does it: a buffer is
 * immutable, so what was read out of one version of it is read once and
 * kept, and a tab coming back to the front asks for something already in
 * hand (plan WP 3.3). What these two rows show is that it is in hand.
 */
/** What asking for something already in hand may cost. Measured at 0. */
const AGAIN_BUDGET_MS = 5;
/** What building a view of a document may cost (design 12). */
const MOUNT_BUDGET_MS = 100;
/**
 * The same for Read mode, which is its own number at ten megabytes.
 *
 * An editor mounts a viewport and Read mode builds the whole document, so
 * this is the one mount whose cost follows the file size. At ten megabytes
 * it measures 41 ms in Chromium and 63 in WebKit on the machine this was
 * written on, and 138 on the GitHub macOS runner, which is the machine CI
 * has: three cores, shared, and two to three times slower on this path.
 *
 * So the ten megabyte row is a guard against a disaster rather than
 * design 12's promise — the same distinction `keystroke.bench.test.ts`
 * draws at that size, and for the same reason. The promise is about
 * WKWebView and WebView2 on the pinned machines of plan 1.1, and the
 * harness that would measure it is plan 7.4's in-app `--bench`, which
 * does not exist yet. Until it does, no number here is that promise.
 */
const READ_BUDGET_MS: Record<string, number> = { '100KB': 100, '1MB': 100, '10MB': 250 };
/** What changing between the two projections of one view may cost: a frame. */
const RECONFIGURE_BUDGET_MS = 16;
/**
 * What the word count costs when the buffer has moved under it, which is
 * the one on the reader's own path: it runs on a timer while they type.
 * Measured with room for a slower machine; the ten megabyte number is a
 * walk of ten megabytes of text and is what it is (plan WP 3.3).
 */
const EDITED_BUDGET_MS: Record<string, number> = { '100KB': 25, '1MB': 30, '10MB': 300 };

const sizes: [string, number][] = [
  ['100KB', 100_000],
  ['1MB', 1_000_000],
  // Just under design 8's ten megabyte editing ceiling: the point of the
  // rows below is what a switch costs, not the refusal above it.
  ['10MB', 9_990_000],
];

const round = (n: number) => Math.round(n * 10) / 10;

describe('coming to a document', () => {
  let host: HTMLDivElement;
  let ipc: FakeIpc;
  let workspace: Workspace;
  const results: Record<string, unknown>[] = [];

  beforeEach(async () => {
    host = document.createElement('div');
    host.style.cssText = 'height: 600px; width: 800px; overflow: auto; position: relative;';
    document.body.appendChild(host);
    // One small document opened and shown both ways first, so the
    // numbers are steady state rather than the first run's module
    // loading and JIT.
    const warm = new Workspace({
      commands: createFakeIpc({ '/w/warm.md': generateDocument(20_000, 3) }).commands,
    });
    await warm.openPath('/w/warm.md');
    warm.sidebar = true;
    warm.countNow();
    warm.setMode('edit');
    warm.mount(host);
    warm.setMode('source');
    warm.view?.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    warm.countNow();
    warm.setMode('read');
    warm.unmount();
    warm.mountRead(host);
    void host.offsetHeight;
    warm.destroy();
  });

  afterEach(async () => {
    workspace.destroy();
    host.remove();
    await server.commands.writeFile(
      `results/switch-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  /** Time a piece of work with the layout it dirtied forced after it. */
  const timed = (work: () => void): number => {
    const start = performance.now();
    work();
    void host.offsetHeight;
    return performance.now() - start;
  };

  for (const [label, bytes] of sizes) {
    it(`${label}: opens, and comes back within a frame`, async () => {
      const text = generateDocument(bytes, 11);
      ipc = createFakeIpc({ '/w/doc.md': text });
      workspace = new Workspace({ commands: ipc.commands });
      // The sidebar is what asks for the outline, so it is open here.
      workspace.sidebar = true;

      const t0 = performance.now();
      await workspace.openPath('/w/doc.md');
      void host.offsetHeight;
      const open = performance.now() - t0;

      const count = timed(() => workspace.countNow());
      const countAgain = timed(() => workspace.countNow());
      const outline = timed(() => workspace.refreshOutline());
      const outlineAgain = timed(() => workspace.refreshOutline());

      const toEdit = timed(() => {
        workspace.setMode('edit');
        workspace.mount(host);
      });
      // What the count costs when the buffer has moved under it, which
      // is what typing does: the answer is not in hand any more. This is
      // the one the reader can feel, because it runs on a timer while
      // they are still typing.
      workspace.view?.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
      const edited = timed(() => workspace.countNow());
      const toSource = timed(() => workspace.setMode('source'));
      const toRead = timed(() => {
        workspace.setMode('read');
        workspace.unmount();
        workspace.mountRead(host);
      });

      const row = {
        size: label,
        bytes: text.length,
        words: workspace.words,
        headings: workspace.outline.length,
        open: round(open),
        count: round(count),
        countAgain: round(countAgain),
        outline: round(outline),
        outlineAgain: round(outlineAgain),
        edited: round(edited),
        toEdit: round(toEdit),
        toSource: round(toSource),
        toRead: round(toRead),
      };
      results.push(row);
      console.log(JSON.stringify(row));
      expect(row.words, `${label} counted`).toBeGreaterThan(0);
      // `open` is reported and not budgeted: most of it at this size is
      // the fake's own hashing of the file, and what an open really
      // costs is `read-paint.bench.test.ts`, which has no fake in it.
      expect(row.count, `${label} word count`).toBeLessThan(ms(AGAIN_BUDGET_MS));
      expect(row.countAgain, `${label} word count again`).toBeLessThan(ms(AGAIN_BUDGET_MS));
      expect(row.outline, `${label} outline`).toBeLessThan(ms(AGAIN_BUDGET_MS));
      expect(row.outlineAgain, `${label} outline again`).toBeLessThan(ms(AGAIN_BUDGET_MS));
      expect(row.edited, `${label} word count after a keystroke`).toBeLessThan(
        ms(EDITED_BUDGET_MS[label] ?? 300),
      );
      expect(row.toEdit, `${label} to edit`).toBeLessThan(ms(MOUNT_BUDGET_MS));
      expect(row.toRead, `${label} to read`).toBeLessThan(
        ms(READ_BUDGET_MS[label] ?? MOUNT_BUDGET_MS),
      );
      expect(row.toSource, `${label} to source`).toBeLessThan(ms(RECONFIGURE_BUDGET_MS));
    });
  }
});
