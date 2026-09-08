#!/usr/bin/env node
/**
 * `node tools/release/main.mjs --version 0.2.0 --base-url <url> --out latest.json
 *    darwin-universal=artifacts/macos windows-x86_64=artifacts/windows-x64`
 *
 * Run by the release workflow after the bundles are downloaded, and by
 * hand when a release is assembled from a laptop.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildManifest, parseArgs, signedArtifact } from './manifest.mjs';

const options = parseArgs(process.argv.slice(2));
const entries = [];
for (const { platform, dir } of options.pairs) {
  const { file, signature } = await signedArtifact(dir);
  entries.push({ platform, file, signature });
}
const notes = options.notesFile ? await readFile(options.notesFile, 'utf8') : '';
const manifest = buildManifest({
  version: options.version,
  notes: notes.trim(),
  baseUrl: options.baseUrl,
  entries,
});
await writeFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${options.out}: ${Object.keys(manifest.platforms).join(', ')}`);
