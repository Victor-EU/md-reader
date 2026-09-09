/**
 * Give a scrolling page the keyboard.
 *
 * A scroller only answers Page Down, Space and the arrow keys when it has
 * focus, and an element with no `tabindex` can never take it. Read mode
 * and Settings are both `overflow-y: auto` on a plain `<main>`, so until
 * the Phase 1 gate they scrolled with the wheel and not with the keyboard.
 *
 * Every shortcut is bound on the window (`App.svelte`), so nothing else in
 * the app wants this focus — except a field the reader is typing in. The
 * palette and the find bar keep it.
 */
export function focusScroller(el: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  el.focus({ preventScroll: true });
}
