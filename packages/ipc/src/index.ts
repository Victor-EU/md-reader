export * from './bindings.ts';

import type { commands, events } from './bindings.ts';

/** What every command resolves to: tauri-specta's tagged result. */
export type Result<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** The command surface, for fakes and for code that takes either the real or a fake IPC. */
export type Commands = typeof commands;
export type Events = typeof events;

/** Unwrap a result or throw its error, for call sites that want exceptions. */
export async function unwrap<T, E>(result: Promise<Result<T, E>>): Promise<T> {
  const r = await result;
  if (r.status === 'ok') return r.data;
  throw r.error;
}
