import { describe, expect, it } from 'vitest';
import { resolveImage } from './images.ts';
import { isAbsolute, resolvePath } from './paths.ts';

const assetUrl = (path: string) => `asset://localhost/${path}`;
const doc = { path: '/home/w/notes/report.md', remote: false, assetUrl };

describe('resolveImage', () => {
  it('resolves a relative source against the document folder', () => {
    expect(resolveImage('pictures/a.png', doc)).toEqual({
      url: 'asset://localhost//home/w/notes/pictures/a.png',
    });
    expect(resolveImage('./a.png', doc).url).toBe('asset://localhost//home/w/notes/a.png');
    expect(resolveImage('../shared/a.png', doc).url).toBe('asset://localhost//home/w/shared/a.png');
  });

  it('takes an absolute local path as it stands', () => {
    expect(resolveImage('/var/pics/a.png', doc).url).toBe('asset://localhost//var/pics/a.png');
  });

  it('undoes percent encoding and drops a query', () => {
    expect(resolveImage('my%20photo.png?v=2', doc).url).toBe(
      'asset://localhost//home/w/notes/my photo.png',
    );
  });

  it('blocks a remote source until the document allows it', () => {
    expect(resolveImage('https://x.test/a.png', doc)).toEqual({ url: null, blocked: 'remote' });
    expect(resolveImage('//x.test/a.png', doc)).toEqual({ url: null, blocked: 'remote' });
    expect(resolveImage('https://x.test/a.png', { ...doc, remote: true }).url).toBe(
      'https://x.test/a.png',
    );
  });

  it('loads a data URL either way, since it asks nobody anything', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    expect(resolveImage(src, doc).url).toBe(src);
  });

  it('loads nothing local without a folder or an asset protocol', () => {
    expect(resolveImage('a.png', { path: null, remote: false, assetUrl })).toEqual({
      url: null,
      blocked: 'unavailable',
    });
    expect(resolveImage('a.png', { path: doc.path, remote: false })).toEqual({
      url: null,
      blocked: 'unavailable',
    });
  });
});

describe('path resolution', () => {
  it.each([
    ['/a/b', true],
    ['C:\\a', true],
    ['\\\\server\\share', true],
    ['a/b', false],
    ['./a', false],
    ['../a', false],
  ])('isAbsolute(%j) is %s', (path, expected) => {
    expect(isAbsolute(path)).toBe(expected);
  });

  it('keeps the separators the folder already uses', () => {
    expect(resolvePath('C:\\notes\\sub', 'pics/a.png')).toBe('C:\\notes\\sub\\pics\\a.png');
    expect(resolvePath('/notes/sub', '../a.png')).toBe('/notes/a.png');
  });

  it('does not climb above the root it was given', () => {
    expect(resolvePath('/notes', '../../../a.png')).toBe('/a.png');
  });
});
