import type { Commands, DirEntry } from '@markdown/ipc';
import { basename, dirname } from './paths.ts';
import { describeError } from './text.ts';

/**
 * The open folder as the sidebar draws it (design 4.1, plan WP 2.4).
 *
 * The tree is kept as a listing per folder rather than as a shape of its
 * own, because that is what the watcher hands back: a folder whose
 * contents may have changed. Refreshing one is reading it again, and
 * every row derives from those listings, so what the sidebar shows and
 * what is on disk cannot drift apart.
 *
 * Levels are read as they are opened. A folder of fifty thousand files
 * has twelve rows in it until somebody asks for more.
 */
export interface TreeRow {
  path: string;
  name: string;
  isDir: boolean;
  /** How deep under the root, for the indent. */
  depth: number;
  expanded: boolean;
}

export class Folder {
  root = $state<string | null>(null);
  rows = $state<TreeRow[]>([]);
  /** The row the reader last touched: where "New file" puts one. */
  selected = $state<string | null>(null);
  /** The row whose name is being typed, from "New file" or a rename. */
  renaming = $state<string | null>(null);

  /** One listing per folder we have read, keyed by its path. */
  private readonly listings = new Map<string, DirEntry[]>();
  private readonly expanded = new Set<string>();

  constructor(
    private readonly commands: Commands,
    /** Where a failure goes: the status bar, since there are no dialogs. */
    private readonly report: (message: string) => void,
  ) {}

  /** The folder's own name, which is what the sidebar heading says. */
  name: string = $derived(this.root === null ? '' : basename(this.root));

  /**
   * Adopt a folder. Rust starts the watch and the walk behind Cmd+P;
   * this reads the top level, which is all the tree shows to begin with.
   */
  async open(path: string): Promise<boolean> {
    const opened = await this.commands.openFolder(path);
    if (opened.status === 'error') {
      this.report(describeError(opened.error));
      return false;
    }
    // Rust answers with the folder as the filesystem knows it, which on
    // a path through a symlink is not the one that was asked for. Its
    // answer is what the watcher's reports will be in.
    const root = opened.data;
    this.listings.clear();
    this.expanded.clear();
    this.root = root;
    this.selected = null;
    this.renaming = null;
    await this.load(root);
    this.rebuild();
    return true;
  }

  close(): void {
    void this.commands.closeFolder();
    this.root = null;
    this.listings.clear();
    this.expanded.clear();
    this.selected = null;
    this.renaming = null;
    this.rows = [];
  }

  /** Open a folder row, or close it; a file row is the caller's business. */
  async toggle(path: string): Promise<void> {
    this.selected = path;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
    } else {
      this.expanded.add(path);
      if (!this.listings.has(path)) await this.load(path);
    }
    this.rebuild();
  }

  /**
   * Read these folders again, because something under the root was
   * written. Only the ones the tree is showing: the watch covers the
   * whole folder, and most of it is not on screen.
   */
  async refresh(dirs: readonly string[]): Promise<void> {
    let touched = false;
    for (const dir of dirs) {
      if (!this.listings.has(dir)) continue;
      await this.load(dir);
      touched = true;
    }
    if (touched) this.rebuild();
  }

  /** Read every folder the tree is showing, for a refresh by hand. */
  async reload(): Promise<void> {
    await this.refresh([...this.listings.keys()]);
  }

  /**
   * Design 4.5's "New file": an empty `Untitled.md` in the chosen folder,
   * with its name up for typing straight away. Rust picks the number
   * when that name is taken, since it is the one holding the folder.
   */
  async newFile(): Promise<string | null> {
    const dir = this.target();
    if (dir === null) return null;
    const made = await this.commands.createFile(dir, 'Untitled.md');
    if (made.status === 'error') {
      this.report(describeError(made.error));
      return null;
    }
    this.expanded.add(dir);
    await this.load(dir);
    this.rebuild();
    this.selected = made.data;
    this.renaming = made.data;
    return made.data;
  }

  /**
   * Give a file another name. Returns where it went, so a tab open on it
   * can follow.
   */
  async rename(path: string, name: string): Promise<string | null> {
    this.renaming = null;
    if (name.trim() === '' || name === basename(path)) return null;
    const moved = await this.commands.renamePath(path, name);
    if (moved.status === 'error') {
      this.report(describeError(moved.error));
      return null;
    }
    const dir = dirname(path);
    if (this.listings.has(dir)) {
      await this.load(dir);
      this.rebuild();
    }
    this.selected = moved.data;
    return moved.data;
  }

  /** Where a new file goes: the selected folder, or the one holding the
   * selected file, or the root. */
  private target(): string | null {
    if (this.root === null) return null;
    const selected = this.selected;
    if (selected === null) return this.root;
    const row = this.rows.find((entry) => entry.path === selected);
    if (!row) return this.root;
    return row.isDir ? row.path : dirname(row.path);
  }

  private async load(dir: string): Promise<void> {
    const listed = await this.commands.listDir(dir);
    if (listed.status === 'error') {
      // A folder that is gone is not an error worth a status line: the
      // watcher is telling us about a rename or a delete, and the answer
      // is to stop showing it.
      this.listings.delete(dir);
      this.expanded.delete(dir);
      return;
    }
    this.listings.set(dir, listed.data);
  }

  /** The listings, flattened into the lines the sidebar draws. */
  private rebuild(): void {
    const rows: TreeRow[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of this.listings.get(dir) ?? []) {
        const expanded = entry.is_dir && this.expanded.has(entry.path);
        rows.push({
          path: entry.path,
          name: entry.name,
          isDir: entry.is_dir,
          depth,
          expanded,
        });
        if (expanded) walk(entry.path, depth + 1);
      }
    };
    if (this.root !== null) walk(this.root, 0);
    this.rows = rows;
  }
}
