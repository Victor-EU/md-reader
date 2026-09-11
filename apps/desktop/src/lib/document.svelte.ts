import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  type ChangeSpec,
  EditorState,
  type Extension,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type ChangedRange, type Tree, TreeFragment } from '@lezer/common';
import {
  type ChangeRecord,
  createEditorState,
  type EditorMode,
  editorStateFromJSON,
  type PreviewOptions,
} from '@markdown/editor-core';
import type { DocumentMeta, Override } from '@markdown/ipc';
import {
  commentSpans,
  type DocBlock,
  flattenBlocks,
  headings,
  type OutlineEntry,
  parser,
} from '@markdown/markdown';
import { basename } from './paths.ts';
import { countWords } from './text.ts';

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * How long the word count and the outline may wait for the parser
 * before taking what there is.
 *
 * A document of an ordinary size is parsed well inside this and the
 * answer is the whole truth; a very long one is not, and the answer says
 * so rather than the window stopping for it.
 */
const PARSE_BUDGET_MS = 30;

/**
 * The size past which the parser is not asked twice for the same answer.
 *
 * An ask that runs out of time keeps the work it did, so on a document
 * the budget nearly covers, the next ask may well finish it — and below
 * this line that is what happens: a hundred kilobytes measures at twenty
 * to forty milliseconds to parse, so whether one ask is enough depends
 * on the machine and the second one is worth making. A megabyte measures
 * at a hundred and fifty to two hundred, and no number of thirty
 * millisecond asks adds up to it before the reader has typed again, so
 * above this line the app stops asking (plan WP 3.3).
 */
const ASK_AGAIN_BYTES = 500_000;

/** A parse of the buffer, and whether it reached the end of it. */
export interface Parsed {
  tree: Tree;
  complete: boolean;
}

/** The headings of a document, and whether the parse had reached them all. */
export interface Outline {
  entries: OutlineEntry[];
  complete: boolean;
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
  /**
   * A state another window serialized: this document's buffer, its
   * selection and its undo history (plan WP 2.5). A string that will not
   * read back leaves the text as the whole of what arrived, which is a
   * document without its undo rather than no document.
   */
  restore?: string;
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
  /**
   * What the reader has already seen, or written themselves; the Changes
   * badge counts from here.
   *
   * Their own typing moves it as they type (ADR 0036). The marks are for
   * what changed under them, and nobody needs telling what they have
   * just written, so what is left between this and the buffer is only
   * what arrived from outside: a write merged in from disk or an agent.
   */
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
  /**
   * The reading settings this document was given instead of the app's
   * (design 11, plan WP 2.6), or null while it follows the app.
   *
   * Kept on the document rather than the tab: it is a property of the
   * file, which is why it is stored by path and why two views of one
   * document are read in the same type.
   */
  reading = $state<Override | null>(null);
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
  /**
   * What has been read out of one version of the buffer: the word count
   * the status bar shows and the headings the outline lists.
   *
   * Both are the same shape of question — walk the whole document once
   * and say one thing about it — and both were being asked again every
   * time a tab came to the front, which on two hundred of them was most
   * of a launch (plan WP 3.3). The buffer is immutable, so the answers
   * are too, and two tabs on one document share them.
   *
   * Keyed by how far the parse had reached as well as by the buffer,
   * because both answers depend on it: only the tree can tell a comment
   * from a `<!--` inside a fence, and a heading the parse has not
   * reached is not in the list yet. The parser advances the tree through
   * transactions, so the key moves when the answers can improve and
   * stands still when they cannot.
   */
  private scanned: {
    of: Text;
    parsed: number;
    tree?: Parsed;
    words?: number;
    outline?: Outline;
  } | null = null;
  /**
   * How much of the document was still unparsed when the budget last ran
   * out, or null when it has never run out on this document.
   */
  private unparsed: number | null = null;
  /**
   * What arrived from outside since `reviewed`, as the edits that take it
   * to the buffer `follow` last saw, or null once that is not known.
   *
   * Kept as edits rather than worked out from the two texts, because
   * every keystroke asks where the text that arrived is, and a diff is a
   * scan's worth of work to answer that.
   */
  private arrived: ChangeSet | null = ChangeSet.empty(0);
  /** The buffer `arrived` leads to: how an edit that went round `follow` shows. */
  private followed: Text = EMPTY.doc;
  /**
   * The last parse of the baseline, as fragments the next one can reuse.
   *
   * While something is waiting to be reviewed, the reader's typing makes
   * a new baseline at every pause, and parsing a megabyte of it from
   * nothing costs 150 to 200 milliseconds each time (plan WP 3.3).
   */
  private reuse: { of: Text; fragments: readonly TreeFragment[] } | null = null;

  constructor(text: string, options: DocOptions = {}) {
    this.path = options.path ?? null;
    this.meta = options.meta ?? null;
    this.untitledName = options.untitledName ?? 'Untitled';
    this.preview = options.preview;
    this.extra = options.extra ?? [];
    const config = {
      mode: options.mode ?? 'edit',
      preview: this.previewOptions(),
      extra: this.configured(),
    };
    this.state =
      (options.restore === undefined ? null : editorStateFromJSON(options.restore, config)) ??
      createEditorState(text, config);
    this.base = this.state.doc;
    this.caughtUp(this.state.doc);
  }

  /**
   * The version the marks are measured against: a snapshot the reader
   * picked out of the history, or what they have seen and written.
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
   * comparable. What the last such parse found is reused wherever the
   * text has not changed since (ADR 0036).
   */
  baselineBlocks(): DocBlock[] {
    const baseline = this.baseline;
    return this.blocksFor(baseline, (source) => {
      const kept = this.reuse;
      const tree = parser.parse(source, kept?.of === baseline ? kept.fragments : []);
      this.reuse = { of: baseline, fragments: TreeFragment.addTree(tree) };
      return flattenBlocks(tree, source);
    });
  }

  /** Read afresh on every widget, so a toggle needs no new state. */
  previewOptions(): PreviewOptions {
    return this.preview?.(this) ?? {};
  }

  get text(): string {
    return this.state.doc.toString();
  }

  /**
   * The tree to read this buffer with, and whether it covers all of it.
   *
   * The parser is given a moment to finish, because for anything of an
   * ordinary size it will, and an answer taken from half a tree is an
   * answer that has to be taken again. Where it cannot finish, what
   * there is has to do, and `complete` says which of the two happened:
   * the outline puts that on the screen rather than pretending, and the
   * change scan waits rather than calling the unparsed half deleted.
   *
   * Asked once for each version of the buffer, which is the point. A
   * document too long to parse in the budget will not be shorter on the
   * next ask, and the three callers between them were asking several
   * times a second while somebody typed (plan WP 3.3).
   */
  parseTree(): Parsed {
    const memo = this.scan();
    if (memo.tree !== undefined) return memo.tree;
    const length = this.state.doc.length;
    const have = syntaxTree(this.state);
    // Once the budget has run out on a document it will run out again,
    // and typing invalidates the memo on every keystroke: asking each
    // time spent thirty milliseconds a quarter of a second to be told
    // the same thing (plan WP 3.3). What says the answer could be
    // different is how much is left to parse, not how long the document
    // is: typing a character adds one to each and changes nothing, while
    // the editor's own parser getting further, or the document getting
    // shorter, leaves less to do than there was.
    const left = length - have.length;
    const worth = length <= ASK_AGAIN_BYTES || this.unparsed === null || left < this.unparsed;
    const tree = (worth ? ensureSyntaxTree(this.state, length, PARSE_BUDGET_MS) : null) ?? have;
    const complete = tree.length >= length;
    this.unparsed = complete ? null : length - tree.length;
    memo.tree = { tree, complete };
    // Asking may itself have moved the parser on, and the memo is good
    // for where it is now rather than where it was when the key was
    // taken. Without this the outline's ask would miss the memo the word
    // count had just filled and pay the whole budget again.
    memo.parsed = syntaxTree(this.state).length;
    return memo.tree;
  }

  /** The memo for this buffer, made if the buffer or the parse has moved. */
  private scan(): NonNullable<Doc['scanned']> {
    const of = this.state.doc;
    const parsed = syntaxTree(this.state).length;
    const found = this.scanned;
    if (found && found.of === of && found.parsed === parsed) return found;
    const fresh = { of, parsed };
    this.scanned = fresh;
    return fresh;
  }

  /**
   * The word count the status bar shows (design 4.1), counted once for
   * each version of the buffer.
   *
   * The reader's notes are left out: a note in the margin is not
   * something you wrote, so asking a question about a paragraph must not
   * make the paragraph longer. Only the tree can say which `<!--` is a
   * comment and which is text inside a fence, and a document with none
   * at all skips the walk entirely.
   */
  wordCount(): number {
    const memo = this.scan();
    if (memo.words !== undefined) return memo.words;
    const text = this.text;
    const spans = text.includes('<!--') ? commentSpans(this.parseTree().tree, text) : [];
    memo.words = countWords(text, spans);
    return memo.words;
  }

  /**
   * The headings the outline lists, and whether that is all of them
   * (plan WP 1.5). Read mode reports its own as it renders; this is what
   * the other two modes have.
   */
  headingList(): Outline {
    const memo = this.scan();
    if (memo.outline !== undefined) return memo.outline;
    const { tree, complete } = this.parseTree();
    // As much of the document as the tree covers, which for a document
    // the parser has not finished is a fraction of it. No heading node
    // reaches past the end of its own tree, and the slice starts at zero,
    // so every position still lines up.
    memo.outline = {
      entries: headings(tree, this.state.doc.sliceString(0, tree.length)),
      complete,
    };
    return memo.outline;
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
   *
   * Nor does one the reader typed through, where the buffer has moved
   * on since the bytes were taken: what they typed is theirs already,
   * and what arrived before it stays marked rather than being guessed at.
   */
  markSaved(written: Text, seen: boolean): void {
    this.base = written;
    if (seen && written === this.state.doc) {
      this.caughtUp(written);
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
    this.caughtUp(this.state.doc);
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

  /**
   * What the reader had seen, as the window this document came from
   * says it (plan WP 2.5).
   *
   * Only the text crosses, not which of the difference arrived and which
   * the reader typed. Where there is no difference that does not matter;
   * where there is, everything since is marked -- their typing included
   * -- until they next say they have looked.
   */
  adoptReviewed(text: Text): void {
    if (text.eq(this.state.doc)) {
      this.caughtUp(this.state.doc);
      return;
    }
    this.reviewed = text;
    this.followed = this.state.doc;
    this.arrived = null;
  }

  /**
   * Keep what the reader has seen in step with what they do (ADR 0036).
   *
   * Every transaction that moves the buffer comes through here, in order.
   * One that arrived from outside is added to `arrived`. One of the
   * reader's own is made to `reviewed` as well, unless it touches text
   * that arrived: a word typed into an agent's new paragraph is more of
   * that paragraph, and stays marked with it.
   */
  follow(tr: Transaction): void {
    if (!tr.docChanged) return;
    // A transaction that went round this, by a path that set the state
    // some other way, leaves `arrived` describing a buffer that is not
    // there. From then on the reader's typing is marked like everything
    // else, until they next say they have looked.
    const arrived = this.followed === tr.startState.doc ? this.arrived : null;
    this.followed = tr.state.doc;
    if (arrived === null) {
      this.arrived = null;
    } else if (tr.isUserEvent('external')) {
      this.arrived = arrived.compose(tr.changes);
    } else if (arrived.empty) {
      // Nothing is waiting on the reader, which is nearly always: what
      // they have seen is what is there.
      this.caughtUp(tr.state.doc);
    } else {
      this.carry(arrived, tr);
      // Putting text back is how what arrived goes away again: the write
      // undone, or Revert pressed on one of its changes.
      if (tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.isUserEvent('revert')) {
        this.tidy();
      }
    }
  }

  /**
   * Make `arrived` fit for a scan: still about this buffer, and pared
   * down to what differs.
   */
  settle(): void {
    if (this.followed !== this.state.doc) this.arrived = null;
    this.tidy();
  }

  /** The reader has seen `text`, and nothing in it is waiting on them. */
  private caughtUp(text: Text): void {
    this.reviewed = text;
    this.followed = text;
    this.arrived = ChangeSet.empty(text.length);
    this.reuse = null;
  }

  /**
   * Make the reader's edit to what they have seen as well, where it is
   * theirs.
   *
   * The edit is in the buffer's positions and `reviewed` has its own, so
   * it goes back through what arrived, undone; the undoing then goes
   * forward past the edit, and that is what `arrived` becomes. The parts
   * of the edit that touch what arrived are added to it instead.
   */
  private carry(arrived: ChangeSet, tr: Transaction): void {
    const start = tr.startState.doc;
    const stretches: [number, number][] = [];
    arrived.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      stretches.push([fromB, toB]);
    });
    const mine: ChangeSpec[] = [];
    const theirs: ChangeSpec[] = [];
    // Adjacent edits are reported as one, so each is wholly one or the other.
    tr.changes.iterChanges((from, to, _fromB, _toB, insert) => {
      const touching = stretches.some(([a, b]) => touches(start, from, to, a, b));
      (touching ? theirs : mine).push({ from, to, insert });
    });
    if (mine.length === 0) {
      this.arrived = arrived.compose(tr.changes);
      return;
    }
    const ours = ChangeSet.of(mine, start.length);
    const back = arrived.invert(this.reviewed);
    const seen = ours.map(back);
    const reviewed = seen.apply(this.reviewed);
    this.arrived = back
      .map(ours, true)
      .invert(ours.apply(start))
      .compose(ChangeSet.of(theirs, start.length).map(ours));
    this.keep(seen, reviewed);
    this.reviewed = reviewed;
  }

  /**
   * Take off each edit in `arrived` what it left as it was at either end,
   * and drop the ones that left everything as it was: a write undone, a
   * change reverted, a word typed back. What stays is what differs, which
   * is also what the reader's next edit is measured against.
   */
  private tidy(): void {
    const arrived = this.arrived;
    if (arrived === null || arrived.empty) return;
    const reviewed = this.reviewed;
    const specs: ChangeSpec[] = [];
    arrived.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const was = reviewed.sliceString(fromA, toA);
      const now = inserted.toString();
      if (was === now) return;
      const most = Math.min(was.length, now.length);
      let head = 0;
      while (head < most && was.charCodeAt(head) === now.charCodeAt(head)) head += 1;
      let tail = 0;
      while (
        tail < most - head &&
        was.charCodeAt(was.length - 1 - tail) === now.charCodeAt(now.length - 1 - tail)
      )
        tail += 1;
      specs.push({
        from: fromA + head,
        to: toA - tail,
        insert: now.slice(head, now.length - tail),
      });
    });
    const tidied = ChangeSet.of(specs, reviewed.length);
    if (tidied.empty) this.caughtUp(this.followed);
    else this.arrived = tidied;
  }

  /** Carry the last parse of the baseline through an edit made to it. */
  private keep(edit: ChangeSet, to: Text): void {
    const kept = this.reuse;
    if (kept?.of !== this.reviewed) {
      this.reuse = null;
      return;
    }
    const ranges: ChangedRange[] = [];
    edit.iterChangedRanges((fromA, toA, fromB, toB) => {
      ranges.push({ fromA, toA, fromB, toB });
    });
    this.reuse = { of: to, fragments: TreeFragment.applyChanges(kept.fragments, ranges) };
  }

  /**
   * What this document adds to every state it builds.
   *
   * A file the app cannot write back does not take typing. Only the size
   * ceiling used to keep the editor out, so a windows-1252 document
   * opened fully editable: the reader typed two paragraphs, found every
   * save refused with the same sentence, and pressing the way out the
   * banner offers -- Convert to UTF-8 -- re-read the file from disk and
   * threw the paragraphs away.
   *
   * Both facets, because CodeMirror keeps them apart on purpose.
   * `EditorState.readOnly` is what the editing commands ask, so the ones
   * that refuse go on saying why; `EditorView.editable` is what the
   * content element's `contenteditable` comes from, so a keystroke, a
   * paste and a drop stop at the door rather than at a command. Setting
   * only the first leaves the document typable, which is the state this
   * fixes.
   *
   * Neither touches `dispatch`, which is how an external write still
   * lands in a document nobody here may type in.
   */
  private configured(): Extension[] {
    return this.meta?.read_only == null
      ? this.extra
      : [this.extra, EditorState.readOnly.of(true), EditorView.editable.of(false)];
  }

  /** Replace the buffer, as opening or converting a file does. Undo resets. */
  replace(text: string, mode: EditorMode): void {
    this.state = createEditorState(text, {
      mode,
      preview: this.previewOptions(),
      extra: this.configured(),
    });
    this.base = this.state.doc;
    this.caughtUp(this.state.doc);
    this.against = null;
    this.againstId = null;
    this.changes = [];
  }
}

/**
 * Whether an edit of the reader's, `from` to `to` in `doc`, touches a
 * stretch `a` to `b` that arrived from outside (ADR 0036).
 *
 * Overlapping it does, and so does meeting it at either end, bar one
 * case: an edit that starts where the stretch stops, when the stretch
 * stops at the end of a line. A merge brings whole lines, so that edit
 * is at the start of the next line, which is the reader's own.
 */
function touches(doc: Text, from: number, to: number, a: number, b: number): boolean {
  if (to < a || from > b) return false;
  return from !== b || (b > 0 && doc.sliceString(b - 1, b) !== '\n');
}
