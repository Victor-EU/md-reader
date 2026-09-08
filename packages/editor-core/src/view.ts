import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { PreviewOptions } from './preview/index.ts';
import { createEditorState, type EditorMode, setModeEffect } from './state.ts';

export interface Editor {
  readonly view: EditorView;
  /** The current document text, exactly as it will be written to disk. */
  getDoc(): string;
  /** Replace the document. Resets undo history, as opening a file should. */
  setDoc(doc: string): void;
  getMode(): EditorMode;
  /** Switch between live preview and plain source. The buffer is untouched. */
  setMode(mode: EditorMode): void;
  destroy(): void;
}

export interface EditorOptions {
  extra?: Extension[];
  mode?: EditorMode;
  /** What the block widgets render with: KaTeX, Mermaid, the image rules. */
  preview?: PreviewOptions;
}

export function createEditor(parent: HTMLElement, doc = '', options: EditorOptions = {}): Editor {
  const extra = options.extra ?? [];
  const preview = options.preview;
  let mode: EditorMode = options.mode ?? 'edit';
  const view = new EditorView({ state: createEditorState(doc, { extra, mode, preview }), parent });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (next) => view.setState(createEditorState(next, { extra, mode, preview })),
    getMode: () => mode,
    setMode: (next) => {
      if (next === mode) return;
      mode = next;
      view.dispatch({ effects: setModeEffect(next) });
    },
    destroy: () => view.destroy(),
  };
}
