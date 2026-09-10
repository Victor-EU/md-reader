import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../test-helpers.ts';
import type { Editor } from '../view.ts';
import { addConflicts, conflictRegion, conflicts } from './state.ts';

const doc = 'one\ntwo\nthree\n';

describe('the conflict widget', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const raise = (from: number, to: number, theirs: string) => {
    editor.view.dispatch({ effects: addConflicts.of([conflictRegion(from, to, theirs)]) });
  };
  const find = (selector: string) => host.querySelector(selector) as HTMLElement | null;
  const press = (choice: string) => {
    const button = find(`.mdr-conflict-choice[data-choice="${choice}"]`);
    if (!button) throw new Error(`no ${choice} button`);
    button.click();
  };

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

  it('draws nothing until a write conflicts', () => {
    expect(host.querySelectorAll('.mdr-conflict').length).toBe(0);
  });

  it('bands our version and shows theirs below it', () => {
    raise(4, 8, 'TWO\n');
    expect(find('.mdr-conflict-head')?.textContent).toBe('Mine');
    expect(find('.mdr-conflict-theirs')?.textContent).toBe('TWO');
    expect(host.querySelectorAll('.cm-conflict-mine').length).toBe(1);
  });

  it('bands every line of a hunk that is more than one', () => {
    raise(0, 14, 'all of it\n');
    expect(host.querySelectorAll('.cm-conflict-mine').length).toBe(3);
  });

  /** Their version is not text in the document, whatever it looks like. */
  it('leaves the document alone while the question is open', () => {
    raise(4, 8, 'TWO\n');
    expect(editor.getDoc()).toBe(doc);
  });

  it('keeps mine when the button says so, and takes the panel away', () => {
    raise(4, 8, 'TWO\n');
    press('mine');
    expect(editor.getDoc()).toBe(doc);
    expect(host.querySelectorAll('.mdr-conflict').length).toBe(0);
    expect(conflicts(editor.view.state)).toEqual([]);
  });

  it('takes theirs when the button says so', () => {
    raise(4, 8, 'TWO\n');
    press('theirs');
    expect(editor.getDoc()).toBe('one\nTWO\nthree\n');
    expect(host.querySelectorAll('.mdr-conflict').length).toBe(0);
  });

  it('says so when their version is a deletion', () => {
    raise(4, 8, '');
    expect(find('.mdr-conflict-note')?.textContent).toBe('they deleted these lines');
    expect(find('.mdr-conflict-theirs')).toBe(null);
    press('theirs');
    expect(editor.getDoc()).toBe('one\nthree\n');
  });

  it('says so when ours is the deletion', () => {
    editor.view.dispatch({ changes: { from: 4, to: 8 } });
    raise(4, 4, 'TWO\n');
    expect(find('.mdr-conflict-head')?.textContent).toContain('you deleted these lines');
    press('theirs');
    expect(editor.getDoc()).toBe('one\nTWO\nthree\n');
  });

  /**
   * The panel is a control, not a place to put the cursor. Pressing a
   * button must not move the selection to the widget and scroll the
   * reader away from what they were deciding about.
   */
  it('leaves the selection where the reader had it', () => {
    editor.view.dispatch({ selection: { anchor: 1 } });
    raise(8, 14, 'THREE\n');
    press('mine');
    expect(editor.view.state.selection.main.head).toBe(1);
  });

  it('draws one panel for each open question', () => {
    editor.view.dispatch({
      effects: addConflicts.of([conflictRegion(0, 4, 'ONE\n'), conflictRegion(8, 14, 'THREE\n')]),
    });
    expect(host.querySelectorAll('.mdr-conflict-foot').length).toBe(2);
    press('theirs');
    expect(editor.getDoc()).toBe('ONE\ntwo\nthree\n');
    expect(host.querySelectorAll('.mdr-conflict-foot').length).toBe(1);
  });

  /** The panel stays put while the reader goes on editing their side. */
  it('follows the text it is about', () => {
    raise(8, 14, 'THREE\n');
    const before = find('.mdr-conflict-foot');
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'a new first line\n' } });
    expect(find('.mdr-conflict-foot')).toBe(before);
    press('theirs');
    expect(editor.getDoc()).toBe('a new first line\none\ntwo\nTHREE\n');
  });
});

/**
 * Two questions with nothing left between them, which is what deleting
 * the lines that separated them leaves. Each panel has to stay under the
 * version it is about.
 */
describe('two conflicts that have come together', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 400px; width: 600px;';
    document.body.appendChild(host);
    editor = parsedEditor(host, 'one\nbetween\nthree\n');
    editor.view.dispatch({
      effects: addConflicts.of([conflictRegion(0, 4, 'ONE\n'), conflictRegion(12, 18, 'THREE\n')]),
    });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('keeps each panel under the version it is about', () => {
    editor.view.dispatch({ changes: { from: 4, to: 12 } });
    expect(editor.getDoc()).toBe('one\nthree\n');
    const drawn = [...host.querySelectorAll('.mdr-conflict')].map((el) =>
      el.classList.contains('mdr-conflict-head') ? 'head' : 'foot',
    );
    expect(drawn).toEqual(['head', 'foot', 'head', 'foot']);
  });
});
