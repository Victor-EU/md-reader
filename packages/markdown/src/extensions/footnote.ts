import { tags } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

const BRACKET_OPEN = 91;
const BRACKET_CLOSE = 93;
const CARET = 94;
const NEWLINE = 10;

/** `[^label]:` at the start of a line, with the label captured. */
const definition = /^\[\^([^[\]\n]+)\]:/;

/**
 * How far a continuation line must be indented to stay inside a footnote.
 * Four columns, the width GitHub and Pandoc both ask for. A shallower
 * indent still works for the first paragraph, because a paragraph
 * continues lazily the way it does inside a list item.
 */
const CONTENT_INDENT = 4;

/**
 * Footnotes, the GitHub and Pandoc syntax: `[^label]` in the text and
 * `[^label]: ...` as a block below it.
 *
 * The definition is a composite block, so its continuation lines carry
 * whatever they hold — paragraphs, lists, code — instead of being one
 * flat string. That is what lets a footnote's body be edited in place
 * like any other block, and what lets the renderer put the note where
 * the file puts it.
 *
 * A definition may interrupt a paragraph. CommonMark's link reference
 * definitions may not, and GitHub's footnotes follow the same rule as
 * this one: models write the definition on the line straight after the
 * sentence that refers to it, and the plausible intent (design 5.2) is a
 * footnote, not a paragraph that happens to start with a bracket.
 */
export const Footnote: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: { 'FootnoteReference/...': tags.labelName } },
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx, line, value) {
        // A blank line does not end the note; the next indented line
        // continues it, exactly as inside a list item.
        if (line.indent < line.baseIndent + value && line.next > -1) return false;
        line.moveBaseColumn(line.baseIndent + value);
        return true;
      },
    },
    { name: 'FootnoteMark', style: tags.processingInstruction },
    { name: 'FootnoteLabel', style: tags.labelName },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      // Before `Link`, which would otherwise take `[^1]` for a label.
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN || cx.char(pos + 1) !== CARET) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === BRACKET_OPEN || ch === NEWLINE) return -1;
          if (ch !== BRACKET_CLOSE) continue;
          if (i === pos + 2) return -1;
          return cx.addElement(
            cx.elt('FootnoteReference', pos, i + 1, [
              cx.elt('FootnoteMark', pos, pos + 2),
              cx.elt('FootnoteLabel', pos + 2, i),
              cx.elt('FootnoteMark', i, i + 1),
            ]),
          );
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      before: 'LinkReference',
      endLeaf(_cx, line) {
        return line.indent < line.baseIndent + 4 && definition.test(line.text.slice(line.pos));
      },
      parse(cx, line) {
        if (line.indent >= line.baseIndent + 4) return false;
        const m = definition.exec(line.text.slice(line.pos));
        const label = m?.[1];
        if (label === undefined) return false;
        const start = cx.lineStart + line.pos;
        const labelFrom = start + 2;
        const labelTo = labelFrom + label.length;
        const markTo = labelTo + 2;
        cx.startComposite('FootnoteDefinition', line.pos, CONTENT_INDENT);
        cx.addElement(cx.elt('FootnoteMark', start, labelFrom));
        cx.addElement(cx.elt('FootnoteLabel', labelFrom, labelTo));
        cx.addElement(cx.elt('FootnoteMark', labelTo, markTo));
        line.moveBase(line.skipSpace(markTo - cx.lineStart));
        return null;
      },
    },
  ],
};
