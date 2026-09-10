import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from './test-helpers.ts';
import type { Editor } from './view.ts';

describe('createEditor', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = parsedEditor(host, '# Hello\n');
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  it('mounts and reflects edits in the document', () => {
    expect(host.querySelector('.cm-editor')).not.toBeNull();
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: 'world\n' } });
    expect(editor.getDoc()).toBe('# Hello\nworld\n');
  });

  it('leaves the text to the webview\u2019s spell check and to nothing else', () => {
    const content = host.querySelector('.cm-content') as HTMLElement;
    expect(content.spellcheck).toBe(true);
    expect(content.getAttribute('autocorrect')).toBe('off');
    expect(content.getAttribute('autocapitalize')).toBe('off');
  });

  it('setDoc replaces the document', () => {
    editor.setDoc('replaced');
    expect(editor.getDoc()).toBe('replaced');
    expect(host.textContent).toContain('replaced');
  });
});
