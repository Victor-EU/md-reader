import type { SnapshotAuthor, SnapshotInfo } from '@markdown/ipc';

/**
 * How the history panel says what a version is (design 4.4).
 *
 * A version is a moment and a hand: a reader looking for the one they
 * want is looking for "just before the agent touched it", so the time it
 * was taken and who took it are the whole of what a row has to say.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const authors: Record<SnapshotAuthor, string> = {
  user: 'You',
  autosave: 'Autosave',
  external: 'Outside',
  agent: 'Agent',
};

export function authorName(author: SnapshotAuthor): string {
  return authors[author] ?? 'Unknown';
}

/**
 * Who left this version, as the row says it.
 *
 * An agent that came in over MCP gave its name (design 9), and the name
 * is the answer: "just before the agent touched it" is a row a reader
 * finds faster when the row says `claude` than when every one of them
 * says `Agent`. A version with no name falls back to the hand that took
 * it, which is every version this app took before plan WP 3.1 and every
 * version nobody signed.
 */
export function versionAuthor(info: SnapshotInfo): string {
  const named = info.agent?.trim();
  return named ? named : authorName(info.author);
}

/**
 * The time, at the coarseness that tells versions apart.
 *
 * Today's are a clock time, because that is how a reader remembers this
 * morning; anything older carries its date, because "10:04" on its own
 * would be a lie about which day.
 */
export function snapshotTime(info: SnapshotInfo, now = Date.now()): string {
  const at = new Date(info.timestamp_ms);
  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (info.timestamp_ms >= midnight.getTime()) return clock;
  const week = midnight.getTime() - 6 * DAY_MS;
  if (info.timestamp_ms >= week) {
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
  }
  return `${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clock}`;
}

/** How big it was, in the units a document is talked about in. */
export function snapshotSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
