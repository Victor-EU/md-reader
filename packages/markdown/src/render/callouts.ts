/**
 * The callout types of design 5.1: Obsidian's set and GitHub's, merged.
 *
 * GitHub styles `[!IMPORTANT]` and `[!CAUTION]` as their own kinds while
 * Obsidian treats them as aliases of tip and warning. The union is the
 * superset: both are canonical here, so a GitHub document keeps its five
 * distinct colours and an Obsidian document loses nothing.
 *
 * A type nobody defined still renders as a callout, styled like a note
 * with its own word as the title. That is the "most plausible intent"
 * rule of design 5.2 applied to a syntax models invent freely.
 */

export interface CalloutType {
  /** The type as the stylesheet and `data-callout` know it. */
  readonly name: string;
  /** The default title, used when the header carries no title of its own. */
  readonly title: string;
  /** False when the source used a word the set does not define. */
  readonly known: boolean;
}

/** Canonical type to default title. */
const TITLES: Record<string, string> = {
  note: 'Note',
  abstract: 'Abstract',
  info: 'Info',
  todo: 'Todo',
  tip: 'Tip',
  important: 'Important',
  success: 'Success',
  question: 'Question',
  warning: 'Warning',
  caution: 'Caution',
  failure: 'Failure',
  danger: 'Danger',
  bug: 'Bug',
  example: 'Example',
  quote: 'Quote',
};

/** Every other spelling Obsidian accepts, mapped onto the canonical type. */
const ALIASES: Record<string, string> = {
  summary: 'abstract',
  tldr: 'abstract',
  hint: 'tip',
  check: 'success',
  done: 'success',
  help: 'question',
  faq: 'question',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

/** The canonical names, for the stylesheet and for tests that pin the set. */
export const calloutTypes: readonly string[] = Object.keys(TITLES);

/** Resolve the word between `[!` and `]` to a type. Never fails. */
export function calloutType(raw: string): CalloutType {
  const word = raw.trim().toLowerCase();
  const canonical = word in TITLES ? word : ALIASES[word];
  if (canonical !== undefined) {
    return { name: canonical, title: TITLES[canonical] ?? 'Note', known: true };
  }
  return {
    name: 'note',
    title: word === '' ? 'Note' : word.charAt(0).toUpperCase() + word.slice(1),
    known: false,
  };
}
