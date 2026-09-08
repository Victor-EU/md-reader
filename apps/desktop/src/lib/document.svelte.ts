import { EditorState, type Text } from '@codemirror/state';
import {
  createEditorState,
  type EditorMode,
  type LineChange,
  type PreviewOptions,
} from '@mdreader/editor-core';
import type { DocumentMeta } from '@mdreader/ipc';
import { basename } from './paths.ts';

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** A placeholder so the rune fields have a value before the constructor runs. */
const EMPTY = EditorState.create({ doc: '' });

export interface DocOptions {
  path?: string;
  meta?: DocumentMeta;
  mode?: EditorMode;
  untitledName?: string;
  /**
   * What the block widgets render with. Built from the document itself,
   * because the image rules depend on where the file is and on whether
   * this document may load remote images.
   */
  preview?: (doc: Doc) => PreviewOptions;
}

/**
 * One document per open path (design 6.5), shared by every tab that shows
 * it. The buffer, its undo history, and its parse tree all live in one
 * `EditorState`, which is why a second view onto the same document shares
 * undo; a tab holds only what is per view — mode, selection, scroll.
 */
export class Doc {
  readonly id = nextId('doc');
  path = $state<string | null>(null);
  meta = $state<DocumentMeta | null>(null);
  /** The buffer. Every view of this document is a projection of it. */
  state: EditorState = $state.raw(EMPTY);
  /** The content on disk as we last saw it: the base for a merge (WP 1.7). */
  base: Text = $state.raw(EMPTY.doc);
  /** What the reader has already seen; the Changes badge counts from here. */
  reviewed: Text = $state.raw(EMPTY.doc);
  /** Where the buffer differs from `reviewed`, for the gutter and the badge. */
  changes = $state<LineChange[]>([]);
  /** True while the file this document came from is not on disk (design 8). */
  missing = $state(false);
  /** `Untitled 1` until the first save gives the document a path. */
  readonly untitledName: string;
  /**
   * Whether this document may load images from the network (design 8).
   * Off until the reader says otherwise, and never remembered: the choice
   * belongs to this reading of this file.
   */
  remoteImages = $state(false);
  private readonly preview: ((doc: Doc) => PreviewOptions) | undefined;

  constructor(text: string, options: DocOptions = {}) {
    this.path = options.path ?? null;
    this.meta = options.meta ?? null;
    this.untitledName = options.untitledName ?? 'Untitled';
    this.preview = options.preview;
    this.state = createEditorState(text, {
      mode: options.mode ?? 'edit',
      preview: this.previewOptions(),
    });
    this.base = this.state.doc;
    this.reviewed = this.state.doc;
  }

  /** Read afresh on every widget, so a toggle needs no new state. */
  previewOptions(): PreviewOptions {
    return this.preview?.(this) ?? {};
  }

  get text(): string {
    return this.state.doc.toString();
  }

  /**
   * Whether the buffer differs from the file. A buffer hash would have to
   * be recomputed on every keystroke to answer this; comparing the two
   * `Text` values is the same answer without the hashing, and it returns
   * to clean when an undo takes the buffer back.
   */
  get dirty(): boolean {
    return !this.state.doc.eq(this.base);
  }

  get label(): string {
    return this.path === null ? this.untitledName : basename(this.path);
  }

  /**
   * Record what a save has just put on disk.
   *
   * `seen` says whether that also means the reader has looked at it. A
   * save they asked for does: they were here, and they pressed the key.
   * A save on a timer does not, so the marks on a write that arrived
   * from somebody else stay where they are until it has been read
   * (design 4.4) rather than being cleared by a clock.
   */
  markSaved(written: Text, seen: boolean): void {
    this.base = written;
    if (seen) {
      this.reviewed = written;
      this.changes = [];
    }
    this.missing = false;
  }

  /**
   * The reader has seen everything in the buffer (design 4.4). What the
   * gutter marks from here on is what happened after this moment.
   */
  markReviewed(): void {
    this.reviewed = this.state.doc;
    this.changes = [];
  }

  /** Replace the buffer, as opening or converting a file does. Undo resets. */
  replace(text: string, mode: EditorMode): void {
    this.state = createEditorState(text, { mode, preview: this.previewOptions() });
    this.base = this.state.doc;
    this.reviewed = this.state.doc;
    this.changes = [];
  }
}
