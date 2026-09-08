/**
 * One version number in three files (plan WP 1.12).
 *
 * The Cargo workspace, the Tauri config and the desktop package each
 * carry it, and they have to agree: the config's version is what goes
 * into the bundle and what the updater compares against the manifest, so
 * a stale one there means either an update that never offers itself or
 * one that offers itself forever.
 *
 * `readVersions` is what the test asserts on; `setVersion` is what
 * `pnpm release:version 0.2.0` calls so nobody has to edit three files.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Where the number lives, and how to find it in each kind of file. */
export const SOURCES = [
  { file: 'Cargo.toml', kind: 'toml' },
  { file: path.join('apps', 'desktop', 'src-tauri', 'tauri.conf.json'), kind: 'json' },
  { file: path.join('apps', 'desktop', 'package.json'), kind: 'json' },
];

/** The `version = "x"` under `[workspace.package]`, and nothing else. */
const CARGO_VERSION = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/;
const JSON_VERSION = /(^\s*"version"\s*:\s*")([^"]+)(")/m;

function pattern(kind) {
  return kind === 'toml' ? CARGO_VERSION : JSON_VERSION;
}

export function findVersion(text, kind) {
  const found = pattern(kind).exec(text);
  if (!found) throw new Error('no version in this file');
  return found[2];
}

export function replaceVersion(text, kind, version) {
  if (!pattern(kind).test(text)) throw new Error('no version in this file');
  return text.replace(pattern(kind), `$1${version}$3`);
}

export async function readVersions(root) {
  const out = [];
  for (const source of SOURCES) {
    const text = await readFile(path.join(root, source.file), 'utf8');
    out.push({ file: source.file, version: findVersion(text, source.kind) });
  }
  return out;
}

export async function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a version: ${version}`);
  }
  for (const source of SOURCES) {
    const at = path.join(root, source.file);
    const text = await readFile(at, 'utf8');
    await writeFile(at, replaceVersion(text, source.kind, version));
  }
  return version;
}
