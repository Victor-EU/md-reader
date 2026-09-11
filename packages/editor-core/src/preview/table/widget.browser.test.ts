import { forceParsing, syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../../test-helpers.ts';
import type { Editor } from '../../view.ts';

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
    editor = parsedEditor(host, doc);
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

  /**
   * The backslash was typed a keystroke ago, so escaping the pipe against
   * the keystroke alone writes `\\|` -- an escaped backslash and then a
   * live delimiter, which gives the row a cell the header has no column
   * for and pushes the note out of the table.
   */
  it('keeps the cell whole when a pipe is typed after a backslash', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ selection: { anchor: 1 } });
    typeInCell(inner, '\\|');
    expect(inner.state.doc.toString()).toBe('a\\|');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| a\\| |'));
    expect(cell(1, 1)?.textContent).toBe('b');
  });

  /**
   * A write above the table that leaves the table's own block alone never
   * rebuilds the widget: Lezer hands the block back and the decoration is
   * only mapped. Nothing then tells the open cell that every offset below
   * the write has moved, and the next letter used to be dropped on the
   * floor as drift.
   */
  it('keeps taking keystrokes after a write lands above the table', async () => {
    // The prose above the table is the point of it: the parser only hands a
    // block back untouched when enough unchanged text sits between it and
    // the write, and a rebuilt widget would refresh the offset by itself.
    const above = `${'Prose above the table, of which there has to be a fair amount. '.repeat(6)}\n\n`;
    editor.destroy();
    editor = parsedEditor(host, above + doc);
    editor.view.dispatch({ selection: { anchor: 0 } });
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ selection: { anchor: 1 } });
    typeInCell(inner, 'x');
    expect(editor.view.state.doc.toString()).toBe(above + doc.replace('| a |', '| ax |'));
    editor.view.dispatch({
      changes: { from: 0, insert: 'A line from elsewhere\n\n' },
      userEvent: 'external.change',
    });
    await tick();
    typeInCell(getNested(cell(1, 0) as HTMLElement), 'y');
    expect(editor.view.state.doc.toString()).toBe(
      `A line from elsewhere\n\n${above}${doc.replace('| a |', '| axy |')}`,
    );
  });

  /**
   * CodeMirror parses for 20 ms after a transaction and hands over the tree
   * it has when they are up; the background parse does the rest a tenth of
   * a second later at the soonest. A machine that loses the CPU at the wrong
   * moment stops that parse above the table, and for that tenth of a second
   * there was no table for the cell editor to find: the next letter went
   * nowhere.
   */
  it('keeps taking keystrokes when the parse after a write stops above the table', async () => {
    const above = `${'Prose above the table, of which there has to be a fair amount. '.repeat(6)}\n\n`;
    editor.destroy();
    editor = parsedEditor(host, above + doc);
    editor.view.dispatch({ selection: { anchor: 0 } });
    await activate(1, 0);
    getNested(cell(1, 0) as HTMLElement).dispatch({ selection: { anchor: 1 } });
    const write = 'A line from elsewhere\n\n';
    starved(() =>
      editor.view.dispatch({ changes: { from: 0, insert: write }, userEvent: 'external.change' }),
    );
    expect(syntaxTree(editor.view.state).length).toBeLessThan((write + above).length);
    typeInCell(getNested(cell(1, 0) as HTMLElement), 'x');
    expect(editor.view.state.doc.toString()).toBe(write + above + doc.replace('| a |', '| ax |'));
  });

  /**
   * The same cut on the parse after the reader's own keystroke. The table
   * was rebuilt from a tree that stopped above it, which is to say taken
   * away, and the cell being typed in went with it.
   */
  it('keeps the cell open when the parse after a keystroke stops above the table', async () => {
    await activate(1, 0);
    const td = cell(1, 0) as HTMLElement;
    const inner = getNested(td);
    inner.dispatch({ selection: { anchor: 1 } });
    starved(() => typeInCell(inner, 'x'));
    expect(syntaxTree(editor.view.state).length).toBeLessThan(doc.indexOf('| Name'));
    expect(cell(1, 0)).toBe(td);
    expect(getNested(td)).toBe(inner);
    expect(document.activeElement).toBe(inner.contentDOM);
    typeInCell(inner, 'y');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| axy |'));
  });

  /**
   * A table kept through a keystroke the parse did not reach is rebuilt
   * when the parse catches up. By then the cell has what was typed into
   * it, and the rebuild must not trim a space the reader has just typed at
   * its end back off.
   */
  it('keeps a typed space when the parse catches up with it', async () => {
    await activate(1, 0);
    const inner = getNested(cell(1, 0) as HTMLElement);
    inner.dispatch({ selection: { anchor: 1 } });
    starved(() => typeInCell(inner, ' '));
    expect(syntaxTree(editor.view.state).length).toBeLessThan(doc.indexOf('| Name'));
    // What the background parse does a moment later: finish, and hand the tree over.
    forceParsing(editor.view, editor.view.state.doc.length, 10_000);
    expect(syntaxTree(editor.view.state).length).toBe(editor.view.state.doc.length);
    expect(inner.state.doc.toString()).toBe('a ');
    typeInCell(inner, 'b');
    expect(editor.view.state.doc.toString()).toBe(doc.replace('| a |', '| a b |'));
  });

  /**
   * A row arriving from elsewhere rebuilds the table element, and the cell
   * that comes back with it is not a cell anyone asked for. Taking the
   * focus on that mount takes it out of wherever the reader actually is --
   * the find bar, the palette -- in the middle of them typing there.
   */
  it('leaves the focus alone when a write rebuilds the table', async () => {
    await activate(1, 0);
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);
    editor.view.dispatch({
      changes: { from: doc.indexOf('\n\nAfter line'), insert: '\n| z | z |' },
      userEvent: 'external.change',
    });
    await tick();
    expect(host.querySelector('.mdr-cell-active')).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
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

/**
 * Run `fn` on a clock that jumps a second at every reading: a machine that
 * loses the CPU while a time budget is being spent, made repeatable.
 * CodeMirror's 20 ms parse after a transaction stops after its first step.
 */
function starved<T>(fn: () => T): T {
  const real = Date.now;
  let reads = 0;
  Date.now = () => real.call(Date) + reads++ * 1000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function getNested(td: HTMLElement): EditorView {
  const dom = td.querySelector<HTMLElement>('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom);
  if (!view) throw new Error('no nested view');
  return view;
}
