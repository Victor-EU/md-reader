import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../test-helpers.ts';
import type { Editor } from '../view.ts';

const doc = [
  'A note about ==the sprint== <!-- note: too ambitious --> and more.',
  '',
  '<!-- question: does this still matter -->',
  'The block the question is about.',
  '',
  'Nothing to say here <!-- todo: not one of the six words -->.',
  '',
].join('\n');

describe('comment notes', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  const notes = () => Array.from(host.querySelectorAll<HTMLElement>('.mdr-comment-widget'));

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = parsedEditor(host, doc);
    editor.view.dispatch({ selection: { anchor: doc.length } });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('draws a note for each comment the vocabulary knows', () => {
    // The chip is the kind then the words, with no separator of its own.
    expect(notes().map((el) => [el.dataset.kind, el.textContent])).toEqual([
      ['note', 'notetoo ambitious'],
      ['question', 'questiondoes this still matter'],
    ]);
    // A comment outside the vocabulary is left as the dimmed text it is.
    expect(host.textContent).toContain('<!-- todo: not one of the six words -->');
  });

  it('carries the anchor of an inline note and none for a lone one', () => {
    const [inline, block] = notes();
    expect([inline?.dataset.anchorFrom, inline?.dataset.anchorTo]).toEqual([
      String(doc.indexOf('==the sprint==')),
      String(doc.indexOf('==the sprint==') + '==the sprint=='.length),
    ]);
    expect([block?.dataset.anchorFrom, block?.dataset.anchorTo]).toEqual([
      String(doc.indexOf('The block')),
      String(doc.indexOf('The block') + 'The block the question is about.'.length),
    ]);
  });

  it('highlights the anchor while the pointer is on the note', () => {
    const note = notes()[0] as HTMLElement;
    expect(host.querySelector('.mdr-anchor-hover')).toBeNull();
    note.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(host.querySelector('.mdr-anchor-hover')?.textContent).toBe('the sprint');
    note.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(host.querySelector('.mdr-anchor-hover')).toBeNull();
  });

  it('gives the source back when the selection touches the comment', () => {
    editor.view.dispatch({ selection: { anchor: doc.indexOf('too ambitious') } });
    expect(notes()).toHaveLength(1);
    expect(host.textContent).toContain('<!-- note: too ambitious -->');
  });

  it('leaves the buffer untouched', () => {
    expect(editor.getDoc()).toBe(doc);
  });
});
