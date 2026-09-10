import type { SnapshotAuthor, SnapshotInfo } from '@markdown/ipc';
import { describe, expect, it } from 'vitest';
import { authorName, snapshotSize, snapshotTime, versionAuthor } from './history.ts';

function version(
  at: Date,
  author: SnapshotAuthor = 'user',
  agent: string | null = null,
): SnapshotInfo {
  return {
    id: 'x',
    path: '/a.md',
    author,
    agent,
    timestamp_ms: at.getTime(),
    hash: 'h',
    byte_len: 10,
  };
}

describe('snapshotTime', () => {
  const now = new Date(2026, 8, 9, 14, 30);

  it('gives a version from today the time it was taken', () => {
    const at = new Date(2026, 8, 9, 10, 4);
    expect(snapshotTime(version(at), now.getTime())).toMatch(/10.04/);
  });

  /** "10:04" on its own would be a lie about which day. */
  it('gives one from earlier this week its day as well', () => {
    const at = new Date(2026, 8, 7, 10, 4);
    const said = snapshotTime(version(at), now.getTime());
    expect(said).toMatch(/10.04/);
    expect(said.length).toBeGreaterThan(5);
  });

  it('gives an older one its date', () => {
    const at = new Date(2026, 7, 2, 10, 4);
    expect(snapshotTime(version(at), now.getTime())).toMatch(/2/);
  });

  /** A version taken a minute after midnight is still today's. */
  it('counts from midnight and not from twenty-four hours ago', () => {
    const at = new Date(2026, 8, 9, 0, 1);
    expect(snapshotTime(version(at), now.getTime())).toMatch(/00.01|12.01/);
  });
});

describe('authorName', () => {
  it('names each hand a version can come from', () => {
    expect(authorName('user')).toBe('You');
    expect(authorName('autosave')).toBe('Autosave');
    expect(authorName('external')).toBe('Outside');
    expect(authorName('agent')).toBe('Agent');
  });
});

describe('versionAuthor', () => {
  it('says the name an agent gave itself', () => {
    expect(versionAuthor(version(new Date(), 'agent', 'claude'))).toBe('claude');
  });

  it('falls back to the hand for everything nobody signed', () => {
    // Every version taken before plan WP 3.1, and every one the reader
    // or the watcher left.
    expect(versionAuthor(version(new Date(), 'agent', null))).toBe('Agent');
    expect(versionAuthor(version(new Date(), 'user'))).toBe('You');
    expect(versionAuthor(version(new Date(), 'external'))).toBe('Outside');
    expect(versionAuthor(version(new Date(), 'agent', '  '))).toBe('Agent');
  });
});

describe('snapshotSize', () => {
  it('measures a document in the units it is talked about in', () => {
    expect(snapshotSize(400)).toBe('400 B');
    expect(snapshotSize(4096)).toBe('4 KB');
    expect(snapshotSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
