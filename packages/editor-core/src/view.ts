import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditorState } from './state.ts';

export interface Editor {
  readonly view: EditorView;
  /** The current document text, exactly as it will be written to disk. */
  getDoc(): string;
  /** Replace the document. Resets undo history, as opening a file should. */
  setDoc(doc: string): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, doc = '', extra: Extension[] = []): Editor {
  const view = new EditorView({ state: createEditorState(doc, extra), parent });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc: (next) => view.setState(createEditorState(next, extra)),
    destroy: () => view.destroy(),
  };
}
