import { Tag, tags } from '@lezer/highlight';

/**
 * Highlight tags for the dialect's own nodes. Source mode and any theme
 * target these; the stock markdown nodes keep their `@lezer/highlight` tags.
 */

/** `==text==`. No parent: a theme styles it on purpose or not at all. */
export const highlightTag = Tag.define();

/** TeX source inside `$...$` and `$$...$$`. Falls back to monospace. */
export const mathTag = Tag.define(tags.monospace);

/** The `[!type]` word of a callout header. Falls back to label styling. */
export const calloutTypeTag = Tag.define(tags.labelName);
