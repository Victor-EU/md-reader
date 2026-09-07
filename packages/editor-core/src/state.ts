import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { foldNodeProp } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { extensions as dialect } from '@mdreader/markdown';

/**
 * The markdown language for the editor: CodeMirror's CommonMark base plus
 * the whole dialect from `@mdreader/markdown`, with fence languages loaded
 * lazily. The base is CommonMark, not `markdownLanguage`, because that one
 * adds Subscript, Superscript, and Emoji, which design 5.1 leaves out and
 * the headless parser does not have. Only the table folding rule from that
 * bundle is kept.
 */
export function markdownSupport(): Extension {
  return markdown({
    base: commonmarkLanguage,
    extensions: [
      dialect,
      {
        props: [
          foldNodeProp.add({
            Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
          }),
        ],
      },
    ],
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
