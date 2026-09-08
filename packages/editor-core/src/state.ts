import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { foldNodeProp, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  type StateEffect,
} from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { extensions as dialect } from '@mdreader/markdown';
import { changeMarkers } from './changes/index.ts';
import { deleteMarkerBackward, indentListItem, outdentListItem } from './commands/list.ts';
import { insertNewlineMarkdown } from './commands/newline.ts';
import {
  codeHighlightDark,
  codeHighlightLight,
  livePreview,
  markdownHighlightStyle,
  type PreviewOptions,
  previewOptions,
} from './preview/index.ts';

/** Edit is live preview; Source is the same buffer with decorations off (design 4.2). */
export type EditorMode = 'edit' | 'source';

const modeCompartment = new Compartment();
const darkCompartment = new Compartment();

function modeExtension(mode: EditorMode): Extension {
  return mode === 'edit' ? livePreview() : [];
}

/** The effect that switches an existing state between Edit and Source. */
export function setModeEffect(mode: EditorMode): StateEffect<unknown> {
  return modeCompartment.reconfigure(modeExtension(mode));
}

/**
 * Tell an editor which of theme one's two code palettes it is on.
 *
 * The question is the paper's, not the system's: the high-contrast black
 * paper is dark inside a light window, and the code on it has to be
 * highlighted for what it is written on (plan WP 1.9).
 */
export function setDarkEffect(dark: boolean): StateEffect<unknown> {
  return darkCompartment.reconfigure(EditorView.darkTheme.of(dark));
}

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
    // lang-markdown's Enter trims, converts tabs, and renumbers; ours does not.
    addKeymap: false,
  });
}

/**
 * Markdown editing keys: a lossless Enter, a Backspace that removes a
 * marker instead of replacing it with spaces, and a Tab that the editor
 * always keeps. All three are defined in `./commands`.
 */
export const markdownKeymap = [
  { key: 'Enter', run: insertNewlineMarkdown },
  { key: 'Backspace', run: deleteMarkerBackward },
  { key: 'Tab', run: indentListItem, shift: outdentListItem },
];

/**
 * Everything an editor needs that does not depend on the DOM. Pure state
 * tests build on this; `createEditor` adds the view.
 */
export function baseExtensions(
  mode: EditorMode = 'edit',
  preview: PreviewOptions = {},
  options: { dark?: boolean } = {},
): Extension[] {
  return [
    // Outside the compartment: what the widgets render with does not
    // change when the mode does.
    previewOptions.of(preview),
    history(),
    drawSelection(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    markdownSupport(),
    // Shapes from the first, colours from whichever of the other two
    // matches the page. `themeType` is what keeps the wrong one quiet.
    syntaxHighlighting(markdownHighlightStyle),
    syntaxHighlighting(codeHighlightLight),
    syntaxHighlighting(codeHighlightDark),
    darkCompartment.of(EditorView.darkTheme.of(options.dark ?? false)),
    // What has changed since the reader last looked, in both Edit and
    // Source: a change is a change whichever projection is in front.
    changeMarkers(),
    modeCompartment.of(modeExtension(mode)),
  ];
}

export interface StateOptions {
  extra?: Extension[];
  mode?: EditorMode;
  selection?: EditorSelection;
  /** KaTeX, Mermaid, and the image rules the block widgets need. */
  preview?: PreviewOptions;
  /** Whether the page this editor is on is a dark one (plan WP 1.9). */
  dark?: boolean;
}

export function createEditorState(doc: string, options: StateOptions = {}): EditorState {
  return EditorState.create({
    doc,
    selection: options.selection ?? EditorSelection.single(0),
    extensions: [
      baseExtensions(options.mode ?? 'edit', options.preview, { dark: options.dark }),
      options.extra ?? [],
    ],
  });
}
