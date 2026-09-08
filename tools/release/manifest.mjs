/**
 * The static release manifest the updater reads (plan WP 1.12).
 *
 * Tauri's updater fetches one JSON document, looks up the platform it is
 * running on, and downloads and verifies what it finds there. That
 * document is this: built after the bundles, uploaded beside them, and
 * served from the release's `latest` URL, which is why the endpoint in
 * `tauri.conf.json` never has to change.
 *
 * Signatures are not produced here. Each bundle is signed by the bundler
 * with the updater key, which leaves a `.sig` file next to it; this reads
 * those files and pairs each with the artifact it names. Pairing that way
 * rather than by a list of expected file names means the manifest cannot
 * quietly disagree with what was actually built.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** The platform keys the updater looks itself up by. */
export const PLATFORMS = [
  'darwin-universal',
  'darwin-x86_64',
  'darwin-aarch64',
  'linux-x86_64',
  'linux-aarch64',
  'windows-x86_64',
  'windows-aarch64',
];

/**
 * Turn the found artifacts into the document the updater expects.
 *
 * `entries` are `{ platform, file, signature }`; `file` is the artifact's
 * base name, which is joined to `baseUrl` to make the download link.
 */
export function buildManifest({ version, notes = '', date = new Date(), baseUrl, entries }) {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`not a version: ${version}`);
  }
  if (entries.length === 0) {
    throw new Error('a manifest with no platforms in it would update nobody');
  }
  const platforms = {};
  for (const entry of entries) {
    if (!PLATFORMS.includes(entry.platform)) {
      throw new Error(
        `unknown platform ${entry.platform}; expected one of ${PLATFORMS.join(', ')}`,
      );
    }
    if (platforms[entry.platform]) {
      throw new Error(
        `two artifacts claim ${entry.platform}: the updater would take one at random`,
      );
    }
    if (entry.signature.trim() === '') {
      throw new Error(`${entry.file} has an empty signature; the update would be refused`);
    }
    platforms[entry.platform] = {
      signature: entry.signature.trim(),
      // The names carry spaces — "MD Reader.app.tar.gz" — and a raw
      // space in a URL is a link that works in a browser and not in the
      // updater's HTTP client.
      url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(entry.file)}`,
    };
  }
  return {
    version,
    notes,
    pub_date: new Date(date).toISOString(),
    platforms,
  };
}

/**
 * The signed artifact in a directory: the one `.sig` file, and the file
 * whose name it is made of.
 *
 * More than one is an error rather than a choice. A directory holding
 * both a `.msi` and an NSIS `.exe` can only serve one of them as the
 * update for that platform, and picking silently is how the wrong
 * installer ships.
 */
export async function signedArtifact(dir) {
  const names = await readdir(dir);
  const sigs = names.filter((name) => name.endsWith('.sig'));
  const only = sigs[0];
  if (only === undefined) throw new Error(`no .sig file in ${dir}: was the bundle signed?`);
  if (sigs.length > 1) throw new Error(`${sigs.length} .sig files in ${dir}: ${sigs.join(', ')}`);
  const file = only.slice(0, -'.sig'.length);
  if (!names.includes(file)) throw new Error(`${only} in ${dir} has no ${file} beside it`);
  return { file, signature: await readFile(path.join(dir, only), 'utf8') };
}

/** `platform=directory` as the command line writes it. */
export function parsePair(argument) {
  const at = argument.indexOf('=');
  if (at <= 0) throw new Error(`expected platform=directory, got ${argument}`);
  return { platform: argument.slice(0, at), dir: argument.slice(at + 1) };
}

export function parseArgs(argv) {
  const options = { pairs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') options.version = argv[++i];
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg === '--notes-file') options.notesFile = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else options.pairs.push(parsePair(arg));
  }
  for (const required of ['version', 'baseUrl', 'out']) {
    if (!options[required])
      throw new Error(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return options;
}
