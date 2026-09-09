export * from './bindings.ts';

import type { commands, events } from './bindings.ts';

/** What every command resolves to: tauri-specta's tagged result. */
export type Result<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** The command surface, for fakes and for code that takes either the real or a fake IPC. */
export type Commands = typeof commands;
export type Events = typeof events;

/**
 * Design 8's two ceilings, in bytes: up to `EDITABLE_BYTES` a file opens
 * like any other, up to `OPEN_BYTES` it opens for reading only, and above
 * that it is refused.
 *
 * Rust is what enforces them — `EDITABLE_BYTES` and `OPEN_BYTES` in
 * `crates/core/src/document.rs` — and these are the same numbers for the
 * one thing the app has to do with them, which is say what they are.
 */
export const EDITABLE_BYTES = 10_000_000;
export const OPEN_BYTES = 100_000_000;

/** Unwrap a result or throw its error, for call sites that want exceptions. */
export async function unwrap<T, E>(result: Promise<Result<T, E>>): Promise<T> {
  const r = await result;
  if (r.status === 'ok') return r.data;
  throw r.error;
}
