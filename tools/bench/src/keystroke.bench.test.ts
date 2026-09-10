import { syntaxParserRunning } from '@codemirror/language';
import { createEditor } from '@markdown/editor-core';
import { generateDocument } from '@markdown/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';

/**
 * Keystroke latency with live preview on, p95 over two hundred keystrokes
 * at three positions, on the 100 KB and 1 MB documents, and over forty on
 * the 10 MB one.
 *
 * The budgeted number is `work`: the synchronous dispatch (parse, decoration
 * rebuild, DOM writes) plus a forced layout, which is the part of a
 * keystroke the editor controls. The time to the next animation frame is
 * recorded too but is dominated by the 16.7 ms vsync interval in a headless
 * browser, so it is informational. Playwright's Chromium and WebKit are the
 * inner loop; the numbers that matter come from WKWebView and WebView2 on
 * the pinned machines (plan section 1.1), so the budget here is a
 * regression guard, not the promise.
 *
 * The ten megabyte row has a budget of its own and it is not a promise
 * kept; it is a measurement written down (plan WP 3.3). At the top of
 * such a document a keystroke costs two milliseconds, and anywhere else
 * in it seventy to a hundred and twenty — and none of that is this
 * app's. Taking the extension list apart one at a time puts all of it in
 * `markdownSupport`: CodeMirror's own incremental parse, mapping a tree
 * of several million characters through every change. It does not settle
 * with pauses — it gets worse as more of the document is parsed — and
 * there is no size knob to turn. Design 8 lets a file of ten megabytes
 * be edited and design 12 promises sixteen milliseconds a keystroke; at
 * that size the two do not both hold, and which of them gives is not a
 * decision this bench can make.
 */
const BUDGET_MS = 16;
/**
 * What the ten megabyte case does today, with room for a slower machine.
 * A guard against it getting worse, not a promise that it is good.
 */
const HUGE_BUDGET_MS = 400;
const KEYSTROKES = 200;
/**
 * Fewer at ten megabytes. Two hundred keystroke at that size is a minute
 * of one browser's time for a number that is already clear at forty, and
 * each one drives the parser further into the document, so the long run
 * measures the tail rather than the typing.
 */
const HUGE_KEYSTROKES = 40;
const sizes: [string, number][] = [
  ['100KB', 100_000],
  ['1MB', 1_000_000],
  // Just under design 8's ten megabyte editing ceiling, which is the
  // largest document this app will let anybody type into (plan WP 3.3).
  ['10MB', 9_990_000],
];

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

const round = (n: number) => Math.round(n * 10) / 10;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function settled(
  view: ReturnType<typeof createEditor>['view'],
  timeoutMs: number,
): Promise<void> {
  const start = performance.now();
  while (syntaxParserRunning(view) && performance.now() - start < timeoutMs) await nextFrame();
}

describe('keystroke latency', () => {
  let host: HTMLDivElement;
  const results: Record<string, unknown>[] = [];

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 600px; width: 800px; overflow: hidden;';
    document.body.appendChild(host);
  });

  afterEach(async () => {
    host.remove();
    await server.commands.writeFile(
      `results/keystroke-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  for (const [label, bytes] of sizes) {
    const budget = bytes > 1_000_000 ? HUGE_BUDGET_MS : BUDGET_MS;
    const keystrokes = bytes > 1_000_000 ? HUGE_KEYSTROKES : KEYSTROKES;
    it(`${label}: p95 under ${budget} ms`, async () => {
      const doc = generateDocument(bytes, 7);
      const t0 = performance.now();
      const editor = createEditor(host, doc);
      await nextFrame();
      const firstPaint = performance.now() - t0;
      await settled(editor.view, 30_000);
      const parserIdle = performance.now() - t0;

      const positions: [string, number][] = [
        ['start', doc.indexOf('\n\n') + 2],
        ['middle', doc.indexOf('\n\n', Math.floor(doc.length / 2)) + 2],
        ['end', doc.length - 1],
      ];
      for (const [where, at] of positions) {
        let pos = at;
        editor.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        await nextFrame();
        const dispatch: number[] = [];
        const work: number[] = [];
        const frame: number[] = [];
        for (let i = 0; i < keystrokes; i++) {
          const a = performance.now();
          editor.view.dispatch({
            changes: { from: pos, insert: 'x' },
            selection: { anchor: pos + 1 },
            userEvent: 'input.type',
          });
          const b = performance.now();
          // Reading layout forces style and layout for the DOM just written.
          void editor.view.contentDOM.offsetHeight;
          const c = performance.now();
          await nextFrame();
          const d = performance.now();
          dispatch.push(b - a);
          work.push(c - a);
          frame.push(d - a);
          pos += 1;
        }
        const row = {
          size: label,
          where,
          dispatchP50: round(percentile(dispatch, 0.5)),
          dispatchP95: round(percentile(dispatch, 0.95)),
          workP50: round(percentile(work, 0.5)),
          workP95: round(percentile(work, 0.95)),
          workMax: round(Math.max(...work)),
          toFrameP95: round(percentile(frame, 0.95)),
          firstPaint: round(firstPaint),
          parserIdle: round(parserIdle),
        };
        results.push(row);
        console.log(JSON.stringify(row));
        expect(row.workP95, `${label} ${where} work p95`).toBeLessThan(budget);
      }
      editor.destroy();
    });
  }
});
