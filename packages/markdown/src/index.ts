export {
  type Annotation,
  type AnnotationKind,
  annotationKinds,
  annotations,
  classifyComment,
  type TextSource,
} from './annotations.ts';
export { type CorpusFile, corpusFiles, goldenSet } from './corpus.ts';
export { Callout } from './extensions/callout.ts';
export { Frontmatter } from './extensions/frontmatter.ts';
export { Highlight } from './extensions/highlight.ts';
export { TexMath } from './extensions/math.ts';
export { extensions, parser } from './parser.ts';
export { caretAt, offsetFromPoint, resolveOffset } from './render/click.ts';
export { type DomOptions, type DomResult, readDom, toDom } from './render/dom.ts';
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
export { normalizeLabel, type Reference, referenceDefinitions } from './render/references.ts';
export { headingLevel, Renderer, type RenderOptions, renderDocument } from './render/render.ts';
export { Slugger } from './render/slug.ts';
export { generateDocument } from './synthetic.ts';
export { calloutTypeTag, highlightTag, mathTag } from './tags.ts';
export { dumpTree } from './tree.ts';
