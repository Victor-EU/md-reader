import { parser as commonmark, GFM, type MarkdownExtension } from '@lezer/markdown';

/**
 * The dialect extensions this app adds on top of GFM. Empty in WP 0.1;
 * WP 0.2 adds Highlight, InlineMath, BlockMath, Callout, Frontmatter.
 *
 * `editor-core` feeds the same list to `@codemirror/lang-markdown`, so the
 * editor and every headless consumer parse identically.
 */
export const extensions: MarkdownExtension[] = [];

/** A standalone parser for headless use: block extraction, tests, tooling. */
export const parser = commonmark.configure([GFM, ...extensions]);
