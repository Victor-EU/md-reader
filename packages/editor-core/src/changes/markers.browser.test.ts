import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../test-helpers.ts';
import type { Editor } from '../view.ts';
import { changes, changesField, dropChange, setChanges } from './markers.ts';
import type { ChangeKind, ChangeRecord } from './records.ts';

const doc = 'one\ntwo\nthree\nfour\nfive\n';

/** A record as the shell makes them, with only what the margin reads. */
function record(kind: ChangeKind, from: number, to: number): ChangeRecord {
  return { id: `${kind}:${from}:${to}`, kind, from, to, parts: [], revert: [] };
}

describe('the change markers', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const marks = (kind: string) => host.querySelectorAll(`.cm-change-${kind}`).length;
  const bar = (kind: string) =>
    host.querySelector(`.cm-change-${kind}`)?.getBoundingClientRect() ?? null;

  /** What the shell does with what the alignment came back as. */
  const show = (...records: ChangeRecord[]) => {
    editor.view.dispatch({ effects: setChanges.of(records) });
  };

  /**
   * The bars are measured rather than decorated, so they are drawn in
   * the view's measure phase, which is a frame away.
   */
  const drawn = () => new Promise((resolve) => requestAnimationFrame(resolve));

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 400px; width: 600px;';
    document.body.appendChild(host);
    editor = parsedEditor(host, doc);
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('draws nothing for a document that has not changed', async () => {
    show();
    await drawn();
    expect(host.querySelectorAll('.cm-change').length).toBe(0);
  });

  /** One bar covering the block, however many lines it turned out to be. */
  it('draws one bar down the whole of an added block', async () => {
    show(record('added', 8, 17));
    await drawn();
    expect(marks('added')).toBe(1);
    expect(marks('changed')).toBe(0);
    expect(bar('added')?.height).toBeGreaterThan(bar('added')?.width ?? 0);
  });

  it('marks a changed line', async () => {
    show(record('changed', 4, 7));
    await drawn();
    expect(marks('changed')).toBe(1);
  });

  it('marks a deletion on the line that closed over it', async () => {
    show(record('removed', 4, 4));
    await drawn();
    expect(marks('removed')).toBe(1);
  });

  it('marks text that arrived from somewhere else in the document', async () => {
    show(record('moved', 0, 7));
    await drawn();
    expect(marks('moved')).toBe(1);
  });

  it('draws two runs of different kinds at once', async () => {
    show(record('added', 0, 3), record('changed', 14, 18));
    await drawn();
    expect(marks('added')).toBe(1);
    expect(marks('changed')).toBe(1);
  });

  /**
   * A deletion has no text of its own, so it is a notch: wider than it is
   * tall, where a change is taller than it is wide.
   */
  it('draws a deletion as a notch and a change as a bar', async () => {
    show(record('removed', 4, 4));
    await drawn();
    const notch = bar('removed');
    expect(notch?.width).toBeGreaterThan(notch?.height ?? 0);
  });

  /** Two blocks that touch read as one bar because they abut. */
  it('draws a bar for each change', async () => {
    show(record('changed', 0, 3), record('changed', 4, 7));
    await drawn();
    expect(marks('changed')).toBe(2);
    const [first, second] = [...host.querySelectorAll('.cm-change')].map((el) =>
      el.getBoundingClientRect(),
    );
    expect(first?.bottom).toBeCloseTo(second?.top ?? 0, 0);
  });

  /**
   * The diff runs on a pause, so between the keystroke and the next one
   * the records have to move with the text themselves.
   */
  it('keeps a record beside its text when text is inserted above it', async () => {
    show(record('changed', 18, 22));
    await drawn();
    const at = () => changes(editor.view.state)[0]?.from;
    expect(at()).toBe(18);
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'a new first line\n' } });
    expect(at()).toBe(18 + 'a new first line\n'.length);
  });

  /**
   * The reason the bars are measured rather than decorated: CodeMirror
   * draws no lines under a block widget, so a mark attached to one of
   * those lines was drawn nowhere (plan WP 2.2's open hole).
   */
  it('draws a bar beside a block live preview has replaced', async () => {
    editor.destroy();
    const table = 'para\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntail\n';
    editor = parsedEditor(host, table);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.querySelectorAll('table')).toHaveLength(1);
    const row = table.indexOf('| 1 | 2 |');
    show(record('changed', row, row + 9));
    await drawn();
    expect(marks('changed')).toBe(1);
  });

  it('forgets a change that has been put back', async () => {
    show(record('changed', 4, 7), record('added', 8, 13));
    await drawn();
    editor.view.dispatch({ effects: dropChange.of('changed:4:7') });
    await drawn();
    expect(editor.view.state.field(changesField).map((r) => r.id)).toEqual(['added:8:13']);
    expect(marks('changed')).toBe(0);
  });
});
