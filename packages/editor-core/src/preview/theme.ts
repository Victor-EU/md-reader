import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { calloutTypeTag, highlightTag, mathTag } from '@markdown/markdown';
import { codeHighlight } from '@markdown/theme';

/**
 * The bundled monospace, with the system stacks behind it. The window
 * defines the variable; the fallback is what a bare editor in a test
 * gets, and is the stack this file used before there were bundled
 * families at all.
 */
const mono =
  'var(--family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace)';

/**
 * Structural styling for the live preview classes. Colours go through
 * CSS variables with plain fallbacks so the app's theme can restyle
 * without touching this file; the shapes (sizes, borders, indents) are
 * the editor's own.
 *
 * What a comment meaning or a callout type is coloured is not here
 * either: the themes put those on the same `data-kind` and
 * `data-callout` attributes the rendered page carries, so a note is the
 * same colour whichever projection of the document it is seen in.
 */
export const previewTheme = EditorView.baseTheme({
  // Read mode's scale (the app's `read.css`), so a heading is the same
  // size and weight whichever projection of the document it is seen in,
  // and switching modes wraps nothing differently.
  '.mdr-h1': {
    fontSize: '1.9em',
    fontWeight: '650',
    lineHeight: '1.25',
    letterSpacing: '-0.021em',
  },
  '.mdr-h2': {
    fontSize: '1.5em',
    fontWeight: '650',
    lineHeight: '1.25',
    letterSpacing: '-0.016em',
  },
  '.mdr-h3': { fontSize: '1.25em', fontWeight: '650', letterSpacing: '-0.011em' },
  '.mdr-h4': { fontSize: '1.1em', fontWeight: '650', letterSpacing: '-0.006em' },
  '.mdr-h5, .mdr-h6': { fontWeight: '650' },
  '.mdr-em': { fontStyle: 'italic' },
  '.mdr-strong': { fontWeight: '700' },
  '.mdr-code, .mdr-math': {
    fontFamily: mono,
    fontSize: '0.9em',
    background: 'var(--mdr-code-bg, rgba(127, 127, 127, 0.15))',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.mdr-link': { color: 'var(--mdr-link, #2a6ad9)', textDecoration: 'underline' },
  '.mdr-image': { color: 'var(--mdr-muted, #888)' },
  '.mdr-mark': { background: 'var(--mdr-highlight, #fff3a3)', borderRadius: '2px' },
  '.mdr-del': { textDecoration: 'line-through', opacity: '0.7' },
  '.mdr-comment, .mdr-comment-block': { opacity: '0.55', fontSize: '0.9em' },
  // A note is a bubble in the text; at widths that have room for it the
  // rule below moves it out into the margin beside its line.
  '.cm-line': { position: 'relative' },
  '.mdr-comment-widget': {
    display: 'inline-flex',
    gap: '4px',
    alignItems: 'baseline',
    maxWidth: '100%',
    verticalAlign: 'baseline',
    margin: '0 2px',
    padding: '0 6px',
    borderRadius: '9px',
    fontSize: '0.8em',
    lineHeight: '1.5',
    cursor: 'text',
    background: 'color-mix(in srgb, var(--mdr-note, #7a7a7a) 12%, transparent)',
    border: '1px solid color-mix(in srgb, var(--mdr-note, #7a7a7a) 35%, transparent)',
    color: 'var(--mdr-note-fg, inherit)',
  },
  '.mdr-comment-kind': { fontWeight: '600', color: 'var(--mdr-note, #7a7a7a)' },
  '.mdr-comment-text': { whiteSpace: 'pre-wrap' },
  // The span a note points at, while the pointer is on the note. An
  // underline rather than a tint alone: the anchor of a highlight is
  // already on a yellow ground, and a tint over that says nothing.
  '.mdr-anchor-hover': {
    background: 'color-mix(in srgb, var(--mdr-link, #2a6ad9) 14%, transparent)',
    boxShadow: 'inset 0 -2px 0 0 var(--mdr-link, #2a6ad9)',
    borderRadius: '2px',
  },
  // Room for a margin beside the text, as `commentNotes` measures it: the
  // note leaves the line and sits beside it.
  '&[data-mdr-margin] .mdr-comment-widget': {
    position: 'absolute',
    left: 'calc(100% + 16px)',
    top: 'calc(var(--mdr-note-index, 0) * 1.7em)',
    width: '15ch',
    margin: '0',
    whiteSpace: 'normal',
    display: 'block',
  },
  // Laid out as a block, so the flex gap between the kind and the words
  // is gone and the margin has to be its own.
  '&[data-mdr-margin] .mdr-comment-kind': { marginRight: '0.35em' },
  '&[data-mdr-margin] .mdr-comment-kind::after': { content: '":"' },
  '.mdr-syntax, .mdr-dim, .mdr-quote-mark': { opacity: '0.45' },
  '.mdr-quote': {
    borderLeft: '3px solid var(--mdr-quote, #c9c9c9)',
    paddingLeft: '10px',
  },
  '.mdr-callout': {
    // The tint follows the type's own colour, so Edit and Read agree.
    background: 'color-mix(in srgb, var(--mdr-callout, #2a6ad9) 7%, transparent)',
    borderLeftColor: 'var(--mdr-callout, #2a6ad9)',
  },
  '.mdr-callout-header': { fontWeight: '600' },
  '.mdr-callout-marker': { opacity: '0.55', fontSize: '0.85em' },
  '.mdr-fence, .mdr-math-block, .mdr-frontmatter, .mdr-table': {
    fontFamily: mono,
    fontSize: '0.9em',
    background: 'var(--mdr-code-bg, rgba(127, 127, 127, 0.1))',
  },
  '.mdr-frontmatter': { opacity: '0.7' },
  '.mdr-sub': { verticalAlign: 'sub', fontSize: '0.8em' },
  '.mdr-sup, .mdr-fnref': { verticalAlign: 'super', fontSize: '0.8em' },
  '.mdr-u': { textDecoration: 'underline' },
  '.mdr-kbd': {
    fontFamily: mono,
    fontSize: '0.85em',
    border: '1px solid var(--mdr-border, #d0d0d0)',
    borderRadius: '3px',
    padding: '0 4px',
  },
  '.mdr-footnote': {
    fontSize: '0.92em',
    borderLeft: '2px solid var(--mdr-border, #d0d0d0)',
    paddingLeft: '10px',
  },
  '.mdr-fence-dim': { opacity: '0.5' },
  '.mdr-hr': { color: 'var(--mdr-muted, #bbb)' },
  '.mdr-bullet': {
    display: 'inline-block',
    width: '1.2em',
    // An inline block inherits its line's hanging indent and applies it to
    // its own content, which drew the dot that far left of its box — twice
    // as far for a nested item, whose indent is twice as deep.
    textIndent: '0',
    color: 'var(--mdr-muted, #888)',
  },
  '.mdr-checkbox': { margin: '0 0.5em 0 0', verticalAlign: 'middle' },
  '.mdr-ol-mark': { color: 'var(--mdr-muted, #888)' },
  '.mdr-table-widget': {
    borderCollapse: 'collapse',
    padding: '0.4em 0',
    fontSize: '0.95em',
  },
  '.mdr-table-widget th, .mdr-table-widget td': {
    border: '1px solid var(--mdr-border, #d0d0d0)',
    padding: '4px 8px',
    minWidth: '2.5em',
    verticalAlign: 'top',
    textAlign: 'left',
  },
  '.mdr-table-widget th': {
    fontWeight: '600',
    background: 'var(--mdr-code-bg, rgba(127, 127, 127, 0.1))',
  },
  '.mdr-table-widget td.mdr-cell-active, .mdr-table-widget th.mdr-cell-active': {
    outline: '2px solid var(--mdr-link, #2a6ad9)',
    outlineOffset: '-2px',
  },
  '.mdr-table-widget .cm-editor': { outline: 'none', background: 'transparent' },
  '.mdr-table-widget .cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.mdr-table-widget .cm-content': { padding: '0', minWidth: '2em' },
  '.mdr-table-widget .cm-line': { padding: '0' },

  // Block widgets: the frontmatter panel, a diagram, a lone image.
  //
  // Space them with padding and never with a vertical margin. The editor
  // takes a block's height from the box of the element the widget handed
  // it, and a margin is outside that box: the text below moves down by an
  // amount the height map never learns, the error adds up over a document,
  // and a click lands on the wrong line (Phase 3 gate). The table above is
  // the same rule; `border-collapse` does not swallow padding on the
  // table element, only borders.
  '.mdr-properties': {
    display: 'grid',
    gridTemplateColumns: 'minmax(6em, auto) 1fr',
    gap: '2px 10px',
    alignItems: 'baseline',
    padding: '9px 8px',
    background: 'var(--mdr-code-bg, rgba(127, 127, 127, 0.1))',
    borderRadius: '4px',
  },
  '.mdr-property': { display: 'contents' },
  '.mdr-properties input': {
    font: 'inherit',
    color: 'inherit',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '3px',
    padding: '1px 4px',
    width: '100%',
  },
  '.mdr-properties input:hover': { borderColor: 'var(--mdr-border, #d0d0d0)' },
  '.mdr-properties input:focus': {
    outline: 'none',
    borderColor: 'var(--mdr-link, #2a6ad9)',
    background: 'var(--mdr-bg, #fff)',
  },
  '.mdr-property-key': { fontWeight: '600', opacity: '0.75' },
  '.mdr-property-list': { opacity: '0.85', padding: '1px 4px' },
  '.mdr-property-add': {
    gridColumn: '1 / -1',
    justifySelf: 'start',
    font: 'inherit',
    fontSize: '0.85em',
    color: 'var(--mdr-link, #2a6ad9)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
  },
  '.mdr-mermaid': {
    display: 'block',
    padding: '11px 8px',
    textAlign: 'center',
    background: 'var(--mdr-code-bg, rgba(127, 127, 127, 0.06))',
    borderRadius: '4px',
    whiteSpace: 'pre-wrap',
  },
  '.mdr-mermaid svg': { maxWidth: '100%', height: 'auto' },
  '.mdr-math-block[data-tex]': {
    display: 'block',
    padding: '6px 8px',
    textAlign: 'center',
    whiteSpace: 'pre-wrap',
  },
  '.mdr-image-widget': { maxWidth: '100%', height: 'auto', display: 'block', padding: '0.3em 0' },
});

/**
 * What the markdown structure looks like, in Source mode and under the
 * live preview: shapes only, no colour. Bold headings and italic
 * emphasis are the same intent the preview classes carry, so the two
 * projections of one buffer never disagree.
 */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.processingInstruction, class: 'mdr-syntax' },
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, textDecoration: 'underline' },
  { tag: [tags.monospace, mathTag], fontFamily: mono },
  { tag: highlightTag, class: 'mdr-mark' },
  { tag: calloutTypeTag, fontWeight: '600' },
]);

/**
 * The code token colours, as the variables the page defines them in
 * (plan WP 1.9, plan WP 2.6).
 *
 * One style rather than one per appearance: a token's colour is
 * `var(--tok-keyword)`, and which palette that resolves to is the
 * stylesheet's business. So an editor never has to be reconfigured
 * because the reader changed theme, appearance or paper — and the fences
 * Read mode highlights name the same tokens, which is what makes a
 * fence look the same there as its source does in Source mode.
 */
export const codeHighlightStyle = HighlightStyle.define(codeHighlight());
