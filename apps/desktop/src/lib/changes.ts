import type { Text } from '@codemirror/state';
import type { ChangeEdit, ChangePart, ChangeRecord } from '@markdown/editor-core';
import type { BlockOp, WordRun } from '@markdown/ipc';
import type { DocBlock } from '@markdown/markdown';

/**
 * The alignment of two block lists, as the records the margin marks and
 * Review mode walks (design 4.4, plan WP 2.2 and 2.3).
 *
 * The engine answers in blocks, because that is the unit a reader means
 * by "this changed". This is where a block becomes something the reader
 * can see and put back: a range in the buffer, the words that went and
 * came, and the edits that undo it.
 *
 * The ops arrive in the order the two documents read, which is what lets
 * a deletion — the one kind with nothing left in the buffer to point at
 * — be placed: it belongs on whatever closed over it, and that is the
 * next block on the new side.
 */

/** One version of a document: its blocks, and the text they index into. */
export interface Side {
  blocks: readonly DocBlock[];
  text: Text;
}

/** Words of untouched text kept on each side of a change in the panel. */
const CONTEXT = 6;
/** Words of one run of removed or added text before it is cut short. */
const LIMIT = 60;

export function blockChanges(ops: readonly BlockOp[], before: Side, after: Side): ChangeRecord[] {
  const records: ChangeRecord[] = [];
  // Where each old block that did not move ended up. A block put back
  // where it came from goes beside one of these: a neighbour that moved
  // as well says nothing about where "back" is.
  const stayed = new Map<number, number>();
  for (const op of ops) {
    if (op.op === 'equal' || op.op === 'changed') stayed.set(op.old, op.new);
  }
  // Blocks deleted with nothing yet in their place. They wait, because
  // what comes next decides whether this is a deletion or the first half
  // of a replacement.
  let gone: number[] = [];
  // Where the room of the record before this one ended. Two records must
  // not claim the same blank line: reverting both would take it twice.
  const edge = { at: 0 };
  for (let at = 0; at < ops.length; at += 1) {
    const op = ops[at];
    if (!op) continue;
    switch (op.op) {
      case 'deleted':
        gone.push(op.old);
        continue;
      case 'equal':
        if (gone.length > 0) records.push(removal(before, after, gone, op.new));
        break;
      case 'changed':
        records.push(rewrite(before, after, gone, op.old, op.new, op.words));
        break;
      case 'moved': {
        const run = moveRun(ops, at);
        records.push(relocation(before, after, gone, op.old, op.new, run, stayed, edge));
        at += run - 1;
        break;
      }
      case 'inserted':
        records.push(addition(before, after, gone, op.new, edge));
        break;
    }
    gone = [];
  }
  if (gone.length > 0) records.push(removal(before, after, gone, after.blocks.length));
  return records;
}

/**
 * How many blocks moved together, starting at `at`.
 *
 * A section that moved is one thing that happened and reads as one, but
 * only where the blocks were beside each other before as well as after:
 * two paragraphs from opposite ends of the document that arrived in the
 * same place are two moves, and putting them back means putting each
 * beside its own old neighbour.
 */
function moveRun(ops: readonly BlockOp[], at: number): number {
  const first = ops[at];
  if (first?.op !== 'moved') return 0;
  let run = 1;
  for (let next = ops[at + 1]; next?.op === 'moved'; next = ops[at + run]) {
    if (next.old !== first.old + run || next.new !== first.new + run) break;
    run += 1;
  }
  return run;
}

/**
 * The block a step of the alignment names.
 *
 * The engine names blocks in the lists it was given, so a name outside
 * one is the two sides having disagreed, which is a bug in the alignment
 * and not something to draw. It becomes an empty block at the end of the
 * document, which shows as nothing and reverts to nothing.
 */
function blockAt(side: Side, index: number): DocBlock {
  return side.blocks[index] ?? { kind: '', text: '', from: side.text.length, to: side.text.length };
}

/**
 * A record's name, which has to be the same one next time round if the
 * change is: a panel rebuilt on every scan would flicker under the
 * reader's cursor. Two records never share a range — at most one change
 * is about any one block, and a deletion sits at the start of a block
 * that did not change — so the range is the name.
 */
function name(kind: ChangeRecord['kind'], from: number, to: number): string {
  return `${kind}:${from}:${to}`;
}

// --- the four kinds -------------------------------------------------------

/** Blocks that went with nothing in their place (design 7.3 step 4). */
function removal(before: Side, after: Side, gone: number[], at: number): ChangeRecord {
  const block = after.blocks[at];
  const point = block ? block.from : after.text.length;
  const room = between(after, at);
  return {
    id: name('removed', point, point),
    kind: 'removed',
    from: point,
    to: point,
    parts: shorten(wentParts(before, gone)),
    revert: [{ ...room, insert: restored(before, gone, room.leading) }],
  };
}

/**
 * A block that was not there before. With something deleted in its
 * place it is a rewrite rather than an arrival, and it is told as one:
 * the reader is being shown a replacement, and reverting it puts the
 * replaced text back.
 */
function addition(
  before: Side,
  after: Side,
  gone: number[],
  at: number,
  edge: { at: number },
): ChangeRecord {
  const block = blockAt(after, at);
  const kind = gone.length > 0 ? 'changed' : 'added';
  const room = occupied(after, at, at, edge);
  return {
    id: name(kind, block.from, block.to),
    kind,
    from: block.from,
    to: block.to,
    // With nothing replaced there is nothing to compare: the added text
    // is in the buffer directly under the panel, and saying it twice
    // makes a long addition twice as long to read past.
    parts:
      gone.length === 0
        ? []
        : shorten([...wentParts(before, gone), { kind: 'new', text: block.text }]),
    revert: [{ from: room.from, to: room.to, insert: restored(before, gone, room.leading) }],
  };
}

/** A block the engine paired with one of the old ones (design 7.3 step 3). */
function rewrite(
  before: Side,
  after: Side,
  gone: number[],
  old: number,
  at: number,
  words: readonly WordRun[],
): ChangeRecord {
  const source = blockAt(before, old);
  const block = blockAt(after, at);
  return {
    id: name('changed', block.from, block.to),
    kind: 'changed',
    from: block.from,
    to: block.to,
    parts: shorten([...wentParts(before, gone), ...tracked(source.text, block.text, words)]),
    // The block's own range, not its lines: what changed is the text of
    // one block, and the markers around it are not ours to rewrite.
    revert: [
      ...putBack(before, after, gone, at),
      { from: block.from, to: block.to, insert: before.text.sliceString(source.from, source.to) },
    ],
  };
}

/**
 * A block that arrived from somewhere else. Putting it back means taking
 * it out of where it is and returning it beside the nearest neighbour it
 * used to have that has not moved itself; where the document no longer
 * holds one, there is nowhere to put it and the panel says so rather
 * than guessing.
 */
function relocation(
  before: Side,
  after: Side,
  gone: number[],
  old: number,
  at: number,
  run: number,
  stayed: Map<number, number>,
  edge: { at: number },
): ChangeRecord {
  const block = blockAt(after, at);
  const last = blockAt(after, at + run - 1);
  const room = occupied(after, at, at + run - 1, edge);
  const home = departure(before, after, old, old + run - 1, stayed);
  const inside = home !== null && home.at >= room.from && home.at <= room.to;
  return {
    id: name('moved', block.from, last.to),
    kind: 'moved',
    from: block.from,
    to: last.to,
    parts: shorten(wentParts(before, gone)),
    revert:
      home === null || inside
        ? []
        : [
            { from: room.from, to: room.to, insert: restored(before, gone, room.leading) },
            { from: home.at, to: home.at, insert: home.insert },
          ],
  };
}

// --- room in the document -------------------------------------------------

/** Whole lines, which is what a block occupies once its markers count. */
function lines(text: Text, from: number, to: number): { from: number; to: number } {
  const clamp = (at: number) => Math.max(0, Math.min(at, text.length));
  return {
    from: text.lineAt(clamp(from)).from,
    to: text.lineAt(clamp(Math.max(to - 1, from))).to,
  };
}

/**
 * Room in a document, and which side of it the separator goes.
 *
 * A block takes its own lines and the blank line in front of them, so
 * that taking it out leaves the neighbours with the separator they
 * already had rather than two of them or none. At the head of the
 * document there is nothing in front, so it takes the separator behind
 * it instead, and text put there has to carry its own.
 */
interface Room {
  from: number;
  to: number;
  /** Whether text put here begins with its separator rather than ends with it. */
  leading: boolean;
}

/**
 * The room a run of blocks takes up, and the room left for what comes
 * after it.
 *
 * A block takes the blank line in front of it, so that taking it out
 * leaves its neighbours with the separator they already had rather than
 * two of them. Where the block before it has already claimed that blank
 * line -- because it is being reverted too -- this one takes the blank
 * line behind it instead, which is the same amount of whitespace counted
 * once rather than twice.
 */
function occupied(side: Side, at: number, last: number, edge: { at: number }): Room {
  const own = lines(side.text, blockAt(side, at).from, blockAt(side, last).to);
  const next = side.blocks[last + 1];
  const behind = next ? lines(side.text, next.from, next.to).from : side.text.length;
  const previous = side.blocks[at - 1];
  const room: Room = previous
    ? { from: lines(side.text, previous.from, previous.to).to, to: own.to, leading: true }
    : { from: own.from, to: behind, leading: false };
  if (room.from < edge.at) {
    room.from = edge.at;
    room.to = behind;
    room.leading = false;
  }
  edge.at = room.to;
  return room;
}

/** The empty room before block `at`, where something deleted used to be. */
function between(side: Side, at: number): Room {
  const previous = side.blocks[at - 1];
  if (!previous) return { from: 0, to: 0, leading: false };
  const end = lines(side.text, previous.from, previous.to).to;
  return { from: end, to: end, leading: true };
}

/**
 * The deleted blocks as the text that puts them back, each with the
 * whitespace that stood beside it in the version they come from.
 *
 * One block at a time, and not one slice of the range they span: a run
 * of deletions is not always a run of blocks, and taking the span would
 * bring back whatever survived between them a second time.
 */
function restored(before: Side, gone: readonly number[], leading: boolean): string {
  if (gone.length === 0) return '';
  const pieces = [...gone]
    .sort((a, b) => a - b)
    .map((index) => {
      const block = blockAt(before, index);
      const own = lines(before.text, block.from, block.to);
      const neighbour = before.blocks[leading ? index - 1 : index + 1];
      const gap = neighbour
        ? whitespace(before.text, own, lines(before.text, neighbour.from, neighbour.to), leading)
        : '\n\n';
      return { gap, text: before.text.sliceString(own.from, own.to) };
    });
  return pieces
    .map((piece) => (leading ? piece.gap + piece.text : piece.text + piece.gap))
    .join('');
}

/** The whitespace between two blocks, on whichever side is being asked for. */
function whitespace(
  text: Text,
  own: { from: number; to: number },
  neighbour: { from: number; to: number },
  leading: boolean,
): string {
  return leading
    ? text.sliceString(neighbour.to, own.from)
    : text.sliceString(own.to, neighbour.from);
}

function putBack(before: Side, after: Side, gone: readonly number[], at: number): ChangeEdit[] {
  if (gone.length === 0) return [];
  const room = between(after, at);
  return [{ from: room.from, to: room.to, insert: restored(before, gone, room.leading) }];
}

/** Where a moved block belongs, and the text that puts it there. */
function departure(
  before: Side,
  after: Side,
  old: number,
  last: number,
  stayed: Map<number, number>,
): { at: number; insert: string } | null {
  const own = lines(before.text, blockAt(before, old).from, blockAt(before, last).to);
  const text = before.text.sliceString(own.from, own.to);
  const beside = (index: number, leading: boolean): { at: number; insert: string } => {
    const landed = blockAt(after, stayed.get(index) ?? 0);
    const was = blockAt(before, index);
    const gap = whitespace(before.text, own, lines(before.text, was.from, was.to), leading);
    const room = lines(after.text, landed.from, landed.to);
    return leading ? { at: room.to, insert: gap + text } : { at: room.from, insert: text + gap };
  };
  for (let index = old - 1; index >= 0; index -= 1) {
    if (stayed.has(index)) return beside(index, true);
  }
  for (let index = last + 1; index < before.blocks.length; index += 1) {
    if (stayed.has(index)) return beside(index, false);
  }
  return null;
}

// --- what the panel says --------------------------------------------------

function wentParts(before: Side, gone: readonly number[]): ChangePart[] {
  if (gone.length === 0) return [];
  const text = [...gone]
    .sort((a, b) => a - b)
    .map((index) => blockAt(before, index).text)
    .join('\n');
  return [{ kind: 'gone', text }];
}

/**
 * A change as the words that went and the words that came (design 4.4:
 * "inline old and new text, like a track-changes view").
 *
 * The runs are the engine's, over the normalized text of each block, so
 * what this shows is what the alignment actually compared. The untouched
 * text between them is taken from the new side, which is the version the
 * reader is looking at.
 */
export function tracked(before: string, after: string, words: readonly WordRun[]): ChangePart[] {
  const parts: ChangePart[] = [];
  let at = 0;
  for (const run of words) {
    if (run.new_from > at) parts.push({ kind: 'same', text: after.slice(at, run.new_from) });
    if (run.old_to > run.old_from) {
      parts.push({ kind: 'gone', text: before.slice(run.old_from, run.old_to) });
    }
    if (run.new_to > run.new_from) {
      parts.push({ kind: 'new', text: after.slice(run.new_from, run.new_to) });
    }
    at = run.new_to;
  }
  if (at < after.length) parts.push({ kind: 'same', text: after.slice(at) });
  return parts;
}

/** Words and the whitespace between them, so a slice can be rejoined. */
function pieces(text: string): string[] {
  return text.split(/(\s+)/).filter((piece) => piece !== '');
}

function words(text: string): number {
  return Math.ceil(pieces(text).length / 2);
}

function head(text: string, keep: number): string {
  return pieces(text)
    .slice(0, keep * 2 - 1)
    .join('');
}

function tail(text: string, keep: number): string {
  return pieces(text)
    .slice(-(keep * 2 - 1))
    .join('');
}

/**
 * A panel is worth reading only if the change is the biggest thing in
 * it. Untouched text keeps a few words at each end for context and gives
 * up the middle; a whole section that went keeps its opening.
 */
export function shorten(parts: readonly ChangePart[]): ChangePart[] {
  const out: ChangePart[] = [];
  parts.forEach((part, index) => {
    if (part.kind !== 'same') {
      if (words(part.text) <= LIMIT) out.push(part);
      else out.push({ ...part, text: head(part.text, LIMIT) }, { kind: 'gap', text: '' });
      return;
    }
    const opens = index === 0;
    const closes = index === parts.length - 1;
    const keep = opens || closes ? CONTEXT : CONTEXT * 2;
    if (words(part.text) <= keep + 1) {
      out.push(part);
      return;
    }
    if (!opens) out.push({ kind: 'same', text: head(part.text, CONTEXT) });
    out.push({ kind: 'gap', text: '' });
    if (!closes) out.push({ kind: 'same', text: tail(part.text, CONTEXT) });
  });
  return out;
}
