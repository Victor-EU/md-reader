import { describe, expect, it } from 'vitest';
import { Heights } from './heights.ts';

/** The same answers a plain array of running totals would give. */
function plain(values: number[]) {
  return {
    upto: (at: number) => values.slice(0, at).reduce((a, b) => a + b, 0),
    indexAt: (y: number) => {
      let found = 0;
      let total = 0;
      for (const [i, value] of values.entries()) {
        if (total <= y) found = i;
        total += value;
      }
      return found;
    },
  };
}

describe('the heights of a document', () => {
  it('adds up what is before a block, and finds the block at a point', () => {
    const values = [40, 25, 25, 120, 25, 25, 60, 25];
    const heights = new Heights();
    for (const value of values) heights.push(value);
    expect(heights.length).toBe(values.length);
    expect(heights.total).toBe(345);
    for (let at = 0; at <= values.length; at++) {
      expect(heights.upto(at), `up to ${at}`).toBe(plain(values).upto(at));
    }
    for (let y = -20; y < 380; y += 7) {
      expect(heights.indexAt(y), `at ${y}`).toBe(plain(values).indexAt(y));
    }
  });

  it('takes a correction to one block without disturbing the others', () => {
    const heights = new Heights();
    for (const value of [10, 20, 30, 40]) heights.push(value);
    heights.set(1, 200);
    expect(heights.height(1)).toBe(200);
    expect(heights.upto(1)).toBe(10);
    expect(heights.upto(2)).toBe(210);
    expect(heights.total).toBe(280);
    expect(heights.indexAt(209)).toBe(1);
    expect(heights.indexAt(210)).toBe(2);
  });

  /**
   * A folded section is a run of blocks sharing one point on the page.
   * The last of them is the answer, which is the one the blocks after it
   * follow: the window starts at what the reader can see.
   */
  it('answers for a run of blocks that take no space', () => {
    const values = [50, 0, 0, 0, 50];
    const heights = new Heights();
    for (const value of values) heights.push(value);
    expect(heights.indexAt(50)).toBe(4);
    expect(heights.indexAt(49)).toBe(0);
    expect(heights.indexAt(0)).toBe(0);
    expect(heights.indexAt(50)).toBe(plain(values).indexAt(50));
    expect(heights.total).toBe(100);
  });

  /** However long the document, and whichever heights are corrected. */
  it('agrees with the running totals it stands in for, over a long document', () => {
    const values: number[] = [];
    const heights = new Heights();
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 200;
    };
    for (let i = 0; i < 5000; i++) {
      const value = next();
      values.push(value);
      heights.push(value);
    }
    for (let i = 0; i < 500; i++) {
      const at = next() % values.length;
      const value = next();
      values[at] = value;
      heights.set(at, value);
    }
    const reference = plain(values);
    expect(heights.total).toBe(reference.upto(values.length));
    for (const at of [0, 1, 137, 2500, 4999, 5000]) {
      expect(heights.upto(at), `up to ${at}`).toBe(reference.upto(at));
    }
    for (const y of [0, 1000, 50_000, reference.upto(values.length) - 1]) {
      expect(heights.indexAt(y), `at ${y}`).toBe(reference.indexAt(y));
    }
  });
});
