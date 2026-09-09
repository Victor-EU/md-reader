import type { AgentAnnotation, AgentDocument, AgentStatus } from '@mdreader/ipc';
import type { Annotation } from '@mdreader/markdown';

/**
 * What a window tells an agent about a document (design 9, plan WP 3.1).
 *
 * The MCP server is in Rust and four of its five tools are questions
 * about a buffer: what it holds, what the reader marked in it, what
 * changed in it. None of those are Rust's to answer — the buffer is the
 * editor's and the marks come out of a parse tree that only lives here —
 * so the server asks the window and this is what the window says back.
 *
 * Everything here is a pure mapping from what the app already has. The
 * annotation extractor of WP 1.6 is the same one Copy for AI uses, which
 * is what makes the two channels of design 9 agree with each other: an
 * agent that reads `list_annotations` and a person who pasted the
 * document into a chat are looking at the same list.
 */

/** One extracted annotation, in the words of the contract. */
export function agentAnnotation(found: Annotation): AgentAnnotation {
  return {
    mark: found.mark,
    meaning: found.meaning,
    anchor: found.anchor,
    from: found.from,
    to: found.to,
    comment: found.comment === null ? null : { kind: found.comment.kind, text: found.comment.text },
  };
}

/** What one open document looks like in `list_documents`. */
export function agentDocument(document: {
  path: string | null;
  label: string;
  text: string;
  dirty: boolean;
  modifiedMs: number | null;
}): AgentDocument {
  return {
    path: document.path,
    name: document.label,
    dirty: document.dirty,
    // The buffer's length in bytes of UTF-8, which is the unit a file
    // size is in, and not the string's length in UTF-16 units.
    byte_len: new TextEncoder().encode(document.text).length,
    modified_ms: document.modifiedMs,
  };
}

/**
 * What the status bar says about the server (plan WP 3.1).
 *
 * Empty when there is no server: a browser build has none, and a
 * machine that could not open a port has none either. An absent thing
 * should not take up a cell.
 *
 * When there is one, what a reader wants to know is whether anything is
 * connected to it. The port is not in the line — it changes on every
 * launch and nobody is meant to type it anywhere — and neither is the
 * token, which is a secret.
 */
export function describeAgent(status: AgentStatus): string {
  if (status.port === 0) return '';
  if (status.clients === 0) return 'Agent';
  return `Agent · ${status.clients} connected`;
}
