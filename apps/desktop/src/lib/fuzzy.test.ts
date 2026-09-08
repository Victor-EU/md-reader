import { describe, expect, it } from 'vitest';
import { match, rank } from './fuzzy.ts';

const positions = (query: string, text: string) => match(query, text)?.positions;
const score = (query: string, text: string) => match(query, text)?.score ?? Number.NaN;

describe('match', () => {
  it('matches a subsequence and reports where', () => {
    expect(positions('rdm', 'readme.md')).toEqual([0, 3, 4]);
  });

  it('returns null when a character is missing', () => {
    expect(match('xyz', 'readme.md')).toBeNull();
  });

  it('treats an empty query as a match with no highlights', () => {
    expect(match('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('prefers a word start over an earlier character', () => {
    expect(positions('p', 'app/plan.md')).toEqual([4]);
    expect(positions('mp', 'docs/markdown-plan.md')).toEqual([5, 14]);
  });

  it('finds the run a greedy match would miss', () => {
    expect(positions('plan', 'docs/markdown-app-build-plan.md')).toEqual([24, 25, 26, 27]);
  });

  it('reads camelCase and separators as word starts', () => {
    expect(positions('tc', 'tabCount')).toEqual([0, 3]);
    expect(positions('om', 'Open Markdown File')).toEqual([0, 5]);
  });

  it('scores a prefix above a scattered match', () => {
    expect(score('plan', 'plan.md')).toBeGreaterThan(score('plan', 'peculiar-lane-notes.md'));
  });

  it('scores the shorter of two equal matches higher', () => {
    expect(score('note', 'note.md')).toBeGreaterThan(score('note', 'note-from-yesterday.md'));
  });
});

describe('rank', () => {
  const files = ['docs/markdown-app-build-plan.md', 'notes/plants.md', 'README.md'];

  it('drops what does not match and puts the best first', () => {
    const ranked = rank('bplan', files, (f) => f);
    expect(ranked.map((r) => r.item)).toEqual(['docs/markdown-app-build-plan.md']);
    // `plan` ends a word in the first, and only runs into `plants` in the second.
    expect(rank('an', files, (f) => f).map((r) => r.item)).toEqual([
      'docs/markdown-app-build-plan.md',
      'notes/plants.md',
    ]);
  });

  it('keeps the caller order for an empty query', () => {
    expect(rank('', files, (f) => f).map((r) => r.item)).toEqual(files);
  });
});
