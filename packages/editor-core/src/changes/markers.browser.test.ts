import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../view.ts';
import { changesField, type LineChange, setChanges } from './markers.ts';

const doc = 'one\ntwo\nthree\nfour\nfive\n';

describe('the change markers', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const marks = (kind: string) => host.querySelectorAll(`.cm-change-${kind}`).length;

  /** What the shell does with what the alignment came back as. */
  const show = (...runs: LineChange[]) => {
    editor.view.dispatch({ effects: setChanges.of(runs) });
  };

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 400px; width: 600px;';
    document.body.appendChild(host);
    editor = createEditor(host, doc);
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('draws nothing for a document that has not changed', () => {
    show();
    expect(host.querySelectorAll('.cm-change').length).toBe(0);
  });

  it('marks every line of an added run', () => {
    show({ from: 3, to: 5, kind: 'added' });
    expect(marks('added')).toBe(2);
    expect(marks('changed')).toBe(0);
  });

  it('marks a changed line', () => {
    show({ from: 2, to: 3, kind: 'changed' });
    expect(marks('changed')).toBe(1);
  });

  it('marks a deletion on the line that closed over it', () => {
    show({ from: 2, to: 2, kind: 'removed' });
    expect(marks('removed')).toBe(1);
  });

  it('marks text that arrived from somewhere else in the document', () => {
    show({ from: 1, to: 3, kind: 'moved' });
    expect(marks('moved')).toBe(2);
  });

  it('draws two runs of different kinds at once', () => {
    show({ from: 1, to: 2, kind: 'added' }, { from: 4, to: 5, kind: 'changed' });
    expect(marks('added')).toBe(1);
    expect(marks('changed')).toBe(1);
  });

  /**
   * The diff runs on a pause, so between the keystroke and the next one
   * the markers have to move with the text themselves.
   */
  it('keeps a marker beside its line when text is inserted above it', () => {
    show({ from: 5, to: 6, kind: 'changed' });
    const line = () => {
      const state = editor.view.state;
      return state.doc.lineAt(state.field(changesField).iter().from).number;
    };
    expect(line()).toBe(5);
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'a new first line\n' } });
    expect(line()).toBe(6);
  });
});
