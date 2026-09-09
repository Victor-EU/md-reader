import { type FootnoteReference, noteDefinedOn, notesMentionedOn } from './footnotes.ts';
import { type Reference, referenceOn } from './references.ts';
import { lineRangesOutsideCode } from './scan.ts';

/**
 * What the renderer has to know about the whole file before it can render
 * any part of it, found in one walk of the lines.
 *
 * All three are properties of the document rather than of the block being
 * rendered: `[text][ref]` is a link whether its definition is above or
 * below, a note's number is where the document first mentions it, and a
 * note is a note because something at the end of the file defines it.
 * Read mode builds one screenful at a time and has to give the same
 * answer as a whole-document render, so they are settled up front — and a
 * file that may be a hundred megabytes (design 8) is not one to walk
 * three times over.
 */
export interface SourceScan {
  /** `[label]: url "title"` definitions, by normalized label. */
  references: Map<string, Reference>;
  /** The labels `[^label]:` definitions give. */
  notes: Set<string>;
  /** Every label the text refers to, in the order it first mentions each. */
  mentions: FootnoteReference[];
}

export function scanSource(source: string): SourceScan {
  const references = new Map<string, Reference>();
  const notes = new Set<string>();
  const mentions: FootnoteReference[] = [];
  const named = new Set<string>();
  // Where the file says `[^` at all. Found in one pass of its own, so
  // that asking whether a line mentions a note is a comparison rather
  // than a search through the rest of the document.
  const marks: number[] = [];
  for (let i = source.indexOf('[^'); i >= 0; i = source.indexOf('[^', i + 2)) marks.push(i);
  let mark = 0;
  for (const { at, end } of lineRangesOutsideCode(source)) {
    while (mark < marks.length && (marks[mark] as number) < at) mark += 1;
    const mentioned = mark < marks.length && (marks[mark] as number) < end;
    // Everything looked for here is a `[`: at the start of the line for
    // a definition, anywhere in it for a mention. A line with neither is
    // most of the document and is left where it lies.
    if (!mentioned && !opensBracket(source, at, end)) continue;
    const line = source.slice(at, end);
    const note = noteDefinedOn(line);
    if (note !== null) {
      notes.add(note);
      continue;
    }
    const made = referenceOn(line);
    if (made !== null) {
      // The first definition of a label wins, as CommonMark says.
      if (!references.has(made.label)) references.set(made.label, made.target);
      continue;
    }
    for (const { label, column } of notesMentionedOn(line)) {
      if (named.has(label)) continue;
      named.add(label);
      mentions.push({ label, at: at + column });
    }
  }
  return { references, notes, mentions };
}

/** A `[` after up to three spaces, which is how every definition starts. */
function opensBracket(source: string, at: number, end: number): boolean {
  for (let i = at; i < end && i < at + 4; i++) {
    const code = source.charCodeAt(i);
    if (code === 0x5b) return true;
    if (code !== 0x20) return false;
  }
  return false;
}
