import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The bench is on a machine shared with other work (ADR 0038). */
    sharedRunner: boolean;
  }
}

/**
 * What a time budget is multiplied by on a shared runner (ADR 0038).
 *
 * The budgets in these files were measured on the machine they were
 * written on, with room for a slower one. GitHub's macOS runner is three
 * cores shared with other work, and over the eleven runs recorded before
 * this was written it measured anything from that machine's numbers to
 * ten times them, from one run of the same build to the next. At worst it
 * measured three times a budget: blockdiff's megabyte scan in WebKit, 137
 * ms against 45. Plan 7.4 has a shared runner fail on a regression of
 * half as much again and not on a busy machine, so five is that worst
 * ratio and half as much again, rounded up.
 */
const SHARED_RUNNER = 5;

/**
 * A time budget in milliseconds, as it stands on the machine running
 * the bench. Counts — calls to Rust, blocks in the page, bytes sent —
 * are the same on any machine and are never passed through this.
 */
export function ms(budget: number): number {
  return inject('sharedRunner') ? budget * SHARED_RUNNER : budget;
}
