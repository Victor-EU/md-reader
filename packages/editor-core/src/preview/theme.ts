import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { calloutTypeTag, highlightTag, mathTag } from '@mdreader/markdown';

const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * Structural styling for the live preview classes. Colours go through
 * CSS variables with plain fallbacks so the app's theme can restyle
 * without touching this file; the shapes (sizes, borders, indents) are
 * the editor's own.
 */
export const previewTheme = EditorView.baseTheme({
  '.mdr-h1': { fontSize: '1.7em', fontWeight: '700', lineHeight: '1.3' },
  '.mdr-h2': { fontSize: '1.4em', fontWeight: '700', lineHeight: '1.3' },
  '.mdr-h3': { fontSize: '1.2em', fontWeight: '700' },
  '.mdr-h4, .mdr-h5, .mdr-h6': { fontWeight: '700' },
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
  '&dark .mdr-mark': { background: 'var(--mdr-highlight, #5a4a00)' },
  '.mdr-del': { textDecoration: 'line-through', opacity: '0.7' },
  '.mdr-comment, .mdr-comment-block': { opacity: '0.55', fontSize: '0.9em' },
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
  // The canonical type set of design 5.1, with the same hues Read mode
  // uses. WP 1.9 replaces both with the shared token theme.
  '.mdr-callout[data-callout=warning], .mdr-callout[data-callout=question]': {
    '--mdr-callout': '#c07000',
  },
  '.mdr-callout[data-callout=tip], .mdr-callout[data-callout=success]': {
    '--mdr-callout': '#2f8f4e',
  },
  '.mdr-callout[data-callout=caution], .mdr-callout[data-callout=danger], .mdr-callout[data-callout=failure], .mdr-callout[data-callout=bug]':
    { '--mdr-callout': '#c0392b' },
  '.mdr-callout[data-callout=important], .mdr-callout[data-callout=example]': {
    '--mdr-callout': '#8250c8',
  },
  '.mdr-callout[data-callout=abstract]': { '--mdr-callout': '#0f8ea8' },
  '.mdr-callout[data-callout=quote]': { '--mdr-callout': '#7a7a7a' },
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
    color: 'var(--mdr-muted, #888)',
  },
  '.mdr-checkbox': { margin: '0 0.5em 0 0', verticalAlign: 'middle' },
  '.mdr-ol-mark': { color: 'var(--mdr-muted, #888)' },
  '.mdr-table-widget': {
    borderCollapse: 'collapse',
    margin: '0.4em 0',
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
  '.mdr-properties': {
    display: 'grid',
    gridTemplateColumns: 'minmax(6em, auto) 1fr',
    gap: '2px 10px',
    alignItems: 'baseline',
    padding: '6px 8px',
    margin: '0.2em 0',
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
    padding: '8px',
    margin: '0.2em 0',
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
  '.mdr-image-widget': { maxWidth: '100%', height: 'auto', display: 'block', margin: '0.3em 0' },
});

/**
 * Syntax colours for Source mode and for fenced code in both modes. The
 * markdown structure tags get the same intent as the preview classes
 * (bold headings, italic emphasis) so the two never disagree; code token
 * colours follow CodeMirror's default palette.
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
  { tag: tags.keyword, color: '#708' },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: '#219' },
  { tag: [tags.literal, tags.inserted], color: '#164' },
  { tag: [tags.string, tags.deleted], color: '#a11' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#e40' },
  { tag: tags.definition(tags.variableName), color: '#00f' },
  { tag: tags.local(tags.variableName), color: '#30a' },
  { tag: [tags.typeName, tags.namespace], color: '#085' },
  { tag: tags.className, color: '#167' },
  { tag: [tags.special(tags.variableName), tags.macroName], color: '#256' },
  { tag: tags.definition(tags.propertyName), color: '#00c' },
  { tag: tags.comment, color: '#940' },
  { tag: tags.invalid, color: '#f00' },
]);
