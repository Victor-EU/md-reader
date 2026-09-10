import { syntaxTree } from '@codemirror/language';
import { ChangeSet, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { corpusFiles } from '@markdown/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { activateCell } from '../preview/table/cell-editor.ts';
import { escapePipes } from '../preview/table/commands.ts';
import { tableModel } from '../preview/table/model.ts';
import { createEditor, type Editor } from '../view.ts';
import { checkExactness, checkLocality, type Outcome } from './invariants.ts';
import { mixSeed, rng } from './rng.ts';

/**
 * The corpus actions that need a real DOM: a cell edit through the
 * nested editor, and an IME composition in a paragraph. Runs over the
 * committed files plus a slice of the synthetic set on Chromium and
 * WebKit.
 */
const files = corpusFiles(24);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('round-trip corpus (browser)', () => {
  let host: HTMLDivElement | null = null;
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    host?.remove();
    editor = null;
    host = null;
  });

  function mount(text: string): EditorView {
    host = document.createElement('div');
    host.style.cssText = 'height: 400px; overflow: hidden;';
    document.body.appendChild(host);
    editor = createEditor(host, text);
    editor.view.dom.style.height = '100%';
    return editor.view;
  }

  /** Widgets are only drawn inside the viewport, so bring the table there first. */
  async function reveal(view: EditorView, pos: number) {
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await tick();
  }

  function settle(view: EditorView): EditorState {
    return view.state;
  }

  it('edits table cells through the nested editor with exact bytes', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [fi, file] of files.entries()) {
      if (file.text.includes('\r')) continue;
      const view = mount(file.text);
      const random = rng(mixSeed(7, fi));
      const tables: ReturnType<typeof tableModel>[] = [];
      syntaxTree(view.state).iterate({
        enter(node) {
          if (node.name === 'Table') tables.push(tableModel(node.node, view.state.doc));
        },
      });
      const model = random.pick(tables.filter((t) => t !== null));
      const cells = model
        ? model.rows.flatMap((r, ri) =>
            r.cells.map((c, ci) => ({ c, ri, ci })).filter((x) => !x.c.missing),
          )
        : [];
      if (!model || cells.length === 0) {
        editor?.destroy();
        host?.remove();
        continue;
      }
      const { c: cell, ri, ci } = random.pick(cells);
      const raw = random.pick(['q', 'a|b', '日本']);
      const insert = escapePipes(raw);
      await reveal(view, model.from);
      const before = view.state;
      activateCell(view, model, ri, ci, null, 'end');
      await tick();
      const td = host?.querySelector<HTMLElement>('.mdr-cell-active .cm-editor');
      const nested = td && EditorView.findFromDOM(td);
      if (!nested) {
        failures.push(`${file.name}: no nested editor for cell ${ri},${ci}`);
        editor?.destroy();
        host?.remove();
        continue;
      }
      nested.dispatch({
        changes: { from: nested.state.doc.length, insert: raw },
        userEvent: 'input.type',
      });
      const expected = ChangeSet.of({ from: cell.to, insert }, before.doc.length);
      const outcomes: Outcome[] = [
        checkExactness(before, settle(view), expected),
        checkLocality(before, settle(view), { from: cell.from, to: cell.to }, expected),
      ];
      for (const o of outcomes)
        if (!o.ok)
          failures.push(
            `${file.name} cell ${ri},${ci} insert ${JSON.stringify(raw)}: ${o.reason} ${o.detail}`,
          );
      checked++;
      editor?.destroy();
      host?.remove();
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(5);
  });

  it('composes text in a paragraph without duplication', async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const [fi, file] of files.entries()) {
      if (file.text.includes('\r')) continue;
      const view = mount(file.text);
      const random = rng(mixSeed(11, fi));
      const words: number[] = [];
      for (const m of file.text.matchAll(/(?<=^[A-Za-z][^\n]*)[A-Za-z]{4,}(?= )/gm)) {
        if (m.index !== undefined) words.push(m.index + m[0].length);
      }
      const inParagraph = words.filter(
        (pos) => syntaxTree(view.state).resolveInner(pos, -1).name === 'Paragraph',
      );
      if (inParagraph.length === 0) {
        editor?.destroy();
        host?.remove();
        continue;
      }
      const at = random.pick(inParagraph);
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
      const before = view.state;
      const { node, offset } = view.domAtPos(at);
      const textNode =
        node.nodeType === Node.TEXT_NODE
          ? (node as Text)
          : (node.childNodes[offset - 1] as Text | undefined);
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        editor?.destroy();
        host?.remove();
        continue;
      }
      const off = node.nodeType === Node.TEXT_NODE ? offset : (textNode.nodeValue?.length ?? 0);
      const content = view.contentDOM;
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const value = textNode.nodeValue ?? '';
      textNode.nodeValue = `${value.slice(0, off)}に${value.slice(off)}`;
      content.dispatchEvent(
        new CompositionEvent('compositionupdate', { bubbles: true, data: 'に' }),
      );
      content.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'に' }),
      );
      await tick();
      const value2 = textNode.nodeValue ?? '';
      textNode.nodeValue = `${value2.slice(0, off)}日${value2.slice(off + 1)}`;
      content.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '日' }),
      );
      content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日' }));
      await tick();
      await tick();
      const expected = ChangeSet.of({ from: at, insert: '日' }, before.doc.length);
      const outcomes = [
        checkExactness(before, view.state, expected),
        checkLocality(before, view.state, { from: at, to: at }, expected),
      ];
      for (const o of outcomes)
        if (!o.ok) failures.push(`${file.name} at ${at}: ${o.reason} ${o.detail}`);
      checked++;
      editor?.destroy();
      host?.remove();
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(5);
  });
});
