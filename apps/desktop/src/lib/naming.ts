/**
 * What to call a file nobody has named yet (design 4.5, scenario S8).
 *
 * The first save proposes a name from the document's first heading,
 * because that is what the reader has already written the title as. What
 * is left of it has to be a name both platforms will take, which is the
 * whole of the work here: one build serves macOS and Windows, and the
 * stricter of the two decides.
 */

/**
 * Path separators, what Windows refuses outright, and the invisible
 * characters — controls, zero-width joiners, direction marks — that make
 * a file name nobody can retype.
 */
const ILLEGAL = /[<>:"/\\|?*\p{C}]+/gu;

/** Names Windows keeps for devices, with or without an extension. */
const DEVICES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Long enough for a heading somebody wrote as a title, short enough to
 * read in a tab and to leave room in a path. Headings run long; file
 * names should not.
 */
const MAX = 60;

/** Extensions the app already opens; a heading that ends in one keeps it. */
const KNOWN = /\.(?:md|markdown|mdx|txt)$/i;

const EXTENSION = '.md';

/**
 * Cut at a word boundary when there is one worth cutting at, counting in
 * characters rather than code units so an emoji is never halved.
 */
function trimTo(text: string, max: number): string {
  const points = [...text];
  if (points.length <= max) return text;
  const cut = points.slice(0, max).join('');
  // The cut may already be at a boundary, with the space just past it.
  if (points[max] === ' ') return cut;
  const space = cut.lastIndexOf(' ');
  return space > max / 2 ? cut.slice(0, space) : cut;
}

/**
 * A heading as a file name, or null when nothing usable survives.
 *
 * The text comes from the renderer, so `# The **fast** path` arrives as
 * `The fast path` and there is no markup left to strip. Spaces and case
 * are kept: this is the reader's own title, not a slug.
 */
export function fileNameFrom(heading: string): string | null {
  const cleaned = trimTo(heading.replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim(), MAX);
  // A leading dot hides the file on Unix; a trailing dot or space is a
  // name Windows quietly drops the end of.
  const name = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return name === '' || DEVICES.test(name) ? null : name;
}

/**
 * The name the save panel opens with: the heading if it gives one, the
 * document's own `Untitled 3` if it does not.
 */
export function proposeFileName(heading: string | null, fallback: string): string {
  const name =
    (heading === null ? null : fileNameFrom(heading)) ?? fileNameFrom(fallback) ?? 'Untitled';
  return KNOWN.test(name) ? name : `${name}${EXTENSION}`;
}

/**
 * The names the app hands out itself, `Untitled 3`, as opposed to one
 * the reader typed over it in the toolbar (ADR 0037).
 */
const GIVEN = /^Untitled(?: (\d+))?$/;

/**
 * The number in a name the app gave a document, so that a new one does
 * not reuse a restored one. Null for a name the reader chose, which is
 * not one of the app's numbers however it happens to end.
 */
export function untitledNumber(name: string): number | null {
  const given = GIVEN.exec(name);
  return given === null ? null : Number(given[1] ?? 0);
}

/**
 * A file's new name, typed over the old one in the toolbar (ADR 0037).
 *
 * The reader is renaming the document, not changing what kind of file
 * it is, so a name typed without the extension keeps the one the file
 * had. Moving between the extensions the app opens is left to them.
 */
export function renamedFile(typed: string, old: string): string {
  const name = typed.trim();
  const dot = old.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not an extension.
  const extension = dot > 0 ? old.slice(dot) : '';
  if (extension === '' || KNOWN.test(name)) return name;
  return name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`;
}
