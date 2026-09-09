import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { keepMine, takeTheirs } from './commands.ts';
import { type ConflictRegion, conflictState, conflicts, conflictsField } from './state.ts';

/**
 * A conflict as the reader sees it (design 7.2, scenario S5): their own
 * version, still editable text in the document, banded and labelled;
 * then what arrived on disk, which is not text in the document at all;
 * then the two choices.
 *
 * Their version is shown as the lines it would put there rather than as
 * rendered markdown. It is a version of the file being offered, and the
 * reader is choosing between two pieces of source -- one of which they
 * are looking at in the editor's own live preview two lines above. A
 * second renderer here would make the two harder to compare, not easier.
 */

/** The label above our version. Block, so it does not sit inside a line. */
class MineWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly empty: boolean,
  ) {
    super();
  }

  override eq(other: MineWidget): boolean {
    return other.id === this.id && other.empty === this.empty;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 22;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdr-conflict mdr-conflict-head';
    el.append(label('Mine'));
    // Nothing of ours is left to band, so the band has to say so; the
    // choice still stands, and keeping mine keeps the deletion.
    if (this.empty) el.append(note('you deleted these lines'));
    return el;
  }
}

/** Their version and the two buttons, below our lines. */
class TheirsWidget extends WidgetType {
  constructor(readonly region: ConflictRegion) {
    super();
  }

  override eq(other: TheirsWidget): boolean {
    return other.region.id === this.region.id && other.region.theirs === this.region.theirs;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 24 + lines(this.region.theirs).length * 21;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mdr-conflict mdr-conflict-foot';
    el.dataset.conflict = this.region.id;
    const bar = document.createElement('div');
    bar.className = 'mdr-conflict-bar';
    bar.append(label('Theirs'));
    const theirs = this.region.theirs;
    if (theirs === '') bar.append(note('they deleted these lines'));
    bar.append(
      choose('Keep mine', 'mine', () => keepMine(view, this.region.id)),
      choose('Take theirs', 'theirs', () => takeTheirs(view, this.region.id)),
    );
    el.append(bar);
    if (theirs !== '') {
      const body = document.createElement('div');
      body.className = 'mdr-conflict-theirs';
      body.textContent = lines(theirs).join('\n');
      el.append(body);
    }
    return el;
  }
}

function label(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mdr-conflict-label';
  el.textContent = text;
  return el;
}

function note(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'mdr-conflict-note';
  el.textContent = text;
  return el;
}

/**
 * A button that does not take the selection with it. `mousedown` is
 * where the editor would move the cursor, which would scroll the reader
 * away from what they are deciding about.
 */
function choose(text: string, choice: string, run: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mdr-conflict-choice';
  button.dataset.choice = choice;
  button.tabIndex = -1;
  button.textContent = text;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    run();
  });
  return button;
}

/** Their hunk as the lines it holds, without the terminator of the last one. */
function lines(theirs: string): string[] {
  const text = theirs.endsWith('\n') ? theirs.slice(0, -1) : theirs;
  return text === '' ? [] : text.split('\n');
}

const mineLine = Decoration.line({ class: 'cm-conflict-mine' });

/**
 * Both labels have to sit on a line boundary, which a region's ends do
 * when the merge returns them and may not after the reader has typed
 * across one. The head goes to the start of the line our version begins
 * in; the foot to the *end of the last line it covers*, not to where the
 * region stops.
 *
 * The difference shows when the reader deletes every line between two
 * open regions. A region's end and the next region's start are then the
 * same offset, and two block widgets at one offset are drawn in the
 * order their sides give -- which would put the second question's label
 * above the first question's panel. An end-of-line anchor is one
 * character earlier than the start of the line after it, so document
 * order draws them in the order they are about.
 */
function build(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const region of conflicts(state)) {
    const opens = state.doc.lineAt(region.from);
    const empty = region.from === region.to;
    const foot = empty ? opens.from : state.doc.lineAt(region.to - 1).to;
    ranges.push(
      Decoration.widget({
        widget: new MineWidget(region.id, empty),
        block: true,
        side: -1,
      }).range(opens.from),
      Decoration.widget({ widget: new TheirsWidget(region), block: true, side: 1 }).range(foot),
    );
    if (!empty) {
      const last = state.doc.lineAt(region.to - 1).number;
      for (let line = opens.number; line <= last; line += 1) {
        ranges.push(mineLine.range(state.doc.line(line).from));
      }
    }
  }
  return Decoration.set(ranges, true);
}

/**
 * The bands and the panel. Colours go through variables with plain
 * fallbacks, as the rest of the editor's styling does, so a theme can
 * restyle a conflict without this file knowing about it.
 */
const conflictTheme = EditorView.baseTheme({
  '.cm-conflict-mine': {
    background: 'color-mix(in srgb, var(--mdr-conflict, #c07000) 8%, transparent)',
    boxShadow: 'inset 3px 0 0 0 var(--mdr-conflict, #c07000)',
  },
  '.mdr-conflict': {
    fontSize: '0.85em',
    lineHeight: '1.6',
    borderLeft: '3px solid var(--mdr-conflict, #c07000)',
    background: 'color-mix(in srgb, var(--mdr-conflict, #c07000) 8%, transparent)',
    padding: '2px 8px',
  },
  '.mdr-conflict-head': { borderRadius: '4px 4px 0 0' },
  '.mdr-conflict-foot': { borderRadius: '0 0 4px 4px', paddingBottom: '6px' },
  '.mdr-conflict-bar': { display: 'flex', alignItems: 'baseline', gap: '8px' },
  '.mdr-conflict-label': {
    fontWeight: '600',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    fontSize: '0.85em',
    color: 'var(--mdr-conflict, #c07000)',
  },
  // The buttons go to the right of the bar, away from the text so that
  // reading their version and choosing it are two separate gestures.
  '.mdr-conflict-note': { opacity: '0.7', marginRight: 'auto' },
  '.mdr-conflict-label + .mdr-conflict-choice': { marginLeft: 'auto' },
  '.mdr-conflict-choice': {
    font: 'inherit',
    fontSize: '0.95em',
    padding: '1px 8px',
    borderRadius: '4px',
    cursor: 'pointer',
    color: 'inherit',
    border: '1px solid color-mix(in srgb, var(--mdr-conflict, #c07000) 45%, transparent)',
    background: 'var(--mdr-bg, transparent)',
  },
  '.mdr-conflict-choice:hover': {
    background: 'color-mix(in srgb, var(--mdr-conflict, #c07000) 18%, transparent)',
  },
  '.mdr-conflict-theirs': {
    whiteSpace: 'pre-wrap',
    marginTop: '4px',
    fontSize: '1.05em',
  },
});

/**
 * Conflict regions, drawn (plan WP 2.1). The field is loaded whether or
 * not anything is drawing, because the shell reads it to hold the save.
 */
export function conflictWidgets(): Extension {
  return [conflictState, EditorView.decorations.compute([conflictsField], build), conflictTheme];
}
