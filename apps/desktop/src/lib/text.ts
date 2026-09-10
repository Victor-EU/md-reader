import {
  type DocumentMeta,
  EDITABLE_BYTES,
  type FileFormat,
  type Error as IpcError,
  type ReadOnly,
} from '@markdown/ipc';
import type { Span } from '@markdown/markdown';

/**
 * Words as a writer counts them: runs of letters, digits, and the marks
 * that live inside a word. Markdown punctuation does not count, and CJK
 * runs count per character, which is what those writers expect.
 */
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/**
 * Count the words in `text`, ignoring anything inside `hidden`.
 *
 * `hidden` is source the reader is never shown -- comment text above all.
 * A note left in the margin is not something you wrote, so asking a
 * question about a paragraph must not make the paragraph longer; a
 * writer watching the count go up as they annotate would rightly stop
 * trusting it. `commentSpans` finds the ranges.
 *
 * The spans have to be in ascending order and must not overlap, which is
 * how a walk of the tree produces them. Matching over the whole text and
 * dropping the matches that fall inside a span keeps this one pass with
 * nothing copied, which matters at a megabyte.
 */
export function countWords(text: string, hidden: readonly Span[] = []): number {
  if (hidden.length === 0) return text.match(WORD)?.length ?? 0;
  let words = 0;
  let next = 0;
  let span = hidden[0];
  for (const match of text.matchAll(WORD)) {
    while (span && span.to <= match.index) {
      next += 1;
      span = hidden[next];
    }
    if (!span || match.index < span.from) words += 1;
  }
  return words;
}

/** `1 change`, `2 changes`: the plural the status bar keeps needing. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const EOL_LABEL: Record<FileFormat['eol'], string> = { lf: 'LF', crlf: 'CRLF', cr: 'CR' };

/** The encoding and line ending pair the status bar shows (design 4.1). */
export function describeFormat(format: FileFormat): string {
  const eol = EOL_LABEL[format.eol] + (format.mixed_eol ? ' (mixed)' : '');
  const encoding = format.encoding.toUpperCase() + (format.bom ? ' BOM' : '');
  return `${encoding} · ${eol}`;
}

/**
 * A file's size the way its own operating system says it: decimal units,
 * and no more precision than the number carries. 10 MB, not 9.5 MiB.
 */
export function describeSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let at = 0;
  let size = bytes;
  while (size >= 1000 && at < units.length - 1) {
    size /= 1000;
    at += 1;
  }
  const rounded = at === 0 || size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[at]}`;
}

/**
 * Why a document cannot be edited, in a sentence (design 8).
 *
 * One wording, used by the banner over the page, the status line when a
 * command is refused, and the line the file gets when it opens — so the
 * reader is told the same thing wherever they meet it.
 */
export function describeReadOnly(reason: ReadOnly, name: string, meta: DocumentMeta): string {
  return reason === 'encoding'
    ? `${name} is ${meta.format.encoding.toUpperCase()}; convert to UTF-8 to edit`
    : `${name} is ${describeSize(meta.byte_len)}; files over ${describeSize(EDITABLE_BYTES)} open for reading only`;
}

/** A typed IPC error as a status bar line. No dialogs (build plan rule 5). */
export function describeError(error: IpcError): string {
  switch (error.kind) {
    case 'hash_mismatch':
      return `${error.path} changed on disk; reload before saving`;
    case 'read_only_encoding':
      return `${error.path} is ${error.encoding}; convert to UTF-8 to edit`;
    case 'too_large':
      return `${error.path} is ${describeSize(error.byte_len)}, and the app opens files up to ${describeSize(error.limit)}`;
    case 'not_implemented':
      return `${error.command} is not implemented yet`;
    case 'unavailable':
      return `${error.what} is not available: ${error.message}`;
    case 'bad_query': {
      // A regex failure comes back as a little drawing: the pattern, a
      // caret under where it went wrong, and the sentence last. The
      // status bar has room for the sentence.
      const said = error.message.trimEnd().split('\n').at(-1) ?? error.message;
      return `Not a search: ${said.replace(/^error:\s*/, '').trim()}`;
    }
    default:
      return error.message;
  }
}
