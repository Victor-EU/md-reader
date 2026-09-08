import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { anchorText, extractAnnotations } from './extract.ts';

const fixture = readFileSync(new URL('../../fixtures/annotations.md', import.meta.url), 'utf8');

function extract(doc: string) {
  return extractAnnotations(parser.parse(doc), doc).map((a) => [
    a.mark,
    a.meaning,
    a.anchor,
    a.comment ? `${a.comment.kind}: ${a.comment.text}` : null,
  ]);
}

describe('extractAnnotations', () => {
  it('reads the fixture as the reader wrote it', () => {
    expect(extract(fixture)).toEqual([
      [
        'highlight',
        null,
        'the migration can be done in one sprint',
        'note: too ambitious, cut to two weeks',
      ],
      ['strikethrough', null, 'Rewrite the auth service', null],
      [
        'color',
        'question',
        'Do we still need the legacy exporter?',
        'question: is this still used',
      ],
      ['color', 'keep', 'the nightly job', null],
      [
        'comment',
        null,
        'The rollout window is the last week of the quarter, assuming the staging soak finishes on time and…',
        'rewrite: this section reads like a status update',
      ],
      ['highlight', null, 'bare highlight', null],
      ['color', null, 'colour of their own', null],
      ['comment', null, '', 'attention: read this twice'],
    ]);
  });

  it('names the source range of the span, not of the comment', () => {
    const doc = 'a ==b== <!-- note: c -->';
    const [record] = extractAnnotations(parser.parse(doc), doc);
    expect([record?.from, record?.to]).toEqual([2, 7]);
    expect([record?.comment?.from, record?.comment?.to]).toEqual([8, 24]);
  });

  it('anchors only across whitespace', () => {
    const doc = '==marked== and more words <!-- note: x -->';
    expect(extract(doc)).toEqual([
      ['highlight', null, 'marked', null],
      ['comment', null, '', 'note: x'],
    ]);
  });

  it('gives one comment to one mark, so a second note stands alone', () => {
    const doc = '==m==<!-- note: one --><!-- keep: two -->';
    expect(extract(doc)).toEqual([
      ['highlight', null, 'm', 'note: one'],
      ['comment', null, '', 'keep: two'],
    ]);
  });

  it('leaves a span whose tag never closes quoting nothing', () => {
    const doc = 'text <span style="color:#dc2626">unclosed';
    expect(extract(doc)).toEqual([['color', 'remove', '', null]]);
  });

  it('ignores a span that sets anything but a colour', () => {
    expect(extract('<span style="font-size:9px">x</span>')).toEqual([]);
    expect(extract('<span class="x">y</span>')).toEqual([]);
  });

  it('reads a comment inside a list item and a blockquote', () => {
    expect(extract('- ==a== <!-- keep: k -->\n')).toEqual([['highlight', null, 'a', 'keep: k']]);
    expect(extract('> ==a== <!-- keep: k -->\n')).toEqual([['highlight', null, 'a', 'keep: k']]);
  });

  it('takes the innermost span when colours nest', () => {
    const doc =
      '<span style="color:#dc2626">out <span style="color:#16a34a">in</span></span><!-- keep: k -->';
    expect(extract(doc)).toEqual([
      ['color', 'remove', 'out <span style="color:#16a34a">in</span>', 'keep: k'],
      ['color', 'keep', 'in', null],
    ]);
  });
});

describe('anchorText', () => {
  it('collapses whitespace and cuts long text at a word', () => {
    expect(anchorText('  two\n  lines ')).toBe('two lines');
    expect(anchorText(`${'ab '.repeat(40)}end`)).toBe(`${'ab '.repeat(33).trim()}…`);
    expect(anchorText('x'.repeat(120))).toBe(`${'x'.repeat(100)}…`);
  });
});
