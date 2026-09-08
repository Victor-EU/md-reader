import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { annotationLine, copyForAi } from './copy.ts';
import { type Annotation, extractAnnotations } from './extract.ts';

/** Fixtures that carry marks or comments; the rest would copy as themselves. */
const files = ['annotations.md', 'comments.md', 'highlight.md', 'inline-html.md'];

function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
}

function forAi(source: string): string {
  return copyForAi(source, extractAnnotations(parser.parse(source), source));
}

describe('Copy for AI goldens', () => {
  for (const name of files) {
    it(name, async () => {
      await expect(forAi(fixture(name))).toMatchFileSnapshot(
        fileURLToPath(
          new URL(
            `../../../../corpus/goldens/copy-for-ai/${name.replace(/\.md$/, '.txt')}`,
            import.meta.url,
          ),
        ),
      );
    });
  }
});

describe('copyForAi', () => {
  it('copies a document with no annotations as itself, byte for byte', () => {
    const source = '# Title\n\nA paragraph.\n';
    expect(forAi(source)).toBe(source);
  });

  it('separates the section from the source by one blank line', () => {
    expect(forAi('==a==\n\n\n')).toBe('==a==\n\n---\nAnnotations (1):\n1. Highlight, "a"\n');
  });
});

function line(annotation: Partial<Annotation>): string {
  return annotationLine(
    { mark: 'highlight', meaning: null, anchor: 'a', from: 0, to: 0, comment: null, ...annotation },
    1,
  );
}

const note = (kind: string, text: string) => ({
  kind: kind as 'note',
  text,
  from: 0,
  to: 0,
  block: false,
});

describe('annotationLine', () => {
  it.each([
    [{}, '1. Highlight, "a"'],
    [{ mark: 'strikethrough' as const }, '1. Removed (strikethrough), "a"'],
    [{ mark: 'color' as const, meaning: 'question' as const }, '1. Question, "a"'],
    [{ mark: 'color' as const }, '1. Colored, "a"'],
    [{ comment: note('note', 'why') }, '1. Highlight, "a" — note: why'],
    [{ mark: 'comment' as const, anchor: '', comment: note('keep', 'k') }, '1. Comment — keep: k'],
    // A palette comment the reader never filled in says the meaning once.
    [
      { mark: 'color' as const, meaning: 'remove' as const, comment: note('remove', '') },
      '1. Remove, "a"',
    ],
    [{ comment: note('remove', '') }, '1. Highlight, "a" — remove'],
    [{ comment: note('note', 'two\nlines') }, '1. Highlight, "a" — note: two lines'],
  ])('%j', (annotation, expected) => {
    expect(line(annotation)).toBe(expected);
  });
});
