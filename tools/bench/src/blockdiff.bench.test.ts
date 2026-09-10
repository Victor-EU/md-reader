import { ensureSyntaxTree } from '@codemirror/language';
import { createEditorState } from '@markdown/editor-core';
import { commonBlocks, flattenBlocks, generateDocument, parser } from '@markdown/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';

/**
 * The frontend half of the semantic diff budget (plan WP 2.2): an
 * external change to a 1 MB document has to be aligned end to end in
 * 200 ms, and this is everything that happens before Rust sees it. The
 * alignment itself is measured in `crates/core/tests/block_budget.rs`,
 * at 9 ms in release for the same shape of change.
 *
 * What is budgeted is `scan`: walking the tree into blocks, matching off
 * the ends, and serializing the middle. The parse is reported beside it
 * and is not budgeted here, because the scan does not cause it — the
 * editor keeps that tree up to date for the outline, the word count and
 * Read mode, and a scan that finds it unfinished waits for the next one
 * rather than forcing it. `firstScan` is what the reader waits after a
 * write lands in a document nothing has parsed yet, which is the parse's
 * number and was the same before this work package.
 *
 * `payloadBytes` is what `JSON.stringify` makes of the two block lists,
 * which is what the bridge carries. On this path the size is the cost.
 */
/**
 * Was seventy-five, which is what was left of the two hundred after the
 * alignment and the bridge. It measures at three milliseconds at a
 * hundred kilobytes and twenty at a megabyte, so the guard is set from
 * that with room for a slower machine (plan WP 3.3).
 */
const BUDGET_MS = 45;
const sizes: [string, number][] = [
  ['100KB', 100_000],
  ['1MB', 1_000_000],
];

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * What a tool that rewrites parts of a document does to it: every
 * `every`th paragraph comes back with a word in front. Only paragraphs,
 * so the fixture is a document edited rather than one whose structure
 * has been pulled apart.
 */
function revise(text: string, every: number): string {
  let seen = 0;
  return text
    .split('\n\n')
    .map((block) => {
      if (!/^[A-Za-z]/.test(block) || block.includes('```')) return block;
      seen += 1;
      return seen % every === 0 ? `REVISED ${block}` : block;
    })
    .join('\n\n');
}

describe('the semantic diff, frontend half', () => {
  const results: Record<string, unknown>[] = [];

  afterEach(async () => {
    await server.commands.writeFile(
      `results/blockdiff-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  for (const [label, bytes] of sizes) {
    it(`${label}: an external change is ready to send in under ${BUDGET_MS} ms`, () => {
      const before = generateDocument(bytes, 11);
      const after = revise(before, 6);

      // The reviewed side is parsed once and kept until the reader says
      // they have seen the document, so it is reported, not budgeted.
      const t0 = performance.now();
      const old = flattenBlocks(parser.parse(before), before);
      const reviewedSide = performance.now() - t0;

      const t1 = performance.now();
      const state = createEditorState(after);
      const tree = ensureSyntaxTree(state, after.length, 60_000);
      if (!tree) throw new Error('the parse did not finish');
      const parsed = performance.now() - t1;

      const scan = () => {
        const t = performance.now();
        const fresh = flattenBlocks(ensureSyntaxTree(state, after.length, 1_000) ?? tree, after);
        const { head, tail } = commonBlocks(old, fresh);
        const payload = JSON.stringify([
          old.slice(head, old.length - tail),
          fresh.slice(head, fresh.length - tail),
        ]);
        return { took: performance.now() - t, blocks: fresh.length, payload };
      };
      const first = scan();
      const warm = scan();

      const row = {
        size: label,
        blocks: warm.blocks,
        reviewedSide: round(reviewedSide),
        parse: round(parsed),
        firstScan: round(parsed + first.took),
        scan: round(warm.took),
        payloadBytes: warm.payload.length,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      expect(row.scan, `${label} flatten and send`).toBeLessThan(BUDGET_MS);
    });
  }

  /**
   * What it costs while somebody is typing, which is the case that runs
   * hundreds of times an hour rather than once. Both ends are matched
   * off here, so what crosses the bridge is the paragraph they are in.
   */
  it('sends one paragraph when one paragraph is what changed', () => {
    const before = generateDocument(1_000_000, 11);
    const at = before.indexOf('\n\n', Math.floor(before.length / 2)) + 2;
    const after = `${before.slice(0, at)}typed ${before.slice(at)}`;
    const old = flattenBlocks(parser.parse(before), before);
    const state = createEditorState(after);
    const tree = ensureSyntaxTree(state, after.length, 60_000);
    if (!tree) throw new Error('the parse did not finish');
    const fresh = flattenBlocks(tree, after);
    const { head, tail } = commonBlocks(old, fresh);
    const payload = JSON.stringify([
      old.slice(head, old.length - tail),
      fresh.slice(head, fresh.length - tail),
    ]);
    const row = { size: '1MB typing', blocks: fresh.length, payloadBytes: payload.length };
    results.push(row);
    console.log(JSON.stringify(row));
    expect(payload.length).toBeLessThan(4_000);
  });
});
