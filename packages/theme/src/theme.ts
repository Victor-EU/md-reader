/**
 * Theme one as data (design 11, plan WP 1.9).
 *
 * A theme is a JSON file, not code, because Phase 2 adds three more and
 * a reader's own is the obvious step after that. Everything that puts
 * colour on the screen reads this one file: the stylesheet the window
 * loads, Shiki's fences in Read mode, and the CodeMirror highlighter in
 * Edit and Source. That is the whole point of it — two highlighters that
 * disagree about what a keyword looks like is the bug this shape makes
 * impossible.
 */

import one from './themes/one.json';

/** Light or dark, after `system` has been resolved against the OS. */
export type Appearance = 'light' | 'dark';

/**
 * The page's own background (design 11). Paper colour changes reading
 * comfort more than most people expect, so it is a setting of its own
 * rather than a consequence of light or dark.
 */
export const papers = ['white', 'cream', 'pad', 'black'] as const;
export type Paper = (typeof papers)[number];

/** The reading families, all three bundled under open licences. */
export const families = ['sans', 'serif', 'mono'] as const;
export type Family = (typeof families)[number];

/**
 * The code token vocabulary. Both highlighters are given the same names;
 * `tokens.ts` says which TextMate scopes and which Lezer tags each one
 * answers to.
 */
export const codeTokens = [
  'foreground',
  'comment',
  'keyword',
  'operator',
  'punctuation',
  'string',
  'escape',
  'number',
  'constant',
  'variable',
  'property',
  'function',
  'type',
  'invalid',
  'inserted',
  'deleted',
] as const;
export type CodeToken = (typeof codeTokens)[number];

/** The five meanings of design 4.3, plus the plain note that has no colour. */
export const noteKinds = ['note', 'attention', 'question', 'remove', 'keep', 'rewrite'] as const;
export type NoteKind = (typeof noteKinds)[number];

export interface Ui {
  /** The chrome: tab strip, toolbar, sidebar, status bar. */
  bg: string;
  fg: string;
  muted: string;
  border: string;
  hover: string;
  /** The active tab, which reads as the front of the page. */
  active: string;
  accent: string;
  /** An unsaved change, wherever one is shown. */
  dirty: string;
  shadow: string;
  /** `==marked==` text, in both the page and the editor. */
  highlight: string;
}

export interface PaperColors {
  bg: string;
  fg: string;
  /** Fences and inline code on this paper. */
  code: string;
}

export interface Palette {
  ui: Ui;
  papers: Record<Paper, PaperColors>;
  code: Record<CodeToken, string>;
  notes: Record<NoteKind, string>;
  /** One colour per canonical callout type of design 5.1. */
  callouts: Record<string, string>;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  light: Palette;
  dark: Palette;
}

/** Theme one. The only one Phase 1 ships; Phase 2 adds the other three. */
export const themeOne: Theme = one as Theme;

export function paletteFor(theme: Theme, appearance: Appearance): Palette {
  return appearance === 'light' ? theme.light : theme.dark;
}

/**
 * Whether a paper is dark, which is not the same question as whether the
 * appearance is. Black is the high-contrast paper and stays dark in a
 * light window, so what the page is written on decides how the code on
 * it is highlighted.
 */
export function paperIsDark(appearance: Appearance, paper: Paper): boolean {
  return paper === 'black' || appearance === 'dark';
}
