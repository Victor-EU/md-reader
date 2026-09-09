/**
 * What every block of a document is worth in pixels, in a shape that can
 * take a correction to one of them without adding up the rest.
 *
 * Read mode holds a window onto the document (plan WP 2.7), so the space
 * the blocks outside it would have taken is a number rather than an
 * element. That number is added to as the document is walked and
 * corrected as each block is measured, and every scroll asks two
 * questions of it: where a block starts, and which block is at a point on
 * the page. Running totals in a plain array answer both instantly and
 * cost a walk of the whole document on every correction — at a hundred
 * thousand blocks, on every frame of a scroll, which is exactly the walk
 * this exists to avoid.
 *
 * So: a Fenwick tree. Each entry holds the total of a run of blocks
 * ending at it, which makes a correction and a running total the same
 * handful of steps, and finding the block at a point a walk down the
 * same runs.
 */
export class Heights {
  /** The heights themselves, one-based so the tree's arithmetic works. */
  private readonly heights: number[] = [0];
  private readonly tree: number[] = [0];
  private n = 0;
  /** The largest power of two that is not past the end. */
  private mask = 0;

  get length(): number {
    return this.n;
  }

  /** Add a block at the end, the way the document is walked. */
  push(height: number): void {
    this.heights.push(height);
    this.n += 1;
    if ((this.n & (this.n - 1)) === 0) this.mask = this.n;
    // The entry covers the run ending here, which is this block plus the
    // runs already standing under it.
    let total = height;
    for (let step = 1; step < (this.n & -this.n); step <<= 1) {
      total += this.tree[this.n - step] as number;
    }
    this.tree[this.n] = total;
  }

  height(at: number): number {
    return this.heights[at + 1] ?? 0;
  }

  /**
   * Correct one block, once it has been measured.
   *
   * Nothing is worth less than nothing: a negative height would make the
   * running totals stop rising, and everything here is a search through
   * totals that only ever rise.
   */
  set(at: number, height: number): void {
    const to = Math.max(0, height);
    const was = this.heights[at + 1];
    if (was === undefined || was === to) return;
    this.heights[at + 1] = to;
    for (let i = at + 1; i <= this.n; i += i & -i) {
      this.tree[i] = (this.tree[i] as number) + (to - was);
    }
  }

  /** Where block `at` starts: everything before it. */
  upto(at: number): number {
    let total = 0;
    for (let i = Math.min(at, this.n); i > 0; i -= i & -i) total += this.tree[i] as number;
    return total;
  }

  get total(): number {
    return this.upto(this.n);
  }

  /**
   * The block `y` falls in: the last one that starts at or before it.
   *
   * A run of blocks that take no space at all — a folded section — share
   * a point, and the last of them is the answer, which is the one the
   * blocks after it follow.
   */
  indexAt(y: number): number {
    let at = 0;
    let rest = y;
    for (let step = this.mask; step > 0; step >>= 1) {
      const next = at + step;
      if (next <= this.n && (this.tree[next] as number) <= rest) {
        rest -= this.tree[next] as number;
        at = next;
      }
    }
    return Math.max(0, Math.min(at, this.n - 1));
  }
}
