import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { extensions as dialect } from '@mdreader/markdown';

/**
 * The markdown language for the editor: CodeMirror's GFM base plus this
 * app's dialect extensions, with fence languages loaded lazily.
 */
export function markdownSupport(): Extension {
  return markdown({
    base: markdownLanguage,
    extensions: dialect,
    codeLanguages: languages,
    addKeymap: true,
  });
}

/**
 * Everything an editor needs that does not depend on the DOM. Pure state
 * tests build on this; `createEditor` adds the view.
 */
export function baseExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdownSupport(),
  ];
}

export function createEditorState(doc: string, extra: Extension[] = []): EditorState {
  return EditorState.create({ doc, extensions: [baseExtensions(), extra] });
}
