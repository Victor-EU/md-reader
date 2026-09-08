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

  // Every other cell test here dispatches the whole string in one transaction,
  // which never leaves a space at the edge of a cell between two of them.
  // Typing does, and a cell's model range is its *trimmed* content, so that is
  // the shape that used to drop the space from the cell and strand it in the
  // document. These type one transaction per character instead.
  it('keeps a space typed at the end of a cell', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    selectAll(inner);
    typeInCell(inner, 'a b');
    expect(inner.state.doc.toString()).toBe('a b');
    expect(nested()?.textContent).toBe('a b');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| a b |'));
  });

  it('keeps every space of a typed multi-word cell, with no stray bytes', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    selectAll(inner);
    typeInCell(inner, 'one two three');
    expect(inner.state.doc.toString()).toBe('one two three');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| one two three |'));
  });

  it('keeps a space typed at the start of a cell', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ selection: { anchor: 0 } });
    typeInCell(inner, ' x');
    expect(inner.state.doc.toString()).toBe(' xa');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '|  xa |'));
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
    expect(editor.view.state.doc.toString()).toContain('| 日本 | c \\| d |\n|  |  |\n');
    expect(cell(3, 0)?.classList.contains('mdr-cell-active')).toBe(true);
  });

  it('pads a row added with Tab so typed text sits between spaces', async () => {
    await activate(2, 1);
    nested()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await tick();
    typeInCell(getNested(cell(3, 0) as HTMLElement), '#4');
    expect(editor.view.state.doc.toString()).toContain('| 日本 | c \\| d |\n| #4 |  |\n');
  });

  it('opens the last cell on Backspace at the start of the line under the table', async () => {
    const key = () =>
      editor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
      );
    // At the start of the paragraph after the blank line: the blank line stays.
    editor.view.dispatch({ selection: { anchor: doc.indexOf('After line') } });
    key();
    await tick();
    expect(editor.view.state.doc.toString()).toBe(doc);
    expect(cell(2, 1)?.classList.contains('mdr-cell-active')).toBe(true);
    expect(getNested(cell(2, 1) as HTMLElement).state.selection.main.head).toBe('c \\| d'.length);
    // At the start of the blank line directly under the table: no join either.
    editor.view.dispatch({
      selection: { anchor: doc.indexOf('After line') - 1 },
      effects: [],
    });
    await tick();
    expect(table()).not.toBeNull();
    key();
    await tick();
    expect(editor.view.state.doc.toString()).toBe(doc);
    expect(cell(2, 1)?.classList.contains('mdr-cell-active')).toBe(true);
  });

  it('scrolls a cell reached by keyboard into view', async () => {
    host.style.height = '120px';
    const scroller = host.querySelector<HTMLElement>('.cm-scroller');
    if (scroller) scroller.style.height = '120px';
    editor.view.dispatch({
      changes: { from: doc.length, insert: `${'\n'.repeat(60)}| x | y |\n|---|---|\n| 1 | 2 |\n` },
      selection: { anchor: doc.length + 1 },
    });
    await tick();
    // The blank line above the table, scrolled into view as a cursor line would be.
    editor.view.dispatch({
      selection: { anchor: editor.view.state.doc.length - 31 },
      scrollIntoView: true,
    });
    await tick();
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await tick();
    await tick();
    const active = host.querySelector<HTMLElement>('.mdr-cell-active');
    expect(active).not.toBeNull();
    const box = active?.getBoundingClientRect();
    const frame = scroller?.getBoundingClientRect();
    expect(box && frame && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1).toBe(true);
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

function selectAll(inner: EditorView): void {
  inner.dispatch({ selection: { anchor: 0, head: inner.state.doc.length } });
}

/**
 * Type one transaction per character, the granularity real key input produces.
 * The widget rebuilds and re-syncs the cell between each pair, which is what
 * makes this different from inserting the whole string at once.
 */
function typeInCell(inner: EditorView, text: string): void {
  for (const ch of text) {
    const at = inner.state.selection.main;
    inner.dispatch({
      changes: { from: at.from, to: at.to, insert: ch },
      selection: { anchor: at.from + ch.length },
      userEvent: 'input.type',
    });
  }
}

function getNested(td: HTMLElement): EditorView {
  const dom = td.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('no nested view');
  return view;
}
