import { Text } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../view.ts';
import { lineChanges } from './lines.ts';
import { changesField, setChanges } from './markers.ts';

const before = 'one\ntwo\nthree\nfour\nfive\n';

describe('the change markers', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const marks = (kind: string) => host.querySelectorAll(`.cm-change-${kind}`).length;

  /** What the shell does: diff against the last reviewed version, hand it over. */
  const show = (after: string) => {
    editor.view.dispatch({
      changes: { from: 0, to: editor.view.state.doc.length, insert: after },
    });
    editor.view.dispatch({
      effects: setChanges.of(lineChanges(Text.of(before.split('\n')), editor.view.state.doc)),
    });
  };

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'height: 400px; width: 600px;';
    document.body.appendChild(host);
    editor = createEditor(host, before);
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('draws nothing for a document that has not changed', () => {
    show(before);
    expect(host.querySelectorAll('.cm-change').length).toBe(0);
  });

  it('marks every line of an added run', () => {
    show('one\ntwo\nnew\nalso new\nthree\nfour\nfive\n');
    expect(marks('added')).toBe(2);
    expect(marks('changed')).toBe(0);
  });

  it('marks a changed line', () => {
    show('one\nTWO\nthree\nfour\nfive\n');
    expect(marks('changed')).toBe(1);
  });

  it('marks a deletion on the line that closed over it', () => {
    show('one\nfour\nfive\n');
    expect(marks('removed')).toBe(1);
  });

  /**
   * The diff runs on a pause, so between the keystroke and the next one
   * the markers have to move with the text themselves.
   */
  it('keeps a marker beside its line when text is inserted above it', () => {
    show('one\ntwo\nthree\nfour\nFIVE\n');
    const line = () => {
      const state = editor.view.state;
      return state.doc.lineAt(state.field(changesField).iter().from).number;
    };
    expect(line()).toBe(5);
    editor.view.dispatch({ changes: { from: 0, to: 0, insert: 'a new first line\n' } });
    expect(line()).toBe(6);
  });
});
