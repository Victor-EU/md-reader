import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../test-helpers.ts';
import type { Editor } from '../view.ts';

const doc = [
  '# Title',
  '',
  '**bold** and ==hl== and `code`',
  '',
  '- item',
  '- [ ] task',
  '',
  '```js',
  'let x = 1;',
  '```',
  '',
].join('\n');

describe('livePreview', () => {
  let host: HTMLDivElement;
  let editor: Editor;

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

  it('hides syntax and styles content', () => {
    expect(host.querySelector('.mdr-h1')?.textContent).toBe('Title');
    expect(host.querySelector('.mdr-strong')?.textContent).toBe('bold');
    expect(host.querySelector('.mdr-mark')?.textContent).toBe('hl');
    expect(host.querySelector('.mdr-code')?.textContent).toBe('code');
    expect(host.querySelectorAll('.mdr-bullet')).toHaveLength(1);
    expect(host.querySelectorAll('.mdr-fence')).toHaveLength(3);
    expect(host.querySelectorAll('.mdr-fence-dim')).toHaveLength(2);
    expect(host.querySelector('.mdr-li')?.getAttribute('style')).toContain('text-indent: -2ch');
  });

  it('reveals a heading when the cursor moves onto it and re-hides on leaving', () => {
    editor.view.dispatch({ selection: { anchor: 3 } });
    expect(host.querySelector('.mdr-h1')?.textContent).toBe('# Title');
    expect(host.querySelector('.mdr-h1 .mdr-syntax')).not.toBeNull();
    editor.view.dispatch({ selection: { anchor: doc.length } });
    expect(host.querySelector('.mdr-h1')?.textContent).toBe('Title');
  });

  it('undims fence lines while the cursor is inside the block', () => {
    const inside = doc.indexOf('let x');
    editor.view.dispatch({ selection: { anchor: inside } });
    expect(host.querySelectorAll('.mdr-fence-dim')).toHaveLength(0);
    expect(host.querySelectorAll('.mdr-fence-active')).toHaveLength(2);
  });

  it('toggles a task with a one-character change when the checkbox is clicked', () => {
    const box = host.querySelector<HTMLInputElement>('input.mdr-checkbox');
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
    box?.click();
    expect(editor.getDoc()).toBe(doc.replace('- [ ] task', '- [x] task'));
    expect(host.querySelector<HTMLInputElement>('input.mdr-checkbox')?.checked).toBe(true);
    host.querySelector<HTMLInputElement>('input.mdr-checkbox')?.click();
    expect(editor.getDoc()).toBe(doc);
  });

  it('skips the bullet when moving the cursor with the keyboard', () => {
    const lineStart = doc.indexOf('- item');
    editor.view.dispatch({ selection: { anchor: lineStart } });
    const moved = editor.view.moveByChar(editor.view.state.selection.main, true);
    expect(moved.head).toBe(lineStart + 2);
  });

  it('switches to source and back without touching the document', () => {
    editor.setMode('source');
    expect(host.querySelector('.mdr-h1')).toBeNull();
    expect(host.textContent).toContain('# Title');
    expect(editor.getDoc()).toBe(doc);
    editor.setMode('edit');
    expect(host.querySelector('.mdr-h1')?.textContent).toBe('Title');
  });
});
