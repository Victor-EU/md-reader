import {
  type Appearance,
  codeTokens,
  noteKinds,
  type Palette,
  type Paper,
  papers,
  type Theme,
} from './theme.ts';

/**
 * The theme as a stylesheet.
 *
 * Generated rather than hand-written, and checked in rather than built at
 * startup. Checked in because the window is shown before the first script
 * runs, and a reader who chose dark should not be shown a white page
 * first; generated because the JSON is the one place a colour is written
 * down. `theme-css.test.ts` regenerates it and fails if the file has
 * drifted, which `vitest -u` fixes.
 *
 * Two attributes on the root element select between the blocks:
 * `data-appearance` for the chrome and `data-paper` for the page. The
 * page's colours follow the paper, so the high-contrast black paper
 * carries the dark code palette into a light window without a third
 * attribute to keep in step.
 */

/** The selector for "the page is dark", whichever way it got that way. */
const DARK_PAGE = ':root[data-appearance="dark"], :root[data-paper="black"]';

/**
 * A fence's tokens. Shiki is given both palettes at once and writes them
 * onto every token as `--shiki-light` and `--shiki-dark`; choosing
 * between them is the page's job, and it has to be a rule rather than a
 * variable because a custom property that refers to one the root does
 * not have resolves to nothing at all.
 */
const TOKENS = '.mdr-code span';

const NOTE_SELECTOR = (kind: string) =>
  `.mdr-comment[data-kind="${kind}"], .mdr-comment-widget[data-kind="${kind}"]`;

/** Wrap rules in an at-rule, indenting what goes inside it. */
function indent(atRule: string, rules: string): string {
  const inner = rules
    .split('\n')
    .map((line) => (line === '' ? line : `  ${line}`))
    .join('\n');
  return `${atRule} {\n${inner}}\n`;
}

/** One rule, written the way the formatter wants it: a selector a line. */
function block(selector: string, lines: string[]): string {
  const head = selector.split(', ').join(',\n');
  return `${head} {\n${lines.map((line) => `  ${line}`).join('\n')}\n}\n`;
}

/** The chrome, which follows the appearance and nothing else. */
function uiVariables(palette: Palette): string[] {
  const { ui } = palette;
  return [
    `--bar-bg: ${ui.bg};`,
    `--bar-fg: ${ui.fg};`,
    `--muted: ${ui.muted};`,
    `--border: ${ui.border};`,
    `--hover-bg: ${ui.hover};`,
    `--active-bg: ${ui.active};`,
    `--accent: ${ui.accent};`,
    `--dirty: ${ui.dirty};`,
    `--shadow: ${ui.shadow};`,
    `--highlight: ${ui.highlight};`,
    // Every paper, not only the one in use: the settings tab paints a
    // swatch of each, and a swatch that is not the paper is a lie.
    ...papers.map((paper) => `--paper-${paper}: ${palette.papers[paper].bg};`),
  ];
}

/**
 * The page, which follows the paper.
 *
 * The chrome's border, muted ink, accent and highlight have page-side
 * twins here rather than being reused: the high-contrast paper is a dark
 * page inside a light window, and a rule that borrowed the toolbar's
 * grey would draw a pale line across a black page. The editor reads the
 * same values through the `--mdr-` names its own base theme was written
 * against, so one palette dresses the rendered page and the live
 * preview alike.
 */
function pageVariables(palette: Palette): string[] {
  const code = palette.code;
  const { ui } = palette;
  return [
    `--page-border: ${ui.border};`,
    `--page-muted: ${ui.muted};`,
    `--page-accent: ${ui.accent};`,
    `--mark: ${ui.highlight};`,
    `--code-fg: ${code.foreground};`,
    ...codeTokens
      .filter((token) => token !== 'foreground')
      .map((token) => `--tok-${token}: ${code[token]};`),
    ...noteKinds.map((kind) => `--note-${kind}: ${palette.notes[kind]};`),
    ...Object.entries(palette.callouts).map(([type, color]) => `--callout-${type}: ${color};`),
    '--mdr-bg: var(--page-bg);',
    '--mdr-fg: var(--page-fg);',
    '--mdr-code-bg: var(--code-bg);',
    '--mdr-border: var(--page-border);',
    '--mdr-muted: var(--page-muted);',
    '--mdr-link: var(--page-accent);',
    '--mdr-highlight: var(--mark);',
    '--mdr-quote: var(--page-border);',
    '--mdr-note: var(--note-note);',
    '--mdr-callout: var(--callout-note);',
    // A conflict is a question waiting on the reader, which is what the
    // warning callout's colour already means in this palette -- and it
    // is the one that is legible on the black paper as well as the
    // white (plan WP 2.1).
    '--mdr-conflict: var(--callout-warning);',
  ];
}

/** What a paper is worth, as the three variables the page reads. */
function paperVariables(palette: Palette, paper: Paper): string[] {
  const colors = palette.papers[paper];
  return [`--page-bg: ${colors.bg};`, `--page-fg: ${colors.fg};`, `--code-bg: ${colors.code};`];
}

function paperBlocks(theme: Theme, appearance: Appearance): string {
  const palette = appearance === 'light' ? theme.light : theme.dark;
  const prefix = appearance === 'light' ? ':root' : ':root[data-appearance="dark"]';
  return papers
    .map((paper) => block(`${prefix}[data-paper="${paper}"]`, paperVariables(palette, paper)))
    .join('\n');
}

export function themeCss(theme: Theme): string {
  const head = [
    '/*',
    ` * ${theme.name} — generated from themes/${theme.id}.json by theme-css.test.ts.`,
    ' * Edit the JSON, then run `vitest -u`. Do not edit this file by hand.',
    ' */',
    '',
  ].join('\n');

  const parts: string[] = [
    // White paper is the default here as well as in the settings, so a
    // window that has not been told anything yet is already dressed.
    block(':root', [
      'color-scheme: light;',
      ...uiVariables(theme.light),
      ...paperVariables(theme.light, 'white'),
      ...pageVariables(theme.light),
    ]),
    block(':root[data-appearance="dark"]', [
      'color-scheme: dark;',
      ...uiVariables(theme.dark),
      ...paperVariables(theme.dark, 'white'),
    ]),
    // The page is dark when the appearance is, and also when the reader
    // picked the high-contrast paper in a light window.
    block(DARK_PAGE, pageVariables(theme.dark)),
    block(TOKENS, ['color: var(--shiki-light);']),
    block(
      DARK_PAGE.split(', ')
        .map((selector) => `${selector} ${TOKENS}`)
        .join(', '),
      ['color: var(--shiki-dark);'],
    ),
    // Before the first script runs there is no attribute to go on, and
    // the window is already on screen: Rust shows it as soon as it is
    // placed. Follow the system until the settings arrive, so a reader
    // in dark is never shown a white page first.
    indent(
      '@media (prefers-color-scheme: dark)',
      block(':root:not([data-appearance])', [
        'color-scheme: dark;',
        ...uiVariables(theme.dark),
        ...paperVariables(theme.dark, 'white'),
        ...pageVariables(theme.dark),
      ]) + block(`:root:not([data-appearance]) ${TOKENS}`, ['color: var(--shiki-dark);']),
    ),
    paperBlocks(theme, 'light'),
    paperBlocks(theme, 'dark'),
    // One colour per meaning and per callout type, on the attribute both
    // the rendered page and the editor's widgets already carry.
    ...noteKinds.map((kind) => block(NOTE_SELECTOR(kind), [`--mdr-note: var(--note-${kind});`])),
    ...Object.keys(theme.light.callouts).map((type) =>
      block(`[data-callout="${type}"]`, [`--mdr-callout: var(--callout-${type});`]),
    ),
  ];
  return `${head}${parts.join('\n')}`;
}
