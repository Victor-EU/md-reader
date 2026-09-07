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
    background: 'var(--mdr-callout-bg, rgba(42, 106, 217, 0.07))',
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
  '.mdr-fence-dim': { opacity: '0.5' },
  '.mdr-hr': { color: 'var(--mdr-muted, #bbb)' },
  '.mdr-bullet': {
    display: 'inline-block',
    width: '1.2em',
    color: 'var(--mdr-muted, #888)',
  },
  '.mdr-checkbox': { margin: '0 0.5em 0 0', verticalAlign: 'middle' },
  '.mdr-ol-mark': { color: 'var(--mdr-muted, #888)' },
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
