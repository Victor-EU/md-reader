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
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  type KeyBinding,
  keymap,
} from '@codemirror/view';
import { extensions as dialect } from '@mdreader/markdown';
import { changeMarkers, reviewPanels } from './changes/index.ts';
import { deleteMarkerBackward, indentListItem, outdentListItem } from './commands/list.ts';
import { insertNewlineMarkdown } from './commands/newline.ts';
import { conflictWidgets } from './conflict/index.ts';
import {
  codeHighlightDark,
  codeHighlightLight,
  livePreview,
  markdownHighlightStyle,
  type PreviewOptions,
  previewOptions,
} from './preview/index.ts';
import { findExtensions } from './search/index.ts';

/** Edit is live preview; Source is the same buffer with decorations off (design 4.2). */
export type EditorMode = 'edit' | 'source';

const modeCompartment = new Compartment();
const darkCompartment = new Compartment();
const reviewCompartment = new Compartment();

function modeExtension(mode: EditorMode): Extension {
  return mode === 'edit' ? livePreview() : [];
}

/** The effect that switches an existing state between Edit and Source. */
export function setModeEffect(mode: EditorMode): StateEffect<unknown> {
  return modeCompartment.reconfigure(modeExtension(mode));
}

/**
 * Turn Review mode on or off (design 4.4).
 *
 * A compartment rather than a fourth mode: Review is not another
 * projection of the buffer but a layer over whichever one is in front,
 * and the marks, the stepping and the records underneath it are there
 * either way. Turning it off takes the panels away and leaves everything
 * that knows what changed exactly as it was.
 */
export function setReviewEffect(on: boolean): StateEffect<unknown> {
  return reviewCompartment.reconfigure(on ? reviewPanels() : []);
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
 * Keys CodeMirror's default keymap claims that design 4.5 has already
 * given to a command of the shell's.
 *
 * Shadowing is not enough. The editor's keymap sits on the content
 * element and the shell's sits on the window, so the editor sees the key
 * first and `preventDefault` stops it there — which is how Cmd+I spent an
 * afternoon selecting the parent block instead of italicising a word.
 * The binding has to be taken out, not out-ranked.
 *
 * `commands.test.ts` in the app fails if the two keymaps ever claim the
 * same key again.
 */
const shellKeys = new Set(['Mod-i']);

const editorKeymap = defaultKeymap.filter(
  (binding) => !(binding.key !== undefined && shellKeys.has(binding.key)),
);

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

/** Every key the editor claims, for the app's collision test. */
export function editorKeys(): readonly KeyBinding[] {
  return [...markdownKeymap, ...editorKeymap, ...historyKeymap];
}

/**
 * Everything an editor needs that does not depend on the DOM. Pure state
 * tests build on this; `createEditor` adds the view.
 */
export function baseExtensions(
  mode: EditorMode = 'edit',
  preview: PreviewOptions = {},
  options: { dark?: boolean; review?: boolean } = {},
): Extension[] {
  return [
    // Outside the compartment: what the widgets render with does not
    // change when the mode does.
    previewOptions.of(preview),
    history(),
    drawSelection(),
    highlightSpecialChars(),
    EditorView.lineWrapping,
    // The webview's own spell check, which is the one the reader already
    // has words in (design 4.5). Its two companions are off for the same
    // reason smart typography is: what the model wrote is what it meant,
    // and an editor that substitutes characters while you type breaks the
    // one promise this app makes about bytes.
    EditorView.contentAttributes.of({
      spellcheck: 'true',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
    keymap.of([...markdownKeymap, ...editorKeymap, ...historyKeymap]),
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
    // Hunks an external write and the reader both touched, offered as a
    // choice rather than decided for them (design 7.2). Outside the mode
    // compartment as well: a conflict is not a decoration of one
    // projection, it is the state of the document, and the shell reads
    // this field to hold the save whichever view is in front.
    conflictWidgets(),
    // The same changes again, told rather than marked, when the reader
    // asks for them (design 4.4). Off until then: a panel above every
    // changed paragraph is the right way to read a set of changes and
    // the wrong way to read a document.
    reviewCompartment.of(options.review === true ? reviewPanels() : []),
    // Find and replace, drawn whenever the bar is open (design 4.5).
    findExtensions(),
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
  /** Whether the change panels are showing (design 4.4). */
  review?: boolean;
}

export function createEditorState(doc: string, options: StateOptions = {}): EditorState {
  return EditorState.create({
    doc,
    selection: options.selection ?? EditorSelection.single(0),
    extensions: [
      baseExtensions(options.mode ?? 'edit', options.preview, {
        dark: options.dark,
        review: options.review,
      }),
      options.extra ?? [],
    ],
  });
}
