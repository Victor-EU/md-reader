// Hand-written bindings mirroring crates/core. WP 1.2 replaces this file
// with the generated `packages/ipc` from tauri-specta.
import { invoke } from '@tauri-apps/api/core';

export type Eol = 'lf' | 'crlf' | 'cr';

export interface FileFormat {
  eol: Eol;
  mixed_eol: boolean;
  bom: boolean;
  trailing_newline: boolean;
  encoding: string;
}

export interface DocumentMeta {
  path: string;
  byte_len: number;
  modified_ms: number | null;
  hash: string;
  read_only: boolean;
  format: FileFormat;
}

export interface Document {
  content: string;
  meta: DocumentMeta;
}

export interface SaveResult {
  hash: string;
  byte_len: number;
  modified_ms: number | null;
}

/** Errors from the core, tagged so the app can branch on `kind`. */
export type IpcError =
  | { kind: 'read'; path: string; message: string }
  | { kind: 'write'; path: string; message: string }
  | { kind: 'hash_mismatch'; path: string; expected: string; actual: string }
  | { kind: 'read_only_encoding'; path: string; encoding: string };

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === 'object' && e !== null && 'kind' in e;
}

export function describeError(e: unknown): string {
  if (!isIpcError(e)) return String(e);
  switch (e.kind) {
    case 'hash_mismatch':
      return `${e.path} changed on disk; reload before saving`;
    case 'read_only_encoding':
      return `${e.path} is ${e.encoding}; convert to UTF-8 to edit`;
    default:
      return e.message;
  }
}

export function openDocument(path: string): Promise<Document> {
  return invoke<Document>('open_document', { path });
}

export function saveDocument(
  path: string,
  content: string,
  expectedHash: string | null,
  format: FileFormat,
): Promise<SaveResult> {
  return invoke<SaveResult>('save_document', { path, content, expectedHash, format });
}

export function convertDocumentToUtf8(path: string): Promise<Document> {
  return invoke<Document>('convert_document_to_utf8', { path });
}
