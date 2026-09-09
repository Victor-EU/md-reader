import {
  codeTokens,
  noteKinds,
  type Palette,
  type Paper,
  papers,
  type Theme,
  tokenClass,
  tokenVariable,
} from './theme.ts';

/**
 * The themes as one stylesheet (plan WP 2.6).
 *
 * Generated rather than hand-written, and checked in rather than built at
 * startup. Checked in because the window is shown before the first script
 * runs, and a reader who chose dark should not be shown a white page
 * first; generated because the JSON is the one place a colour is written
 * down. `theme.test.ts` regenerates it and fails if the file has drifted,
 * which `vitest -u` fixes.
 *
 * All four themes at once, rather than a stylesheet each. Switching is
 * then an attribute and not a load: no flash of the old palette while
 * the new one arrives, and no second copy of the rules to keep in step.
 * Three attributes on the root element select between the blocks:
 * `data-theme`, `data-appearance` for the chrome, and `data-paper` for
 * the page. The page's colours follow the paper, so the high-contrast
 * black paper carries the dark code palette into a light window without
 * a fourth attribute to keep in step.
 *
 * The bare `:root` block is the exception, and it is what the window
 * wears for the frame before the settings arrive: the default theme, in
 * light, or in dark where the system says so.
 */

/** The selector for "the page is dark", whichever way it got that way. */
function darkPage(prefix: string): string {
  return `${prefix}[data-appearance="dark"], ${prefix}[data-paper="black"]`;
}

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
    // The change marks. Their meanings are the ones the annotation
    // notes already have names for, and taking the colours from there is
    // what makes them legible on the black paper as well as the white
    // (plan WP 2.2).
    '--mdr-change-added: var(--note-keep);',
    '--mdr-change-changed: var(--note-attention);',
    '--mdr-change-removed: var(--note-remove);',
    '--mdr-change-moved: var(--note-rewrite);',
  ];
}

/** What a paper is worth, as the three variables the page reads. */
function paperVariables(palette: Palette, paper: Paper): string[] {
  const colors = palette.papers[paper];
  return [`--page-bg: ${colors.bg};`, `--page-fg: ${colors.fg};`, `--code-bg: ${colors.code};`];
}

/**
 * One theme, fully qualified. Every rule carries the theme's own
 * attribute, so the four sets never have to be read in order to know
 * which one is speaking.
 */
function themeBlocks(theme: Theme): string {
  const prefix = `:root[data-theme="${theme.id}"]`;
  return [
    block(prefix, [
      'color-scheme: light;',
      ...uiVariables(theme.light),
      ...paperVariables(theme.light, 'white'),
      ...pageVariables(theme.light),
    ]),
    block(`${prefix}[data-appearance="dark"]`, [
      'color-scheme: dark;',
      ...uiVariables(theme.dark),
      ...paperVariables(theme.dark, 'white'),
    ]),
    // The page is dark when the appearance is, and also when the reader
    // picked the high-contrast paper in a light window.
    block(darkPage(prefix), pageVariables(theme.dark)),
    ...papers.map((paper) =>
      block(`${prefix}[data-paper="${paper}"]`, paperVariables(theme.light, paper)),
    ),
    ...papers.map((paper) =>
      block(
        `${prefix}[data-appearance="dark"][data-paper="${paper}"]`,
        paperVariables(theme.dark, paper),
      ),
    ),
  ].join('\n');
}

export function themeCss(list: readonly Theme[]): string {
  const first = list[0];
  if (!first) throw new Error('a stylesheet needs at least one theme');
  const head = [
    '/*',
    ` * ${list.map((theme) => theme.name).join(', ')} — generated from themes/*.json`,
    ' * by theme.test.ts. Edit the JSON, then run `vitest -u`.',
    ' * Do not edit this file by hand.',
    ' */',
    '',
  ].join('\n');

  const parts: string[] = [
    // Before the first script runs there is no attribute to go on, and
    // the window is already on screen: Rust shows it as soon as it is
    // placed. The default theme on white paper, following the system,
    // is what it wears until the settings arrive.
    block(':root', [
      'color-scheme: light;',
      ...uiVariables(first.light),
      ...paperVariables(first.light, 'white'),
      ...pageVariables(first.light),
    ]),
    indent(
      '@media (prefers-color-scheme: dark)',
      block(':root:not([data-appearance])', [
        'color-scheme: dark;',
        ...uiVariables(first.dark),
        ...paperVariables(first.dark, 'white'),
        ...pageVariables(first.dark),
      ]),
    ),
    ...list.map(themeBlocks),
    // A highlighted fence names its tokens rather than colouring them
    // (plan WP 2.6), so this is where a fence gets its colours — from
    // the same variables the live editor's highlighter reads.
    ...codeTokens.map((token) =>
      block(`.mdr-code .${tokenClass(token)}`, [`color: var(${tokenVariable(token)});`]),
    ),
    // One colour per meaning and per callout type, on the attribute both
    // the rendered page and the editor's widgets already carry. The
    // colour itself is the theme's; these only say which name to read.
    ...noteKinds.map((kind) => block(NOTE_SELECTOR(kind), [`--mdr-note: var(--note-${kind});`])),
    ...Object.keys(first.light.callouts).map((type) =>
      block(`[data-callout="${type}"]`, [`--mdr-callout: var(--callout-${type});`]),
    ),
  ];
  return `${head}${parts.join('\n')}`;
}
