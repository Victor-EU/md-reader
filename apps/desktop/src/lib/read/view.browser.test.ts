import { createEditorState } from '@markdown/editor-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadView } from './view.ts';

/**
 * A place asked for before the walk has reached it, which is what a tab
 * coming back to Read mode does: the view is built with a screenful
 * walked and drawn, and is sent at once to wherever the reader was.
 *
 * Nothing here waits. The idle walk is what hid this on a fast machine,
 * where it has usually been all the way down by the time anybody asks;
 * a runner with a slow core had not, and the reader came back near the
 * top instead.
 */
describe('a place further down than the walk has been', () => {
  // Several times what the first screenful's walk takes down, which
  // stops at a screenful's height once it has parsed twenty thousand
  // characters.
  const LONG = Array.from(
    { length: 400 },
    (_, i) => `## Heading ${i}\n\n${'word '.repeat(50)}`,
  ).join('\n\n');
  let host: HTMLDivElement;
  let view: ReadView | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 600px; width: 800px; overflow: auto; position: relative;';
    document.body.appendChild(host);
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    host.remove();
  });

  it('is put at the top of the window, not where the drawn page ended', () => {
    const offset = LONG.indexOf('## Heading 300');
    view = new ReadView({ parent: host, state: createEditorState(LONG) });
    view.scrollToOffset(offset);
    expect(view.topOffset()).toBe(offset);
  });

  it('is put as near the top as the end of the document allows', () => {
    const offset = LONG.indexOf('## Heading 399');
    view = new ReadView({ parent: host, state: createEditorState(LONG) });
    view.scrollToOffset(offset);
    // The last heading cannot reach the top, because the page ends less
    // than a screenful under it. It is on screen, which is what was asked.
    const heading = [...host.querySelectorAll('h2')].find((each) =>
      each.textContent?.includes('Heading 399'),
    ) as HTMLElement;
    const frame = host.getBoundingClientRect();
    expect(heading.getBoundingClientRect().top).toBeGreaterThanOrEqual(frame.top);
    expect(heading.getBoundingClientRect().bottom).toBeLessThanOrEqual(frame.bottom);
  });
});
