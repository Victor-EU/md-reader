import { tags } from '@lezer/highlight';
import type { DelimiterType, MarkdownConfig } from '@lezer/markdown';
import { highlightTag } from '../tags.ts';

const EQUALS = 61;
const punctuation = /[\p{S}\p{P}]/u;
const spaceOrEdge = /\s|^$/;

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };

/**
 * `==text==`, the highlight syntax shared by Obsidian, Typora, iA Writer
 * and markdown-it-mark. Same flanking rules as GFM strikethrough: a run
 * of exactly two `=`, opening when followed by non-space, closing when
 * preceded by non-space, with punctuation handled the CommonMark way.
 */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightTag } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS)
          return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = spaceOrEdge.test(before);
        const sAfter = spaceOrEdge.test(after);
        const pBefore = punctuation.test(before);
        const pAfter = punctuation.test(after);
        const canOpen = !sAfter && (!pAfter || sBefore || pBefore);
        const canClose = !sBefore && (!pBefore || sAfter || pAfter);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
      },
    },
  ],
};
