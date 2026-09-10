import { ensureSyntaxTree, forceParsing } from '@codemirror/language';
import { EditorSelection, type EditorState, type Range } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { createEditorState, type EditorMode } from './state.ts';
import { createEditor, type Editor, type EditorOptions } from './view.ts';

/**
 * A state whose syntax tree is complete. `EditorState.create` parses with
 * a small time budget and finishes the rest in the background, so tests
 * force the parse and take the resulting state.
 */
export function parsedState(
  doc: string,
  selection?: number | { anchor: number; head: number },
  mode: EditorMode = 'edit',
): EditorState {
  const sel =
    selection === undefined
      ? undefined
      : typeof selection === 'number'
        ? EditorSelection.single(selection)
        : EditorSelection.single(selection.anchor, selection.head);
  const state = createEditorState(doc, { mode, ...(sel ? { selection: sel } : {}) });
  ensureSyntaxTree(state, doc.length, 10_000);
  return state.update({}).state;
}

/**
 * A mounted editor whose syntax tree is complete, the view counterpart of
 * `parsedState`. The same 20 ms budget applies when a view is built, and
 * the preview draws what the tree it was handed contains: a runner that
 * loses the CPU mid-parse mounts a document whose widgets stop partway
 * down. The app redraws when the background parse catches up, so this is
 * invisible in use and visible only to a test that asserts in the same
 * tick. `forceParsing` finishes the parse and dispatches, which is what
 * makes the preview plugin build over the whole document.
 */
export function parsedEditor(parent: HTMLElement, doc = '', options: EditorOptions = {}): Editor {
  const editor = createEditor(parent, doc, options);
  forceParsing(editor.view, editor.view.state.doc.length, 10_000);
  return editor;
}

/**
 * A readable, one-per-line rendering of decoration ranges for snapshots:
 * position, kind, class or widget, and the covered text for marks.
 */
export function serializeDecorations(ranges: readonly Range<Decoration>[], doc: string): string {
  const sorted = [...ranges].sort(
    (a, b) => a.from - b.from || a.to - b.to || kindOrder(a.value) - kindOrder(b.value),
  );
  return `${sorted.map((r) => describe(r, doc)).join('\n')}\n`;
}

function kindOrder(deco: Decoration): number {
  const kind = deco.spec.kind as string | undefined;
  return kind === 'line' ? 0 : kind === 'hide' || kind === 'widget' ? 1 : 2;
}

function describe(r: Range<Decoration>, doc: string): string {
  const spec = r.value.spec as {
    kind?: string;
    class?: string;
    attributes?: Record<string, string>;
    widget?: object;
  };
  const pos = `${r.from}-${r.to}`;
  switch (spec.kind) {
    case 'line': {
      const attrs = spec.attributes ? ` ${JSON.stringify(spec.attributes)}` : '';
      return `${pos} line ${spec.class}${attrs}`;
    }
    case 'hide':
      return `${pos} hide ${JSON.stringify(doc.slice(r.from, r.to))}`;
    case 'widget': {
      const widget = spec.widget as { constructor: { name: string }; checked?: boolean };
      const detail = widget.checked === undefined ? '' : widget.checked ? ' checked' : ' unchecked';
      return `${pos} widget ${widget.constructor.name}${detail} ${JSON.stringify(doc.slice(r.from, r.to))}`;
    }
    default:
      return `${pos} mark ${spec.class} ${JSON.stringify(doc.slice(r.from, r.to))}`;
  }
}
