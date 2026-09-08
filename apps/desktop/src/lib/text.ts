import type { FileFormat, Error as IpcError } from '@mdreader/ipc';

/**
 * Words as a writer counts them: runs of letters, digits, and the marks
 * that live inside a word. Markdown punctuation does not count, and CJK
 * runs count per character, which is what those writers expect.
 */
const WORD =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
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

/** A typed IPC error as a status bar line. No dialogs (build plan rule 5). */
export function describeError(error: IpcError): string {
  switch (error.kind) {
    case 'hash_mismatch':
      return `${error.path} changed on disk; reload before saving`;
    case 'read_only_encoding':
      return `${error.path} is ${error.encoding}; convert to UTF-8 to edit`;
    case 'not_implemented':
      return `${error.command} is not implemented yet`;
    case 'unavailable':
      return `${error.what} is not available: ${error.message}`;
    default:
      return error.message;
  }
}
