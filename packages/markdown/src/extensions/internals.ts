import type { Input } from '@lezer/common';
import type { BlockContext, Line } from '@lezer/markdown';

/**
 * Two fields that `@lezer/markdown` keeps out of its type declarations but
 * that its own block parsers rely on. They are read here in exactly one
 * place so a future release that renames them breaks one file and the
 * fixture tests that pin the behaviour, not five parsers.
 *
 * `Line.depth` is the number of enclosing composite blocks whose markup
 * the current line still carries. When it drops below `cx.depth` a
 * container such as a blockquote has ended and a multi-line construct
 * must stop, which is how `FencedCode` and `HTMLBlock` know to stop.
 *
 * `BlockContext.input` is the document being parsed. Frontmatter needs it
 * to look ahead for a closing line, because a block parser cannot rewind
 * once it has consumed lines.
 */

/** True while the composite blocks that were open when a construct started are still open. */
export function containerContinues(cx: BlockContext, line: Line): boolean {
  const depth = (line as unknown as { depth?: unknown }).depth;
  return typeof depth === 'number' ? depth >= cx.depth : true;
}

/** The document, or null when the field is missing. Callers must have a safe fallback. */
export function inputOf(cx: BlockContext): Input | null {
  const input = (cx as unknown as { input?: unknown }).input;
  if (
    input &&
    typeof (input as Input).read === 'function' &&
    typeof (input as Input).length === 'number'
  ) {
    return input as Input;
  }
  return null;
}
