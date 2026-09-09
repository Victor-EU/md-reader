import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLING, watchFullScreen } from './titlebar.ts';

let listener: (() => void) | null;
let answers: boolean[];
let asked: number;
let seen: boolean[];

function watch(replies: boolean[]) {
  answers = replies;
  asked = 0;
  seen = [];
  listener = null;
  watchFullScreen(
    (fn) => {
      listener = fn;
    },
    () => {
      const reply = answers[asked] ?? answers.at(-1) ?? false;
      asked += 1;
      return Promise.resolve(reply);
    },
    (full) => seen.push(full),
  );
}

/** Let the timers run out and the promises they made settle. */
async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('watching for full screen', () => {
  it('asks once to begin with', async () => {
    watch([false]);
    await settle(0);
    expect(seen).toEqual([false]);
  });

  /**
   * The window has changed size, which is the only news the page gets of
   * a full-screen transition. Asking once is not enough on the way out:
   * macOS is still saying yes at that point.
   */
  it('asks again as the window settles, and takes the last answer', async () => {
    watch([true, true, false, false, false]);
    await settle(0);
    expect(seen).toEqual([true]);
    (listener as unknown as () => void)();
    await settle(SETTLING.at(-1) as number);
    expect(asked).toBe(1 + SETTLING.length);
    expect(seen.at(-1)).toBe(false);
  });

  it('starts the run again rather than piling one on another', async () => {
    watch([false]);
    await settle(0);
    const resize = listener as unknown as () => void;
    resize();
    await settle(100);
    resize();
    resize();
    await settle(SETTLING.at(-1) as number);
    // One at the start, one from the first run's immediate question, and
    // one run's worth at the end: the questions still outstanding when a
    // resize arrives are dropped, so dragging an edge asks once, not once
    // per pixel.
    expect(asked).toBe(2 + SETTLING.length);
  });
});
