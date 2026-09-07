// Hand-written bindings for WP 0.1. WP 1.2 replaces this file with the
// generated `packages/ipc` from tauri-specta.
import { invoke } from '@tauri-apps/api/core';

export interface DocumentMeta {
  path: string;
  byte_len: number;
  modified_ms: number | null;
}

export interface Document {
  content: string;
  meta: DocumentMeta;
}

export function openDocument(path: string): Promise<Document> {
  return invoke<Document>('open_document', { path });
}

export function saveDocumentDebug(path: string, content: string): Promise<void> {
  return invoke<void>('save_document_debug', { path, content });
}
