import type { Annotation } from './extract.ts';
import { paletteEntry } from './palette.ts';

/**
 * Copy for AI (design 4.3): the markdown exactly as it is on disk, then a
 * generated list of what the reader marked.
 *
 * The section is generated and never stored, so nothing here is written
 * back to the file. It exists because a colour and a highlight say nothing
 * to a model on their own: the list turns them into sentences, and pairs
 * each one with the words the reader attached to it.
 */

const LABELS: Record<string, string> = {
  highlight: 'Highlight',
  strikethrough: 'Removed (strikethrough)',
  comment: 'Comment',
};

/** What the list calls this annotation. A palette colour is named by its meaning. */
export function annotationLabel(annotation: Annotation): string {
  if (annotation.mark === 'color') {
    return annotation.meaning === null ? 'Colored' : paletteEntry(annotation.meaning).title;
  }
  return LABELS[annotation.mark] ?? 'Annotation';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One numbered line. The comment is appended after an em dash, and left
 * out when it is empty and the label already says the same word — an
 * unfilled palette comment should not read as `Remove, "x" — remove:`.
 */
export function annotationLine(annotation: Annotation, number: number): string {
  const label = annotationLabel(annotation);
  const quoted = annotation.anchor === '' ? '' : `, "${annotation.anchor}"`;
  const comment = annotation.comment;
  let tail = '';
  if (comment) {
    const text = oneLine(comment.text);
    if (text !== '') tail = ` — ${comment.kind}: ${text}`;
    else if (annotation.meaning !== comment.kind) tail = ` — ${comment.kind}`;
  }
  return `${number}. ${label}${quoted}${tail}`;
}

/** The generated section, or the empty string when there is nothing to say. */
export function annotationsSection(annotations: readonly Annotation[]): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map((annotation, i) => annotationLine(annotation, i + 1));
  return `---\nAnnotations (${annotations.length}):\n${lines.join('\n')}\n`;
}

/**
 * The whole thing: the source, then the section. A document with no
 * annotations copies as itself, so the command is safe to reach for out
 * of habit.
 */
export function copyForAi(source: string, annotations: readonly Annotation[]): string {
  const section = annotationsSection(annotations);
  if (section === '') return source;
  return `${source.replace(/\s+$/, '')}\n\n${section}`;
}
