import { tags } from '@lezer/highlight';
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import { mathTag } from '../tags.ts';
import { containerContinues } from './internals.ts';

const DOLLAR = 36;
const BACKSLASH = 92;

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

function skipSpaceBack(text: string, i: number, to: number): number {
  let end = i;
  while (end > to && isSpace(text.charCodeAt(end - 1))) end--;
  return end;
}

/** True when `text[from..end)` ends with `$$` and is at least that long. */
function endsWithDollars(text: string, end: number, from: number): boolean {
  return (
    end - from >= 2 && text.charCodeAt(end - 1) === DOLLAR && text.charCodeAt(end - 2) === DOLLAR
  );
}

/**
 * Append a `MathContent` piece, merging it into the previous piece when
 * the two touch, so a formula spanning plain lines is one node and a
 * formula inside a blockquote is one node per line, with the `>` markers
 * between them as siblings. Concatenating the pieces yields the formula.
 */
function pushContent(cx: BlockContext, children: Element[], from: number, to: number): void {
  const piece = cx.elt('MathContent', from, to);
  const last = children[children.length - 1];
  if (last && last.type === piece.type && last.to === from) {
    children[children.length - 1] = cx.elt('MathContent', last.from, to);
  } else {
    children.push(piece);
  }
}

function isBlockMathStart(line: Line): boolean {
  return line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR;
}

/**
 * Per inline section, the first opener position of each size whose scan
 * found no closer. Whether a `$` closes does not depend on where the
 * opener was, so once a scan from `p` fails, every later opener of the
 * same size fails too and can answer at once. Without this a paragraph
 * full of prices, "$5, $10, $15, ...", scans to its end from every `$`
 * and parsing goes quadratic in the paragraph length.
 */
const noCloserAfter = new WeakMap<InlineContext, { single: number; double: number }>();

/**
 * TeX math with Pandoc's `tex_math_dollars` rules.
 *
 * Inline: `$...$` where the opening `$` is followed by non-space and the
 * closing `$` is preceded by non-space and not followed by a digit, so
 * "$5 and $10" stays prose. `$$...$$` inside a paragraph is display math
 * in the flow of text and gets the same `InlineMath` node with two-character
 * marks. Backslash-escaped dollars never open or close.
 *
 * Block: a line starting with `$$` opens `BlockMath`, and like a code
 * fence it interrupts a paragraph, because "The equation is:" followed
 * directly by a `$$` line is how models write display math. It closes at
 * the first line that ends with `$$`, possibly the same line. A blank line ends
 * it unclosed (Pandoc allows no blank lines in display math), as does the
 * end of the enclosing blockquote or list item. An unclosed block has no
 * closing `MathMark`, which is how a renderer knows to show source rather
 * than a formula. This differs from Pandoc, which falls back to prose; the
 * parser cannot rewind consumed lines, and an honest partial node is
 * better than a fabricated paragraph.
 */
export const TexMath: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: { 'InlineMath/...': mathTag } },
    { name: 'BlockMath', block: true, style: { 'BlockMath/...': mathTag } },
    { name: 'MathMark', style: tags.processingInstruction },
    { name: 'MathContent' },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      after: 'InlineCode',
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        const size = cx.char(pos + 1) === DOLLAR ? 2 : 1;
        const contentStart = pos + size;
        if (contentStart >= cx.end) return -1;
        if (size === 1 && isSpace(cx.char(contentStart))) return -1;
        const failed = noCloserAfter.get(cx);
        if (failed && (size === 1 ? failed.single : failed.double) <= pos) return -1;
        for (let i = contentStart; i < cx.end; i++) {
          if (cx.char(i) !== DOLLAR || cx.char(i - 1) === BACKSLASH) continue;
          if (size === 2) {
            if (cx.char(i + 1) !== DOLLAR) continue;
          } else if (isSpace(cx.char(i - 1)) || (i + 1 < cx.end && isDigit(cx.char(i + 1)))) {
            continue;
          }
          if (i === contentStart) continue;
          return cx.addElement(
            cx.elt('InlineMath', pos, i + size, [
              cx.elt('MathMark', pos, contentStart),
              cx.elt('MathMark', i, i + size),
            ]),
          );
        }
        const entry = failed ?? {
          single: Number.MAX_SAFE_INTEGER,
          double: Number.MAX_SAFE_INTEGER,
        };
        if (size === 1) entry.single = Math.min(entry.single, pos);
        else entry.double = Math.min(entry.double, pos);
        noCloserAfter.set(cx, entry);
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      endLeaf(_cx, line) {
        return isBlockMathStart(line);
      },
      parse(cx, line) {
        if (!isBlockMathStart(line)) return false;
        const from = cx.lineStart + line.pos;
        const children: Element[] = [cx.elt('MathMark', from, from + 2)];
        const restFrom = line.pos + 2;
        const restEnd = skipSpaceBack(line.text, line.text.length, restFrom);

        if (endsWithDollars(line.text, restEnd, restFrom)) {
          const cFrom = line.skipSpace(restFrom);
          const cTo = skipSpaceBack(line.text, restEnd - 2, cFrom);
          if (cFrom < cTo) pushContent(cx, children, cx.lineStart + cFrom, cx.lineStart + cTo);
          children.push(cx.elt('MathMark', cx.lineStart + restEnd - 2, cx.lineStart + restEnd));
          cx.nextLine();
          cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), children));
          return true;
        }

        const openContent = line.skipSpace(restFrom);
        let hasContent = false;
        if (openContent < line.text.length) {
          pushContent(cx, children, cx.lineStart + openContent, cx.lineStart + line.text.length);
          hasContent = true;
        }
        while (cx.nextLine() && containerContinues(cx, line)) {
          if (line.pos === line.text.length) break;
          const textStart = cx.lineStart + line.basePos;
          const trimmed = skipSpaceBack(line.text, line.text.length, line.basePos);
          const closing = endsWithDollars(line.text, trimmed, line.basePos);
          const textEnd = closing
            ? cx.lineStart + skipSpaceBack(line.text, trimmed - 2, line.basePos)
            : cx.lineStart + line.text.length;
          // Children must stay in position order: the newline that joins
          // two content lines sits before this line's container markers.
          if (hasContent && textStart < textEnd)
            pushContent(cx, children, cx.lineStart - 1, cx.lineStart);
          for (const m of line.markers) children.push(m);
          if (textStart < textEnd) {
            pushContent(cx, children, textStart, textEnd);
            hasContent = true;
          }
          if (closing) {
            children.push(cx.elt('MathMark', cx.lineStart + trimmed - 2, cx.lineStart + trimmed));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
};
