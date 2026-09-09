import { afterEach, describe, expect, it } from 'vitest';
import { focusScroller } from './scroller.ts';

/**
 * The Phase 1 gate found Read mode and Settings scrolling with the wheel
 * and not with the keyboard: both are `overflow-y: auto` on a `<main>`,
 * and a scroller answers Page Down only when it has focus.
 */
describe('focusScroller', () => {
  const made: HTMLElement[] = [];

  function page(): HTMLElement {
    const el = document.createElement('main');
    el.tabIndex = -1;
    el.style.cssText = 'height: 40px; overflow-y: auto;';
    const tall = document.createElement('div');
    tall.style.height = '400px';
    el.appendChild(tall);
    document.body.appendChild(el);
    made.push(el);
    return el;
  }

  afterEach(() => {
    for (const el of made.splice(0)) el.remove();
  });

  it('gives the page the focus its scrolling needs', () => {
    const el = page();
    focusScroller(el);
    expect(document.activeElement).toBe(el);
  });

  it('leaves a field the reader is typing in alone', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    made.push(input);
    input.focus();
    focusScroller(page());
    expect(document.activeElement).toBe(input);
  });

  it('does not scroll the page by focusing it', () => {
    const el = page();
    el.scrollTop = 100;
    focusScroller(el);
    expect(el.scrollTop).toBe(100);
  });
});
