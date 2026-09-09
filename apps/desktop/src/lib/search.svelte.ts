import type { Commands, SearchDone, SearchHit, SearchProgress } from '@mdreader/ipc';
import { basename, dirname } from './paths.ts';
import { describeError } from './text.ts';

/**
 * Content search across the open folder (design 4.1, plan WP 2.4).
 *
 * Rust walks and reads; this holds what has come back so far. Results
 * arrive in batches while the walk is still going, so the panel fills
 * from the top and the first answer can be clicked long before the last
 * one is found.
 *
 * Every search carries the id Rust gave it. A reader who types another
 * character has started a new one, and the batches still crossing the
 * bridge from the old one are recognized by their id and dropped.
 */
export interface SearchGroup {
  path: string;
  name: string;
  /** The folder, relative to the root, that this file is in. */
  dir: string;
  hits: SearchHit[];
}

/** Enough results to be worth reading; past this the query is the answer. */
const LIMIT = 500;
/** A pause in typing, so a phrase is one walk of the folder and not five. */
const DELAY = 250;

export class FolderSearch {
  query = $state('');
  hits = $state<SearchHit[]>([]);
  running = $state(false);
  /** The limit was reached: the folder holds more than is shown. */
  truncated = $state(false);
  /** The query the results on screen belong to, for the "nothing" line. */
  showing = $state('');
  /** The two flags the find bar has, over the folder instead (4.5). */
  regex = $state(false);
  caseSensitive = $state(false);
  /** Bumped when the field should take the keyboard (Cmd+Shift+F). */
  wanted = $state(0);

  /**
   * The number this window knows its current search by.
   *
   * It is chosen here rather than by Rust because the results are
   * events, and an event can reach the webview before the call that
   * started the search has answered. Starting from somewhere random
   * keeps two windows from picking the same numbers, since the events
   * reach both of them.
   */
  private id: number | null = null;
  private token = Math.floor(Math.random() * 2 ** 30);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly commands: Commands,
    private readonly report: (message: string) => void,
    private readonly root: () => string | null,
  ) {}

  /** The hits by file, in the order the walk found them. */
  groups: SearchGroup[] = $derived.by(() => {
    const root = this.root();
    const prefix = root === null ? '' : root.endsWith('/') ? root : `${root}/`;
    const groups: SearchGroup[] = [];
    const at = new Map<string, SearchGroup>();
    for (const hit of this.hits) {
      let group = at.get(hit.path);
      if (!group) {
        const dir = dirname(hit.path);
        group = {
          path: hit.path,
          name: basename(hit.path),
          dir: dir.startsWith(prefix) ? dir.slice(prefix.length) : dir,
          hits: [],
        };
        at.set(hit.path, group);
        groups.push(group);
      }
      group.hits.push(hit);
    }
    return groups;
  });

  found: number = $derived(this.hits.length);

  /** Typing. The walk follows a pause; Enter in the field runs it now. */
  type(query: string): void {
    this.query = query;
    if (this.timer !== null) clearTimeout(this.timer);
    if (query.trim() === '') {
      this.clear();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, DELAY);
  }

  /** Ask for what is in the field now, replacing whatever is running. */
  async run(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const query = this.query.trim();
    if (query === '') {
      this.clear();
      return;
    }
    this.hits = [];
    this.truncated = false;
    this.showing = query;
    this.running = true;
    this.token += 1;
    this.id = this.token;
    const started = await this.commands.startSearch(this.token, query, {
      case_sensitive: this.caseSensitive,
      regex: this.regex,
      max_results: LIMIT,
    });
    if (started.status === 'error') {
      this.running = false;
      this.id = null;
      this.report(describeError(started.error));
    }
  }

  /** A flag changed: the same query is a different search now. */
  flag(change: { regex?: boolean; caseSensitive?: boolean }): void {
    if (change.regex !== undefined) this.regex = change.regex;
    if (change.caseSensitive !== undefined) this.caseSensitive = change.caseSensitive;
    if (this.query.trim() !== '') void this.run();
  }

  /** Stop the walk, keeping what it has already found. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.id !== null) void this.commands.cancelSearch(this.id);
    this.id = null;
    this.running = false;
  }

  clear(): void {
    this.cancel();
    this.query = '';
    this.hits = [];
    this.showing = '';
    this.truncated = false;
  }

  /** Some of what the current search has found. */
  progress(progress: SearchProgress): void {
    if (progress.id !== this.id) return;
    this.hits = [...this.hits, ...progress.hits];
  }

  /** That search is over. A cancelled one keeps what it found. */
  done(done: SearchDone): void {
    if (done.id !== this.id) return;
    this.running = false;
    this.truncated = done.truncated;
    this.id = null;
  }
}
