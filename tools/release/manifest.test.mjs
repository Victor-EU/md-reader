import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, parseArgs, parsePair, signedArtifact } from './manifest.mjs';

const base = 'https://github.com/o/r/releases/download/v0.2.0';

function manifest(entries, rest = {}) {
  return buildManifest({ version: '0.2.0', baseUrl: base, entries, ...rest });
}

async function dirWith(names) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mdreader-release-'));
  for (const name of names) await writeFile(path.join(dir, name), 'x');
  return dir;
}

describe('the manifest', () => {
  it('is what the updater expects, one entry per platform', () => {
    const out = manifest(
      [{ platform: 'darwin-universal', file: 'MD Reader.app.tar.gz', signature: 'sig\n' }],
      { date: '2026-09-09T12:00:00Z', notes: 'Fixes the thing' },
    );
    expect(out).toEqual({
      version: '0.2.0',
      notes: 'Fixes the thing',
      pub_date: '2026-09-09T12:00:00.000Z',
      platforms: {
        'darwin-universal': {
          signature: 'sig',
          url: `${base}/MD%20Reader.app.tar.gz`,
        },
      },
    });
  });

  it('escapes the spaces the product name puts in every file name', () => {
    const out = manifest([
      { platform: 'windows-x86_64', file: 'MD Reader_0.2.0_x64_en-US.msi', signature: 's' },
    ]);
    expect(out.platforms['windows-x86_64'].url).toBe(`${base}/MD%20Reader_0.2.0_x64_en-US.msi`);
  });

  it('does not mind a base URL with a trailing slash', () => {
    const out = buildManifest({
      version: '0.2.0',
      baseUrl: `${base}/`,
      entries: [{ platform: 'linux-x86_64', file: 'app.AppImage', signature: 's' }],
    });
    expect(out.platforms['linux-x86_64'].url).toBe(`${base}/app.AppImage`);
  });

  it('refuses two artifacts for one platform', () => {
    // A directory with both an .msi and an NSIS .exe in it is the real
    // case; serving one of them at random is how the wrong one ships.
    expect(() =>
      manifest([
        { platform: 'windows-x86_64', file: 'a.msi', signature: 's' },
        { platform: 'windows-x86_64', file: 'a-setup.exe', signature: 's' },
      ]),
    ).toThrow(/two artifacts claim windows-x86_64/);
  });

  it('refuses a platform the updater has never heard of', () => {
    expect(() => manifest([{ platform: 'macos', file: 'a', signature: 's' }])).toThrow(
      /unknown platform macos/,
    );
  });

  it('refuses an empty signature, which every client would reject anyway', () => {
    expect(() =>
      manifest([{ platform: 'darwin-universal', file: 'a', signature: '  \n' }]),
    ).toThrow(/empty signature/);
  });

  it('refuses to publish a manifest that would update nobody', () => {
    expect(() => manifest([])).toThrow(/no platforms/);
  });

  it('refuses something that is not a version', () => {
    expect(() =>
      manifest([{ platform: 'darwin-universal', file: 'a', signature: 's' }], {
        version: 'v0.2.0',
      }),
    ).toThrow(/not a version/);
  });
});

describe('finding the signed artifact', () => {
  it('takes the file the .sig is named after', async () => {
    const dir = await dirWith([
      'MD Reader.app.tar.gz',
      'MD Reader.app.tar.gz.sig',
      'MD Reader.dmg',
    ]);
    await writeFile(path.join(dir, 'MD Reader.app.tar.gz.sig'), 'signature\n');
    expect(await signedArtifact(dir)).toEqual({
      file: 'MD Reader.app.tar.gz',
      signature: 'signature\n',
    });
  });

  it('says so when nothing was signed', async () => {
    const dir = await dirWith(['MD Reader.dmg']);
    await expect(signedArtifact(dir)).rejects.toThrow(/no \.sig file/);
  });

  it('says so when two things were', async () => {
    const dir = await dirWith(['a.msi', 'a.msi.sig', 'b.exe', 'b.exe.sig']);
    await expect(signedArtifact(dir)).rejects.toThrow(/2 \.sig files/);
  });

  it('says so when the signature has lost its artifact', async () => {
    const dir = await dirWith(['a.msi.sig']);
    await expect(signedArtifact(dir)).rejects.toThrow(/has no a\.msi beside it/);
  });
});

describe('the command line', () => {
  it('reads the options and the platform pairs', () => {
    const options = parseArgs([
      '--version',
      '0.2.0',
      '--base-url',
      base,
      '--out',
      'latest.json',
      'darwin-universal=artifacts/macos',
      'windows-x86_64=artifacts/win',
    ]);
    expect(options.version).toBe('0.2.0');
    expect(options.out).toBe('latest.json');
    expect(options.pairs).toEqual([
      { platform: 'darwin-universal', dir: 'artifacts/macos' },
      { platform: 'windows-x86_64', dir: 'artifacts/win' },
    ]);
  });

  it('keeps a Windows path with a drive letter in one piece', () => {
    expect(parsePair('windows-x86_64=C:\\a\\win')).toEqual({
      platform: 'windows-x86_64',
      dir: 'C:\\a\\win',
    });
  });

  it('will not build half a manifest', () => {
    expect(() => parseArgs(['--version', '0.2.0'])).toThrow(/missing --base-url/);
  });
});
