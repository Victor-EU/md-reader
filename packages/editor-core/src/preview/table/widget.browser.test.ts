import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../../view.ts';

const doc = [
  'Intro line',
  '',
  '| Name | Note |',
  '|---|---|',
  '| a | **b** |',
  '| 日本 | c \\| d |',
  '',
  'After line',
  '',
].join('\n');

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('table widget', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = createEditor(host, doc);
    editor.view.dispatch({ selection: { anchor: 0 } });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  const table = () => host.querySelector<HTMLTableElement>('table.mdr-table-widget');
  const cell = (r: number, c: number) =>
    table()?.querySelector<HTMLElement>(`[data-row="${r}"][data-col="${c}"]`) ?? null;
  const nested = () => host.querySelector<HTMLElement>('.mdr-cell-active .cm-content');

  async function activate(r: number, c: number) {
    const el = cell(r, c);
    expect(el).not.toBeNull();
    el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
    await tick();
  }

  it('renders a table with inline markdown and resolved escapes', () => {
    const t = table();
    expect(t).not.toBeNull();
    expect(t?.querySelectorAll('thead th')).toHaveLength(2);
    expect(t?.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(cell(1, 1)?.innerHTML).toBe('<strong>b</strong>');
    expect(cell(2, 1)?.textContent).toBe('c | d');
    expect(host.textContent).not.toContain('|---|');
  });

  it('shows source when the cursor is inside the table and the widget again when it leaves', () => {
    editor.view.dispatch({ selection: { anchor: doc.indexOf('| a |') + 2 } });
    expect(table()).toBeNull();
    expect(host.textContent).toContain('|---|');
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(table()).not.toBeNull();
  });

  it('edits a cell in place with exact byte changes', async () => {
    await activate(1, 0);
    expect(nested()).not.toBeNull();
    expect(nested()?.textContent).toBe('a');
    const view = editor.view;
    const active = cell(1, 0);
    expect(active?.classList.contains('mdr-cell-active')).toBe(true);
    // Dispatch on the nested editor, which is the path key input takes.
    const inner = getNested(active as HTMLElement);
    inner.dispatch({
      changes: { from: 1, insert: 'xy' },
      selection: { anchor: 3 },
      userEvent: 'input.type',
    });
    expect(view.state.doc.toString()).toBe(doc.replace('| a |', '| axy |'));
    expect(inner.state.doc.toString()).toBe('axy');
    expect(nested()?.textContent).toBe('axy');
    inner.dispatch({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' });
    expect(view.state.doc.toString()).toBe(doc.replace('| a |', '| ay |'));
  });

  it('escapes a typed pipe and keeps the cell on one line', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ changes: { from: 1, insert: '|' }, userEvent: 'input.type' });
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| a\\| |'));
    inner.dispatch({ changes: { from: 0, insert: '\n' }, userEvent: 'input.type' });
    expect(inner.state.doc.toString()).toBe('a\\|');
  });

  it('undoes a cell edit from inside the cell and resyncs', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ changes: { from: 1, insert: 'Z' }, userEvent: 'input.type' });
    expect(editor.view.state.doc.toString()).toContain('| aZ |');
    const mac = /Mac/.test(navigator.platform);
    const undoKey = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
    });
    inner.contentDOM.dispatchEvent(undoKey);
    expect(editor.view.state.doc.toString()).toBe(doc);
    expect(nested()).not.toBeNull();
    expect(getNested(cell(1, 0) as HTMLElement).state.doc.toString()).toBe('a');
  });

  it('moves between cells with Tab and adds a row after the last cell', async () => {
    await activate(1, 0);
    const key = (name: string, shift = false) =>
      nested()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, shiftKey: shift, bubbles: true }),
      );
    key('Tab');
    await tick();
    expect(cell(1, 1)?.classList.contains('mdr-cell-active')).toBe(true);
    expect(nested()?.textContent).toBe('**b**');
    key('Tab', true);
    await tick();
    expect(cell(1, 0)?.classList.contains('mdr-cell-active')).toBe(true);
    key('ArrowDown');
    await tick();
    expect(cell(2, 0)?.classList.contains('mdr-cell-active')).toBe(true);
    key('Tab');
    await tick();
    key('Tab');
    await tick();
    expect(editor.view.state.doc.toString()).toContain('| 日本 | c \\| d |\n| | |\n');
    expect(cell(3, 0)?.classList.contains('mdr-cell-active')).toBe(true);
  });

  it('drops to source on Escape with the cursor at the cell position', async () => {
    await activate(1, 1);
    nested()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(table()).toBeNull();
    // The activating click was at (0, 0), so the nested cursor sat at the cell start.
    expect(editor.view.state.selection.main.head).toBe(doc.indexOf('**b**'));
  });

  it('enters the table from the line above with ArrowDown', async () => {
    editor.view.dispatch({ selection: { anchor: doc.indexOf('\n\n') + 1 } });
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await tick();
    expect(cell(0, 0)?.classList.contains('mdr-cell-active')).toBe(true);
  });

  it('composes text through the nested editor without duplication', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    const content = inner.contentDOM;
    const textNode = content.querySelector('.cm-line')?.firstChild as globalThis.Text | null;
    expect(textNode?.nodeValue).toBe('a');
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    if (textNode) textNode.nodeValue = 'aに';
    content.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' }));
    content.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'に' }),
    );
    await tick();
    if (textNode) textNode.nodeValue = 'a日';
    content.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日' }),
    );
    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日' }));
    await tick();
    await tick();
    expect(inner.state.doc.toString()).toBe('a日');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| a日 |'));
  });
});

function getNested(td: HTMLElement): EditorView {
  const dom = td.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('no nested view');
  return view;
}
