import type { Input } from '@lezer/common';
import { tags } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';
import { inputOf } from './internals.ts';

const openRe = /^---\s*$/;
const closeRe = /^(?:---|\.\.\.)\s*$/;
const CHUNK = 4096;

/**
 * Find the first line at or after `from` that closes a frontmatter block.
 * Reads the input in chunks and stops at the first match, so a short
 * frontmatter on a large document costs one small read.
 */
function findClose(input: Input, from: number): { lineFrom: number; lineTo: number } | null {
  const len = input.length;
  let buf = '';
  let bufFrom = from;
  let i = 0;
  let readPos = from;
  for (;;) {
    const nl = buf.indexOf('\n', i);
    if (nl < 0) {
      if (readPos >= len) {
        const text = buf.slice(i);
        return text.length > 0 && closeRe.test(text)
          ? { lineFrom: bufFrom + i, lineTo: bufFrom + buf.length }
          : null;
      }
      const next = Math.min(len, readPos + CHUNK);
      buf = buf.slice(i) + input.read(readPos, next);
      bufFrom += i;
      i = 0;
      readPos = next;
      continue;
    }
    if (closeRe.test(buf.slice(i, nl))) return { lineFrom: bufFrom + i, lineTo: bufFrom + nl };
    i = nl + 1;
  }
}

/**
 * YAML frontmatter: a `---` line at the very start of the document, closed
 * by a `---` or `...` line. Only a closed block is frontmatter; an opening
 * line with no closing line anywhere below stays a horizontal rule, which
 * is what the stock parser makes of it and what a reader expects while
 * typing the block. The lookahead is what makes that possible, since a
 * block parser cannot give lines back once it has consumed them.
 *
 * The YAML is never parsed here. `FrontmatterContent` is the exact text
 * between the marks, for a properties panel that edits lines in place.
 */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: tags.processingInstruction },
    { name: 'FrontmatterContent', style: tags.meta },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'IndentedCode',
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.parsedPos !== 0 || cx.depth !== 1 || line.pos !== 0)
          return false;
        if (!openRe.test(line.text)) return false;
        const input = inputOf(cx);
        if (!input) return false;
        const close = findClose(input, line.text.length + 1);
        if (!close) return false;

        const children: Element[] = [cx.elt('FrontmatterMark', 0, 3)];
        let contentFrom = -1;
        let contentTo = -1;
        while (cx.nextLine()) {
          if (cx.parsedPos >= close.lineFrom) break;
          if (contentFrom < 0) contentFrom = cx.lineStart;
          contentTo = cx.lineStart + line.text.length;
        }
        if (contentFrom >= 0) children.push(cx.elt('FrontmatterContent', contentFrom, contentTo));
        if (cx.parsedPos === close.lineFrom) {
          children.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + 3));
          cx.nextLine();
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};
