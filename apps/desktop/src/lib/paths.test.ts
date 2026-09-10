import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  fileUrlToPath,
  inside,
  isPdfPath,
  shortenDir,
  tabLabels,
} from './paths.ts';

describe('basename and dirname', () => {
  it('handle both separators', () => {
    expect(basename('/Users/a/notes.md')).toBe('notes.md');
    expect(basename('C:\\Users\\a\\notes.md')).toBe('notes.md');
    expect(dirname('/Users/a/notes.md')).toBe('/Users/a');
    expect(dirname('notes.md')).toBe('');
  });
});

describe('tabLabels', () => {
  it('uses the file name when it is unique', () => {
    expect(tabLabels(['/a/one.md', '/b/two.md'], [])).toEqual(['one.md', 'two.md']);
  });

  it('adds parent directories until the labels differ', () => {
    expect(tabLabels(['/site/docs/index.md', '/blog/docs/index.md'], [])).toEqual([
      'site/docs/index.md',
      'blog/docs/index.md',
    ]);
  });

  it('leaves untitled tabs with their fallback name', () => {
    expect(tabLabels([null, '/a/one.md'], ['Untitled 1'])).toEqual(['Untitled 1', 'one.md']);
  });
});

describe('inside', () => {
  it('says what is under a folder and what only starts like it', () => {
    expect(inside('/w', '/w/notes/a.md')).toBe(true);
    expect(inside('/w', '/w')).toBe(true);
    expect(inside('/w/', '/w/a.md')).toBe(true);
    // The separator is part of the question: this is a different folder.
    expect(inside('/w', '/work/a.md')).toBe(false);
    expect(inside('/w', '/elsewhere/a.md')).toBe(false);
  });

  it('works on the other separator too, since one build serves both', () => {
    expect(inside('C:\\w', 'C:\\w\\a.md')).toBe(true);
    expect(inside('C:\\w', 'C:\\work\\a.md')).toBe(false);
  });
});

describe('shortenDir', () => {
  it('keeps the tail of a long path', () => {
    expect(shortenDir('/Users/a/notes/work')).toBe('…/notes/work');
    expect(shortenDir('/Users/a')).toBe('/Users/a');
    expect(shortenDir('')).toBe('');
  });
});

describe('fileUrlToPath', () => {
  it('decodes a dropped URL', () => {
    expect(fileUrlToPath('file:///Users/a/my%20notes.md')).toBe('/Users/a/my notes.md');
    expect(fileUrlToPath('file:///C:/Users/a/notes.md')).toBe('C:/Users/a/notes.md');
    expect(fileUrlToPath('https://example.com/a.md')).toBeNull();
  });
});

describe('isPdfPath', () => {
  it('recognises one however it is spelled', () => {
    expect(isPdfPath('/a/paper.pdf')).toBe(true);
    expect(isPdfPath('C:\\docs\\Paper.PDF')).toBe(true);
  });

  it('leaves everything else to open as a document', () => {
    // Asked of a path the OS handed over, before anything is read: a
    // file whose name says nothing opens the way it always has.
    expect(isPdfPath('/a/notes.md')).toBe(false);
    expect(isPdfPath('/a/pdf')).toBe(false);
    expect(isPdfPath('/a/paper.pdf.md')).toBe(false);
  });
});
