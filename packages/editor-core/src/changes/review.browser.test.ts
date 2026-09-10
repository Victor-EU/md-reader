import { undo } from '@codemirror/commands';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setReviewEffect } from '../state.ts';
import { parsedEditor } from '../test-helpers.ts';
import type { Editor } from '../view.ts';
import { changes, setChanges } from './markers.ts';
import type { ChangePart, ChangeRecord } from './records.ts';

const doc = 'one\n\nthe cat stood up\n\nthree\n';

/** Where "the cat stood up" is. */
const from = 5;
const to = 21;

function changed(parts: ChangePart[], revert = true): ChangeRecord {
  return {
    id: 'changed:5:21',
    kind: 'changed',
    from,
    to,
    parts,
    revert: revert ? [{ from, to, insert: 'the cat sat down' }] : [],
  };
}

describe('Review mode', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const panels = () => [...host.querySelectorAll('.mdr-review')];
  const show = (...records: ChangeRecord[]) => {
    editor.view.dispatch({ effects: setChanges.of(records) });
  };

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 500px; width: 700px;';
    document.body.appendChild(host);
    editor = parsedEditor(host, doc);
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('draws nothing until it is asked for', () => {
    show(changed([{ kind: 'gone', text: 'sat down' }]));
    expect(panels()).toHaveLength(0);
  });

  it('draws a panel above the change, with both versions in it', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(
      changed([
        { kind: 'same', text: 'the cat ' },
        { kind: 'gone', text: 'sat down' },
        { kind: 'new', text: 'stood up' },
      ]),
    );
    const panel = panels()[0];
    expect(panel?.querySelector('.mdr-review-label')?.textContent).toBe('Changed');
    expect(panel?.querySelector('del')?.textContent).toBe('sat down');
    expect(panel?.querySelector('ins')?.textContent).toBe('stood up');
  });

  it('takes the panels away again when Review is turned off', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(changed([{ kind: 'new', text: 'stood up' }]));
    expect(panels()).toHaveLength(1);
    editor.view.dispatch({ effects: setReviewEffect(false) });
    expect(panels()).toHaveLength(0);
    // The change itself is still known: only the drawing went.
    expect(changes(editor.view.state)).toHaveLength(1);
  });

  it('puts the change back when Revert is pressed, and forgets it', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(changed([{ kind: 'new', text: 'stood up' }]));
    const button = host.querySelector<HTMLButtonElement>('.mdr-review-revert');
    button?.click();
    expect(editor.view.state.doc.toString()).toBe('one\n\nthe cat sat down\n\nthree\n');
    expect(changes(editor.view.state)).toHaveLength(0);
    expect(panels()).toHaveLength(0);
  });

  /** One transaction, so one undo takes the whole revert back. */
  it('is undone in one step', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(changed([{ kind: 'new', text: 'stood up' }]));
    host.querySelector<HTMLButtonElement>('.mdr-review-revert')?.click();
    expect(editor.view.state.doc.toString()).toBe('one\n\nthe cat sat down\n\nthree\n');
    undo(editor.view);
    expect(editor.view.state.doc.toString()).toBe(doc);
  });

  it('says so rather than offering a button it cannot honour', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show({ ...changed([], false), kind: 'moved' });
    expect(host.querySelector('.mdr-review-revert')).toBeNull();
    expect(host.querySelector('.mdr-review-note')?.textContent).toContain('nothing left');
  });

  /**
   * A panel anchored inside a replaced block is drawn nowhere, so it
   * goes above the widget instead. Without this a changed table row has
   * no panel at all in Edit mode.
   */
  it('draws the panel above a table live preview has replaced', async () => {
    editor.destroy();
    const table = 'para\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntail\n';
    editor = parsedEditor(host, table);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(host.querySelectorAll('table')).toHaveLength(1);
    const row = table.indexOf('| 1 | 2 |');
    editor.view.dispatch({ effects: setReviewEffect(true) });
    editor.view.dispatch({
      effects: setChanges.of([
        {
          id: 'changed:row',
          kind: 'changed',
          from: row,
          to: row + 9,
          parts: [{ kind: 'new', text: '1' }],
          revert: [],
        },
      ]),
    });
    const panel = panels()[0];
    expect(panel).toBeDefined();
    // Above the table, not inside it and not after it.
    const above = panel?.getBoundingClientRect().bottom ?? 0;
    const drawn = host.querySelector('table')?.getBoundingClientRect().top ?? 0;
    expect(above).toBeLessThanOrEqual(drawn + 1);
  });

  /**
   * A panel is a block widget, and the editor takes a block's height from
   * the box of the element it was handed. A vertical margin is outside
   * that box, so each panel would push the text below it down by an amount
   * the height map never hears about, and down a document full of changes
   * those add up until a click lands on the wrong line. The Phase 3 gate
   * found and fixed exactly this in the preview block widgets; a panel is
   * the same rule, and like that one this asserts the consequence rather
   * than the rule.
   */
  it('puts a click below a run of panels on the line under the pointer', () => {
    editor.destroy();
    const words = ['one', 'two', 'three', 'four', 'five', 'six'];
    const text = `${[...words, 'the sentence at the bottom'].join('\n\n')}\n`;
    editor = parsedEditor(host, text);
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(
      ...words.map((word) => {
        const at = text.indexOf(word);
        return {
          id: `changed:${word}`,
          kind: 'changed' as const,
          from: at,
          to: at + word.length,
          parts: [{ kind: 'new' as const, text: word }],
          revert: [],
        };
      }),
    );
    expect(panels()).toHaveLength(words.length);
    const at = text.indexOf('the sentence at the bottom') + 1;
    const box = editor.view.coordsAtPos(at);
    expect(box).not.toBeNull();
    if (!box) return;
    const got = editor.view.posAtCoords({ x: box.left + 1, y: (box.top + box.bottom) / 2 });
    const line = (pos: number) => editor.view.state.doc.lineAt(pos).number;
    expect(line(got ?? 0)).toBe(line(at));
    // `estimatedHeight` is 26 plus 21 a body line, which was the space a
    // panel took up including its margins; the same space as padding keeps
    // the estimate honest, which is what a block outside the viewport is
    // drawn at.
    const drawn = panels()[0]?.getBoundingClientRect().height ?? 0;
    expect(Math.abs(drawn - 47)).toBeLessThan(2);
  });

  it('marks the change the cursor is standing in', () => {
    editor.view.dispatch({ effects: setReviewEffect(true) });
    show(changed([{ kind: 'new', text: 'stood up' }]));
    expect(host.querySelectorAll('.mdr-review-current')).toHaveLength(0);
    editor.view.dispatch({ selection: { anchor: from + 2 } });
    expect(host.querySelectorAll('.mdr-review-current')).toHaveLength(1);
  });
});
