/**
 * The four themes as data (design 11, plan WP 1.9, plan WP 2.6).
 *
 * A theme is a JSON file, not code, because there are four of them and a
 * reader's own is the obvious step after that. One file per theme is the
 * only place a colour is written down: the stylesheet the window loads
 * carries every theme at once, and both highlighters name tokens rather
 * than colouring them, so a fence takes its colours from the same
 * variables the page does. Two highlighters that disagree about what a
 * keyword looks like is the bug this shape makes impossible.
 */

import grove from './themes/grove.json';
import ink from './themes/ink.json';
import one from './themes/one.json';
import slate from './themes/slate.json';

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

/**
 * The class a highlighted fence wears for a token, and the variable that
 * colours it (plan WP 2.6).
 *
 * Read mode's fences carry token names rather than colours. That is what
 * makes changing the theme, the appearance or the paper free: nothing is
 * re-highlighted, because nothing that was highlighted holds a colour.
 */
export function tokenClass(token: CodeToken): string {
  return `tok-${token}`;
}

export function tokenVariable(token: CodeToken): string {
  return token === 'foreground' ? '--code-fg' : `--tok-${token}`;
}

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

/**
 * The four curated themes of design 11, in the order the settings offer
 * them. Theme one is first because it is the default: what a window that
 * has never been told anything is dressed in.
 */
export const themes: readonly Theme[] = [one, slate, ink, grove] as Theme[];

/** The theme a window falls back to, and the one the bare stylesheet holds. */
export const DEFAULT_THEME = 'one' as const;

/**
 * A theme by id, falling back to the default.
 *
 * The settings file is a file: it can name a theme this build does not
 * have, and a window with no palette at all is worse than a window in
 * the wrong one.
 */
export function themeById(id: string | null | undefined): Theme {
  return themes.find((theme) => theme.id === id) ?? (themes[0] as Theme);
}

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
