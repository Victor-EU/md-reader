export {
  type Annotation,
  type AnnotationKind,
  annotationKinds,
  annotations,
  classifyComment,
  type TextSource,
} from './annotations.ts';
export { Callout } from './extensions/callout.ts';
export { Frontmatter } from './extensions/frontmatter.ts';
export { Highlight } from './extensions/highlight.ts';
export { TexMath } from './extensions/math.ts';
export { extensions, parser } from './parser.ts';
export { generateDocument } from './synthetic.ts';
export { calloutTypeTag, highlightTag, mathTag } from './tags.ts';
export { dumpTree } from './tree.ts';
