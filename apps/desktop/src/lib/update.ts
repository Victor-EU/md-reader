/**
 * The updater (plan WP 1.12, section 12).
 *
 * The design does not mention updates at all, and the plan adds them for
 * one reason: a build that is being dogfooded has to be able to carry a
 * fix to the person testing it. So this is deliberately the smallest
 * updater that does that — check, tell, install, restart — with no
 * settings, no channels, and nothing to dismiss.
 *
 * The rule that shapes it is that an update the reader did not ask about
 * is never allowed to interrupt. An automatic check that finds nothing,
 * or that cannot reach the network, says nothing at all; only a check the
 * reader asked for reports back either way. Nothing installs itself.
 */

/** An update the endpoint offered, as much of it as the app shows. */
export interface Available {
  version: string;
  /** The release notes from the manifest, when it carries any. */
  notes?: string;
}

/**
 * What the app needs from the updater plugin, so that a test can hand it
 * something else. The real one is `tauriUpdater`, built in `main.ts`;
 * everything below this line is reachable without Tauri.
 */
export interface Updater {
  check: () => Promise<Available | null>;
  /**
   * Download and install. `onProgress` receives a fraction between 0 and
   * 1, or `null` while the size is not yet known — a server that sends no
   * content length is a bar that cannot be drawn, not an error.
   */
  install: (onProgress: (fraction: number | null) => void) => Promise<void>;
  relaunch: () => Promise<void>;
}

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** Checked, and this is the newest build there is. */
  | { phase: 'none' }
  | { phase: 'available'; update: Available }
  | { phase: 'installing'; update: Available; fraction: number | null }
  /** On disk and waiting for the restart that swaps it in. */
  | { phase: 'ready'; update: Available }
  | { phase: 'failed'; message: string };

export const IDLE: UpdateState = { phase: 'idle' };

/**
 * How often a running app looks. Six hours is often enough that a fix
 * reaches a tester the same day and rare enough that a window left open
 * over a weekend makes four requests, not four hundred.
 */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A moment after the window is up, so the check never delays first paint. */
export const FIRST_CHECK_DELAY_MS = 10_000;

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The standing sentence: what the status bar keeps showing for as long as
 * an update is in play. Empty when there is nothing to stand there for —
 * a check in progress is not news, and neither is being up to date.
 */
export function describeUpdate(state: UpdateState): string {
  switch (state.phase) {
    case 'available':
      return `Version ${state.update.version} is available`;
    case 'installing':
      return state.fraction === null
        ? `Downloading ${state.update.version}…`
        : `Downloading ${state.update.version} — ${percent(state.fraction)}`;
    case 'ready':
      return `Version ${state.update.version} is ready — restart to finish`;
    default:
      return '';
  }
}

/** What pressing that sentence does, when pressing it does anything. */
export function updateAction(state: UpdateState): 'install' | 'restart' | null {
  if (state.phase === 'available') return 'install';
  if (state.phase === 'ready') return 'restart';
  return null;
}

/**
 * What a check the reader asked for reports in the transient status line.
 *
 * The same states are silent after an automatic check, which is the whole
 * difference between the two: `reportCheck` is only ever called for a
 * check somebody pressed.
 */
export function reportCheck(state: UpdateState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'none':
      return 'Markdown is up to date';
    case 'failed':
      return `Could not check for updates — ${state.message}`;
    case 'available':
      return `Version ${state.update.version} is available`;
    default:
      return '';
  }
}

/** A thrown anything, as a sentence short enough for the status line. */
export function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === '' ? 'the check failed' : first;
}

/**
 * The plugin, behind the interface above. Only `main.ts` calls this, and
 * only under Tauri; the import is dynamic so a browser build — which is
 * what the tests and `pnpm dev` run — never loads it.
 */
export function tauriUpdater(): Updater {
  // The checked update has to survive from the check to the install,
  // because the plugin hands back a resource handle, not a description.
  let pending: {
    downloadAndInstall: (onEvent: (e: DownloadEvent) => void) => Promise<void>;
  } | null = null;
  return {
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const found = await check();
      pending = found;
      if (!found) return null;
      return { version: found.version, notes: found.body };
    },
    async install(onProgress) {
      if (!pending) throw new Error('nothing to install');
      let total: number | null = null;
      let sofar = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null;
          onProgress(total === null ? null : 0);
        } else if (event.event === 'Progress') {
          sofar += event.data.chunkLength;
          onProgress(total === null ? null : Math.min(1, sofar / total));
        } else {
          onProgress(1);
        }
      });
    },
    async relaunch() {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };
