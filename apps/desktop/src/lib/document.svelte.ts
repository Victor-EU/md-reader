import { EditorState, type Extension, type Text } from '@codemirror/state';
import {
  type ChangeRecord,
  createEditorState,
  type EditorMode,
  type PreviewOptions,
} from '@mdreader/editor-core';
import type { DocumentMeta } from '@mdreader/ipc';
import { type DocBlock, flattenBlocks, parser } from '@mdreader/markdown';
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
  /** Extensions every view of this document carries: the paste and drop handlers. */
  extra?: Extension[];
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
  /**
   * A version out of the history the reader has asked to be shown
   * against instead (design 4.4, plan WP 2.3).
   *
   * Separate from `reviewed` because they are different questions. What
   * the reader has seen is advanced by saving and by marking reviewed;
   * what they have asked to compare with is theirs until they say
   * otherwise, and a save must not quietly answer it.
   */
  against: Text | null = $state.raw(null);
  /** Which snapshot `against` came from, for the history panel to mark. */
  againstId = $state<string | null>(null);
  /** Where the buffer differs from the baseline, for the gutter and Review. */
  changes = $state<ChangeRecord[]>([]);
  /** True while the file this document came from is not on disk (design 8). */
  missing = $state(false);
  /** `Untitled 1` until the first save gives the document a path. */
  readonly untitledName: string;
  /**
   * A view of a past version rather than a document (plan WP 2.3). It
   * has no file, it is never saved, and the session does not carry it:
   * what it holds is already in the history it came out of.
   */
  ephemeral = false;
  /**
   * Whether this document may load images from the network (design 8).
   * Off until the reader says otherwise, and never remembered: the choice
   * belongs to this reading of this file.
   */
  remoteImages = $state(false);
  private readonly preview: ((doc: Doc) => PreviewOptions) | undefined;
  private readonly extra: Extension[];
  /**
   * The two flattenings worth keeping: the buffer's and the one the
   * marks are measured against (plan WP 2.2).
   *
   * Two, because of what happens when the reader says they have seen the
   * document: `reviewed` becomes the buffer, and the buffer is the list
   * the scan just made. Keeping both turns the parse that would follow
   * every save of a long document into a lookup, and it is the same
   * lookup that makes opening a file cost one flattening rather than
   * two for a diff that is empty by construction.
   */
  private flattened: { of: Text; blocks: DocBlock[] }[] = [];

  constructor(text: string, options: DocOptions = {}) {
    this.path = options.path ?? null;
    this.meta = options.meta ?? null;
    this.untitledName = options.untitledName ?? 'Untitled';
    this.preview = options.preview;
    this.extra = options.extra ?? [];
    this.state = createEditorState(text, {
      mode: options.mode ?? 'edit',
      preview: this.previewOptions(),
      extra: this.extra,
    });
    this.base = this.state.doc;
    this.reviewed = this.state.doc;
  }

  /**
   * The version the marks are measured against: a snapshot the reader
   * picked out of the history, or what they last said they had seen.
   */
  get baseline(): Text {
    return this.against ?? this.reviewed;
  }

  /**
   * A version of this document as blocks, flattening it if it is not one
   * of the two already in hand.
   */
  blocksFor(text: Text, flatten: (source: string) => DocBlock[]): DocBlock[] {
    const found = this.flattened.find((entry) => entry.of === text);
    if (found) return found.blocks;
    const blocks = flatten(text.toString());
    this.flattened = [{ of: text, blocks }, ...this.flattened].slice(0, 2);
    return blocks;
  }

  /**
   * The blocks of the version the marks are measured against (WP 2.2).
   *
   * This side has no tree of its own — it is a snapshot, not a buffer —
   * so where it is not in hand it is parsed headlessly, with the same
   * parser the editor uses, which is what makes the two lists
   * comparable.
   */
  baselineBlocks(): DocBlock[] {
    return this.blocksFor(this.baseline, (source) => flattenBlocks(parser.parse(source), source));
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
      // Unless the marks are answering another question, in which case
      // the save has not answered it.
      if (this.against === null) this.changes = [];
    }
    this.missing = false;
  }

  /**
   * The reader has seen everything in the buffer (design 4.4). What the
   * gutter marks from here on is what happened after this moment.
   */
  markReviewed(): void {
    this.reviewed = this.state.doc;
    // The reader has seen the buffer, which answers whatever comparison
    // they had set up; leaving it on would keep marking a document they
    // have just said they are done with.
    this.against = null;
    this.againstId = null;
    this.changes = [];
  }

  /** Measure the marks against a version out of the history (design 4.4). */
  compareWith(text: Text | null, id: string | null): void {
    this.against = text;
    this.againstId = text === null ? null : id;
  }

  /** Replace the buffer, as opening or converting a file does. Undo resets. */
  replace(text: string, mode: EditorMode): void {
    this.state = createEditorState(text, {
      mode,
      preview: this.previewOptions(),
      extra: this.extra,
    });
    this.base = this.state.doc;
    this.reviewed = this.state.doc;
    this.against = null;
    this.againstId = null;
    this.changes = [];
  }
}
