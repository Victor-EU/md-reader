import { parser as commonmark, GFM, type MarkdownExtension } from '@lezer/markdown';
import { Callout } from './extensions/callout.ts';
import { Frontmatter } from './extensions/frontmatter.ts';
import { Highlight } from './extensions/highlight.ts';
import { TexMath } from './extensions/math.ts';

/**
 * The whole dialect on top of CommonMark, in one list: GFM, then this
 * app's extensions from design section 5.1. `editor-core` feeds the same
 * list to `@codemirror/lang-markdown` over its CommonMark base, so the
 * editor and every headless consumer parse identically.
 */
export const extensions: MarkdownExtension[] = [GFM, Frontmatter, Callout, TexMath, Highlight];

/** A standalone parser for headless use: block extraction, tests, tooling. */
export const parser = commonmark.configure(extensions);
