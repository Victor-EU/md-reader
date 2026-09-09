/**
 * Whether the window is full screen, kept current (plan WP 2.8).
 *
 * The strip keeps a corner clear for the window's own three buttons, and
 * macOS takes them back in full screen, so the room has to go with them.
 * Nothing tells the page when that happens: the only signal is the
 * window changing size, and asking the OS at that moment is not enough
 * on the way out. Entering full screen is flagged before the window
 * resizes; leaving it is flagged at the end of the animation that
 * follows the last resize the page hears about, and a single question
 * asked then still comes back `true`.
 *
 * So the question is asked once the window has stopped changing size,
 * and a few more times while the animation finishes. A live resize
 * restarts the run rather than adding to it, so dragging an edge asks
 * once, at the end.
 */
export const SETTLING = [0, 150, 600, 1200] as const;

export function watchFullScreen(
  resized: (listener: () => void) => void,
  ask: () => Promise<boolean>,
  set: (full: boolean) => void,
): void {
  let pending: ReturnType<typeof setTimeout>[] = [];
  const answer = () => {
    void ask().then(set);
  };
  answer();
  resized(() => {
    for (const timer of pending) clearTimeout(timer);
    pending = SETTLING.map((delay) => setTimeout(answer, delay));
  });
}
