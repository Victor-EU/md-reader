#!/usr/bin/env node
/** `pnpm release:version 0.2.0` — the one place the number is changed. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersions, setVersion } from './version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const wanted = process.argv[2];
if (!wanted) {
  const found = await readVersions(root);
  console.log(found.map((one) => `${one.version}  ${one.file}`).join('\n'));
  console.log('\nUsage: pnpm release:version <x.y.z>');
  process.exit(found.every((one) => one.version === found[0].version) ? 0 : 1);
}
await setVersion(root, wanted);
console.log(`version ${wanted} in ${(await readVersions(root)).length} files`);
console.log(`Now: cargo check --workspace (for Cargo.lock), commit, and tag v${wanted}`);
