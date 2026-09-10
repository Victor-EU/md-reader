import { isUrl } from '@markdown/editor-core';
import { domToMarkdown, linkDestination } from '@markdown/markdown';

/**
 * What a paste or a drop turns out to be (design 4.5).
 *
 * The clipboard usually carries the same thing three ways at once — a
 * copied link is HTML, plain text, and sometimes a file — so the order
 * these are decided in is the whole design. Images first, because an
 * image on the clipboard is unambiguous. Then a URL over a selection,
 * because that gesture has one obvious meaning and the HTML flavour of it
 * does not. Then rich text, when there is any formatting to keep. Then
 * the editor's own paste, which is exact.
 */
export type PastePlan =
  | { kind: 'images'; files: readonly File[] }
  | { kind: 'link'; url: string }
  | { kind: 'markdown'; text: string }
  | { kind: 'text' };

/** The part of a `DataTransfer` this needs, so a test can hand over a plain object. */
export interface Transfer {
  files: readonly File[];
  getData(type: string): string;
}

/**
 * The tags whose meaning would be lost as plain text.
 *
 * Every browser puts `text/html` on the clipboard, even for a line of
 * plain prose copied out of a text editor, wrapped in a `meta` and a
 * `span` of styling. Converting that would only escape the writer's own
 * asterisks. So the HTML flavour is taken only when it holds something
 * markdown has a word for.
 */
const STRUCTURE =
  'a,b,strong,i,em,s,del,strike,mark,code,pre,img,br,hr,ul,ol,li,table,blockquote,h1,h2,h3,h4,h5,h6,sub,sup,kbd,u';

/** The body of a fragment, when it holds something markdown has a word for. */
function structured(html: string): HTMLElement | null {
  if (html.trim() === '') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.querySelector(STRUCTURE) === null ? null : doc.body;
}

export function hasStructure(html: string): boolean {
  return structured(html) !== null;
}

function images(files: readonly File[]): readonly File[] {
  return files.filter((file) => file.type.startsWith('image/'));
}

export function pastePlan(data: Transfer | null, selected: boolean): PastePlan {
  if (!data) return { kind: 'text' };
  const found = images([...data.files]);
  if (found.length > 0) return { kind: 'images', files: found };
  const text = data.getData('text/plain');
  if (selected && isUrl(text.trim())) return { kind: 'link', url: text.trim() };
  const body = structured(data.getData('text/html'));
  if (body) {
    const markdown = domToMarkdown(body);
    if (markdown !== '') return { kind: 'markdown', text: markdown };
  }
  return { kind: 'text' };
}

/** The extensions a dropped file has to have before it is treated as an image. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic|svg)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_FILE.test(path);
}

/** Base64 for the bridge, which takes one string but not a million numbers. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: `apply` on a whole megabyte overflows the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The link a stored image gets. The alt text is the file's own name
 * without its extension, which is the only description anybody has at
 * paste time and is better than an empty one for a reader who cannot see
 * the image.
 */
export function imageLink(name: string, relative: string): string {
  const alt = name
    .replace(/\.[^.]*$/, '')
    .replace(/[[\]\\]/g, ' ')
    .trim();
  return `![${alt}](${linkDestination(relative)})`;
}
