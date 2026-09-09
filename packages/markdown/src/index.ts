export {
  type Anchor,
  type AnchorKind,
  colorOf,
  colorSpanOpening,
  commentAnchor,
  type Read,
} from './annotate/anchor.ts';
export {
  type AnnotationKind,
  annotationKinds,
  type CommentParts,
  type CommentRecord,
  classifyComment,
  commentParts,
  commentSpans,
  comments,
  type Span,
  type TextSource,
} from './annotate/comments.ts';
export {
  annotationLabel,
  annotationLine,
  annotationsSection,
  copyForAi,
} from './annotate/copy.ts';
export {
  type Annotation,
  type AnnotationMark,
  anchorText,
  extractAnnotations,
} from './annotate/extract.ts';
export {
  colorStyle,
  meaningOfColor,
  type PaletteEntry,
  type PaletteMeaning,
  palette,
  paletteEntry,
  paletteMeanings,
} from './annotate/palette.ts';
export { commonBlocks, type DocBlock, flattenBlocks } from './blocks.ts';
export { type CorpusFile, corpusFiles, goldenSet } from './corpus.ts';
export { Callout } from './extensions/callout.ts';
export { Footnote } from './extensions/footnote.ts';
export { Frontmatter } from './extensions/frontmatter.ts';
export { Highlight } from './extensions/highlight.ts';
export { TexMath } from './extensions/math.ts';
export { domToMarkdown, htmlToMarkdown } from './import/html.ts';
export { extensions, parser } from './parser.ts';
export { type CalloutType, calloutType, calloutTypes } from './render/callouts.ts';
export { caretAt, offsetFromPoint, resolveOffset } from './render/click.ts';
export { type DomOptions, type DomResult, readDom, toDom } from './render/dom.ts';
export {
  type FootnoteAnchor,
  FootnoteNumbers,
  footnoteDefinitions,
} from './render/footnotes.ts';
export { type HtmlOptions, toHtml } from './render/html.ts';
export {
  isElement,
  type RenderElement,
  type RenderNode,
  type RenderText,
  textOf,
  voidTags,
} from './render/nodes.ts';
export { headings, type OutlineEntry } from './render/outline.ts';
export { type Property, properties, propertyLine } from './render/properties.ts';
export { normalizeLabel, type Reference, referenceDefinitions } from './render/references.ts';
export {
  headingLevel,
  type ImageResolver,
  type ImageTarget,
  Renderer,
  type RenderOptions,
  renderDocument,
} from './render/render.ts';
export { Slugger } from './render/slug.ts';
export {
  allowedAttrs,
  HtmlStack,
  type HtmlStackOptions,
  type HtmlTag,
  type HtmlToken,
  pairTags,
  parseTag,
  tagRenders,
  tokenizeHtml,
} from './render/whitelist.ts';
export { generateDocument } from './synthetic.ts';
export { calloutTypeTag, highlightTag, mathTag } from './tags.ts';
export { dumpTree } from './tree.ts';
export { linkDestination } from './write.ts';
