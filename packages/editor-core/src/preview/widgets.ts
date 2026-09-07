import type { EditorState, Transaction } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';

/** Anything that can run a command: a view, or a state with a dispatch. */
export interface CommandTarget {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
}

/** Replaces `- ` in front of a bullet list item. Never revealed; the cursor skips it. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mdr-bullet';
    span.textContent = '•';
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Replaces `[ ] ` or `[x] ` in a task item. Clicking it dispatches a
 * one-character change to the marker and nothing else, which is the byte
 * diff the round-trip corpus expects from a checkbox toggle.
 */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'mdr-checkbox';
    input.checked = this.checked;
    input.tabIndex = -1;
    input.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('click', (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(input));
    });
    return input;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Flip the task marker that starts at `pos` between `[ ]` and `[x]`.
 * Returns false when there is no marker there. The change touches exactly
 * one character.
 */
export function toggleTaskAt(view: CommandTarget, pos: number): boolean {
  const text = view.state.doc.sliceString(pos, pos + 3);
  let insert: string;
  if (text === '[ ]') insert = 'x';
  else if (/^\[[xX]\]$/.test(text)) insert = ' ';
  else return false;
  view.dispatch(
    view.state.update({
      changes: { from: pos + 1, to: pos + 2, insert },
      userEvent: 'input.toggleTask',
    }),
  );
  return true;
}
