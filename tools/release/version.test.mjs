import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findVersion, readVersions, replaceVersion } from './version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the version', () => {
  it('is the same in all three files', async () => {
    // The Tauri config's version is what the updater compares against
    // the manifest. If it drifts from the crate's, the release either
    // never offers itself or offers itself forever. Bump all three with
    // `pnpm release:version`.
    const found = await readVersions(root);
    const versions = new Set(found.map((one) => one.version));
    expect([...versions], found.map((one) => `${one.file} ${one.version}`).join(', ')).toHaveLength(
      1,
    );
  });

  it('is a real version number', async () => {
    for (const { version } of await readVersions(root)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
  });
});

describe('reading and writing it', () => {
  const cargo = [
    '[workspace]',
    'members = ["a"]',
    '',
    '[workspace.package]',
    'version = "0.1.0"',
    'edition = "2024"',
    '',
    '[workspace.dependencies]',
    'serde = "1.0"',
  ].join('\n');

  it('takes the workspace version out of Cargo.toml and not a dependency', () => {
    expect(findVersion(cargo, 'toml')).toBe('0.1.0');
    const bumped = replaceVersion(cargo, 'toml', '0.2.0');
    expect(bumped).toContain('version = "0.2.0"');
    expect(bumped).toContain('serde = "1.0"');
  });

  it('takes the top-level version out of a package file and not a dependency', () => {
    const json =
      '{\n  "name": "a",\n  "version": "0.1.0",\n  "dependencies": {\n    "b": "0.1.0"\n  }\n}\n';
    expect(findVersion(json, 'json')).toBe('0.1.0');
    expect(replaceVersion(json, 'json', '0.2.0')).toBe(
      '{\n  "name": "a",\n  "version": "0.2.0",\n  "dependencies": {\n    "b": "0.1.0"\n  }\n}\n',
    );
  });

  it('says so rather than writing nothing when there is no version to find', () => {
    expect(() => findVersion('[workspace]\n', 'toml')).toThrow(/no version/);
    expect(() => replaceVersion('{}\n', 'json', '0.2.0')).toThrow(/no version/);
  });
});
