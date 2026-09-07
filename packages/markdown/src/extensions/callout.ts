import { tags } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';
import { calloutTypeTag } from '../tags.ts';

const GT = 62;
const SPACE = 32;
const calloutRe = /^\[!([A-Za-z0-9_-]+)\]([+-]?)(?=\s|$)/;

function skipSpaceBack(text: string, i: number, to: number): number {
  let end = i;
  while (end > to && /\s/.test(text.charAt(end - 1))) end--;
  return end;
}

/**
 * Obsidian and GitHub callouts: a blockquote whose first line is
 * `[!type]`, optionally followed by a fold sign and a title.
 *
 * The node stays a `Blockquote`, because CodeMirror's markdown keymap
 * continues `> ` on Enter only inside nodes with that name. What marks
 * it as a callout is a `CalloutHeader` first child holding `CalloutMark`,
 * `CalloutType`, `CalloutMark`, an optional `CalloutFold`, and an optional
 * `CalloutTitle` with inline content. The body lines parse as ordinary
 * blockquote content, so callouts nest and hold lists, code, and math.
 */
export const Callout: MarkdownConfig = {
  defineNodes: [
    { name: 'CalloutHeader', block: true },
    { name: 'CalloutMark', style: tags.processingInstruction },
    { name: 'CalloutType', style: calloutTypeTag },
    { name: 'CalloutFold', style: tags.processingInstruction },
    { name: 'CalloutTitle' },
  ],
  parseBlock: [
    {
      name: 'Callout',
      before: 'Blockquote',
      parse(cx, line) {
        if (line.next !== GT) return false;
        const size = line.text.charCodeAt(line.pos + 1) === SPACE ? 2 : 1;
        const start = line.skipSpace(line.pos + size);
        if (start - (line.pos + size) > 3) return false;
        const m = calloutRe.exec(line.text.slice(start));
        if (!m) return false;
        const type = m[1] ?? '';
        const fold = m[2] ?? '';

        cx.startComposite('Blockquote', line.pos);
        cx.addElement(cx.elt('QuoteMark', cx.lineStart + line.pos, cx.lineStart + line.pos + 1));

        const hFrom = cx.lineStart + start;
        const typeFrom = hFrom + 2;
        const typeTo = typeFrom + type.length;
        const children: Element[] = [
          cx.elt('CalloutMark', hFrom, typeFrom),
          cx.elt('CalloutType', typeFrom, typeTo),
          cx.elt('CalloutMark', typeTo, typeTo + 1),
        ];
        let after = typeTo + 1;
        if (fold) {
          children.push(cx.elt('CalloutFold', after, after + 1));
          after += 1;
        }
        const titleFrom = line.skipSpace(after - cx.lineStart);
        const titleTo = skipSpaceBack(line.text, line.text.length, titleFrom);
        if (titleFrom < titleTo) {
          const inline = cx.parser.parseInline(
            line.text.slice(titleFrom, titleTo),
            cx.lineStart + titleFrom,
          );
          children.push(
            cx.elt('CalloutTitle', cx.lineStart + titleFrom, cx.lineStart + titleTo, inline),
          );
        }
        const hTo = titleFrom < titleTo ? cx.lineStart + titleTo : after;
        cx.addElement(cx.elt('CalloutHeader', hFrom, hTo, children));
        line.moveBase(line.text.length);
        return null;
      },
    },
  ],
};
