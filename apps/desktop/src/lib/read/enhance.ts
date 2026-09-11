/**
 * The three renderers Read mode hands work to after first paint: Shiki for
 * fences, KaTeX for math, Mermaid for diagrams (design 6.2).
 *
 * All three are loaded on demand and applied per chunk, so a document with
 * no code, no math and no diagrams never pays for them, and a slow diagram
 * never delays the page. Every element is marked when it is done, so a
 * second pass over the same chunk is free.
 */

import { tokenClass, tokenOfColor, tokenTheme, tokenThemeName } from '@markdown/theme';

const DONE = 'data-enhanced';

type Highlighter = Awaited<ReturnType<typeof loadShiki>>;

let shiki: Promise<Highlighter> | null = null;
let katex: Promise<typeof import('katex').default> | null = null;
let mermaid: Promise<typeof import('mermaid').default> | null = null;
let mermaidCount = 0;

/**
 * The languages Read mode highlights, with the aliases documents use for
 * them. Shiki's own bundle carries two hundred grammars; naming them all
 * would put fourteen megabytes of TextMate JSON in the installer for
 * languages nobody writes markdown about. A fence in an unlisted language
 * renders as plain code, which is what every fence did before Shiki
 * loaded. Adding one is one line.
 */
const LANGUAGES = {
  bash: () => import('@shikijs/langs/bash'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  graphql: () => import('@shikijs/langs/graphql'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  latex: () => import('@shikijs/langs/latex'),
  lua: () => import('@shikijs/langs/lua'),
  make: () => import('@shikijs/langs/make'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scala: () => import('@shikijs/langs/scala'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
  zig: () => import('@shikijs/langs/zig'),
};

type LanguageId = keyof typeof LANGUAGES;

const ALIASES: Record<string, LanguageId> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  dockerfile: 'docker',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsx: 'tsx',
  makefile: 'make',
  md: 'markdown',
  mdx: 'markdown',
  objc: 'c',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  tex: 'latex',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

/** The grammar id for a fence's info string, if there is one. */
function languageId(info: string): LanguageId | null {
  const name = info.toLowerCase();
  if (name in LANGUAGES) return name as LanguageId;
  return ALIASES[name] ?? null;
}

/**
 * The longest line Shiki is asked to tokenize; one longer stays plain.
 * A fence of minified code can be a single line of hundreds of
 * kilobytes, and colouring it is not worth holding the page for. VS
 * Code stops at the same length.
 */
const LONGEST_TOKENIZED_LINE = 20_000;

async function loadShiki() {
  const [core, engine] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]);
  const highlighter = await core.createHighlighterCore({
    // Not one of Shiki's own themes, and not a palette either: the one
    // theme registered here says which token a run of characters is,
    // and the render writes that name onto the span (plan WP 2.6).
    themes: [tokenTheme()],
    langs: [],
    // The JavaScript engine, not the WebAssembly one: a webview under a
    // `default-src 'self'` policy cannot compile WebAssembly, and the
    // grammars this app meets do not need what only Oniguruma can do.
    engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
  });
  return { highlighter, loaded: new Set<string>() };
}

async function loadKatex() {
  const [module] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
  return module.default;
}

async function loadMermaid() {
  const module = await import('mermaid');
  return module.default;
}

type Engine = Awaited<ReturnType<typeof loadMermaid>>;
type Rgb = [number, number, number];

/** The palette Mermaid is set up to draw in, as `DiagramTheme.key`. */
let configured: string | null = null;

/** Every diagram drawn, with its source and the palette it was drawn in. */
const drawn = new WeakMap<HTMLElement, { source: string; key: string }>();

/**
 * The same diagrams, to be found again for a change of palette. Weakly,
 * and not by asking the page: Read mode keeps a block it has scrolled
 * away from out of the page for a scroll back, and a diagram in one of
 * those has to come back in whatever palette the page wears by then.
 */
const live = new Set<WeakRef<HTMLElement>>();

interface DiagramTheme {
  /** Everything below as one string, so two palettes compare as one. */
  key: string;
  variables: Record<string, string | boolean>;
  font: string;
}

function rgb(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

function css(color: Rgb): string {
  return `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** `top` laid over `under` at `amount`. */
function mix(top: Rgb, under: Rgb, amount: number): string {
  return css(top.map((channel, i) => channel * amount + (under[i] ?? 0) * (1 - amount)) as Rgb);
}

/**
 * The page's own palette, in the terms Mermaid's `base` theme takes one
 * (design 11).
 *
 * Mermaid bakes its colours into the SVG it draws, so unlike a fence a
 * diagram cannot be left to the stylesheet: the colours are read off the
 * page as it is dressed at the moment of drawing, and a change of theme,
 * appearance or paper draws the diagrams again (`retheme`). Boxes are the
 * page's accent at a tint, lines are its quieter ink and labels its text,
 * all on its own paper and in its own face — so a diagram reads as part
 * of the document rather than as a picture pasted into it.
 */
function diagramTheme(dark: boolean | undefined): DiagramTheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: Rgb): Rgb => rgb(style.getPropertyValue(name)) ?? fallback;
  const bg = read('--page-bg', [255, 255, 255]);
  const fg = css(read('--page-fg', [31, 29, 26]));
  const muted = css(read('--page-muted', [111, 107, 100]));
  const border = css(read('--page-border', [219, 215, 208]));
  const code = css(read('--code-bg', [245, 244, 241]));
  const accent = read('--page-accent', [47, 111, 159]);
  const isDark = dark ?? 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 100;
  const box = mix(accent, bg, isDark ? 0.16 : 0.1);
  const edge = mix(accent, bg, isDark ? 0.5 : 0.42);
  const variables = {
    darkMode: isDark,
    background: css(bg),
    fontSize: '14px',
    primaryColor: box,
    primaryTextColor: fg,
    primaryBorderColor: edge,
    secondaryColor: mix(accent, bg, isDark ? 0.1 : 0.06),
    secondaryTextColor: fg,
    secondaryBorderColor: edge,
    tertiaryColor: code,
    tertiaryTextColor: fg,
    tertiaryBorderColor: border,
    textColor: fg,
    titleColor: fg,
    lineColor: muted,
    mainBkg: box,
    nodeBorder: edge,
    clusterBkg: code,
    clusterBorder: border,
    edgeLabelBackground: css(bg),
    noteBkgColor: code,
    noteTextColor: fg,
    noteBorderColor: border,
    actorBkg: box,
    actorBorder: edge,
    actorTextColor: fg,
    actorLineColor: muted,
    signalColor: fg,
    signalTextColor: fg,
    labelBoxBkgColor: code,
    labelBoxBorderColor: border,
    labelTextColor: fg,
    loopTextColor: fg,
    activationBkgColor: code,
    activationBorderColor: border,
    sequenceNumberColor: css(bg),
  };
  const font =
    style.getPropertyValue('--family-sans').trim() || 'ui-sans-serif, system-ui, sans-serif';
  return { key: JSON.stringify([variables, font]), variables, font };
}

/** Boxes rounded like every other box on the page, which the palette cannot say. */
const DIAGRAM_CSS = '.node rect, .cluster rect { rx: 6px; ry: 6px; }';

function configure(engine: Engine, theme: DiagramTheme): void {
  if (configured === theme.key) return;
  engine.initialize({
    startOnLoad: false,
    // Untrusted input: a diagram in a document an agent wrote is not a
    // reason to let it into the page as markup.
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: { ...theme.variables, fontFamily: theme.font },
    fontFamily: theme.font,
    themeCSS: DIAGRAM_CSS,
  });
  configured = theme.key;
}

/**
 * Shiki's tokens as spans that name what they are (plan WP 2.6).
 *
 * Built as nodes rather than as markup: there is no HTML to parse, so
 * nothing from the document can be markup either, and the fence carries
 * class names instead of colours. Changing the theme, the appearance or
 * the paper then costs nothing at all — the same spans resolve to the
 * new palette's variables.
 */
function paint(code: HTMLElement, lines: { content: string; color?: string }[][]): void {
  const out = document.createDocumentFragment();
  for (const [at, line] of lines.entries()) {
    if (at > 0) out.append('\n');
    for (const token of line) {
      const name = tokenOfColor(token.color);
      if (name === null) {
        out.append(token.content);
        continue;
      }
      const span = document.createElement('span');
      span.className = tokenClass(name);
      span.textContent = token.content;
      out.append(span);
    }
  }
  code.replaceChildren(out);
}

export interface Enhancer {
  /**
   * Enhance everything inside these elements.
   *
   * Read mode does not wait for this: a slow diagram must not hold up a
   * page that is already legible without it. The promise is for the one
   * caller that has to wait — an export, which is finished only when
   * every fence, formula and diagram is (plan WP 3.2).
   */
  run(roots: readonly HTMLElement[], options?: EnhanceOptions): Promise<void>;
  /**
   * Draw the diagrams on screen again in the palette the page wears now
   * (design 11). Fences and formulas follow the stylesheet by themselves;
   * a diagram has its colours baked in, so a change of theme, appearance
   * or paper has to ask for it.
   */
  retheme?(): void;
  destroy(): void;
}

export interface EnhancerOptions {
  /**
   * Whether the page is a dark one, asked whenever a diagram is drawn.
   * The paper's darkness, not the system's: a diagram on the
   * high-contrast page is on a dark ground in a light window.
   */
  dark?: () => boolean;
}

export interface EnhanceOptions {
  /**
   * What KaTeX writes a formula as. The window gets `html`, which is
   * spans positioned against KaTeX's own stylesheet and its own fonts;
   * an export gets `mathml`, which is a browser's own business and needs
   * neither, and so travels inside a single file (plan WP 3.2).
   *
   * Per run rather than per enhancer, because the difference is in the
   * one call that writes the formula: the loaded module, the highlighter
   * and its grammars are the same either way, and an export should not
   * mean a second copy of them.
   */
  math?: 'html' | 'mathml';
}

export function createEnhancer(options: EnhancerOptions = {}): Enhancer {
  let alive = true;

  function targets(roots: readonly HTMLElement[], selector: string): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (const root of roots) {
      if (root.matches(selector)) found.push(root);
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) found.push(el);
    }
    return found.filter((el) => !el.hasAttribute(DONE));
  }

  async function highlight(roots: readonly HTMLElement[]): Promise<void> {
    const blocks = targets(roots, 'pre.mdr-code[data-lang] > code');
    if (blocks.length === 0) return;
    for (const block of blocks) block.setAttribute(DONE, '');
    shiki ??= loadShiki();
    const { highlighter, loaded } = await shiki;
    for (const block of blocks) {
      if (!alive || !block.isConnected) continue;
      const id = languageId(block.closest('pre')?.dataset.lang ?? '');
      if (id === null) continue;
      const fresh = !loaded.has(id);
      if (fresh) {
        await highlighter.loadLanguage(await LANGUAGES[id]());
        loaded.add(id);
      }
      if (!alive || !block.isConnected) continue;
      const source = block.textContent ?? '';
      try {
        const { tokens } = highlighter.codeToTokens(source, {
          lang: id,
          theme: tokenThemeName,
          // Without a clock. By default Shiki gives up on a line after
          // 500 ms and hands the rest of it back as one token, still in
          // whatever it was in -- a type annotation, a comment -- and
          // starts the next line from there as well. The first block
          // through a grammar is the one that pays for compiling its
          // patterns, which takes WebKit most of a second on a quiet Mac,
          // so it was that block which came out in its neighbour's
          // colour, and it stayed that way: nothing renders it twice. A
          // line too long to tokenize at all is what the limit was for,
          // and a length says that without asking how busy the machine is.
          tokenizeTimeLimit: 0,
          tokenizeMaxLineLength: LONGEST_TOKENIZED_LINE,
        });
        paint(block, tokens);
      } catch {
        // A grammar the JavaScript engine cannot run leaves plain code,
        // which is what the block already shows.
      }
    }
  }

  async function math(roots: readonly HTMLElement[], output: 'html' | 'mathml'): Promise<void> {
    const nodes = targets(roots, '[data-tex]');
    if (nodes.length === 0) return;
    for (const node of nodes) node.setAttribute(DONE, '');
    katex ??= loadKatex();
    const render = await katex;
    for (const node of nodes) {
      if (!alive || !node.isConnected) continue;
      try {
        render.render(node.dataset.tex ?? '', node, {
          displayMode: node.classList.contains('mdr-math-block'),
          throwOnError: false,
          // The document may come from a model; `\href` and friends stay off.
          trust: false,
          output,
        });
      } catch {
        // Leave the TeX source in place: it is what the file says.
      }
    }
  }

  /**
   * Mermaid, loaded once. A load that fails is not a verdict on the
   * diagrams waiting for it: they are left for the next run over them to
   * try again, rather than kept as source for the rest of the session.
   */
  async function diagramEngine(waiting: readonly HTMLElement[]): Promise<Engine | null> {
    mermaid ??= loadMermaid();
    try {
      return await mermaid;
    } catch {
      mermaid = null;
      for (const node of waiting) node.removeAttribute(DONE);
      return null;
    }
  }

  /** One diagram, in the palette the page is wearing as it is drawn. */
  async function draw(engine: Engine, node: HTMLElement, source: string): Promise<void> {
    const theme = diagramTheme(options.dark?.());
    configure(engine, theme);
    mermaidCount += 1;
    try {
      const { svg } = await engine.render(`mdr-diagram-${mermaidCount}`, source);
      // Placed even when the block has left the page meanwhile. Read mode
      // keeps a block it scrolled past and later puts the same element
      // back without handing it here again, so a diagram skipped for being
      // out of the page stayed as its source for good.
      if (!alive) return;
      const template = document.createElement('template');
      template.innerHTML = svg;
      node.replaceChildren(template.content);
      node.classList.add('mdr-mermaid-done');
      if (!drawn.has(node)) live.add(new WeakRef(node));
      drawn.set(node, { source, key: theme.key });
    } catch (error) {
      node.classList.add('mdr-mermaid-failed');
      node.setAttribute('title', error instanceof Error ? error.message : 'diagram failed');
    }
  }

  async function diagrams(roots: readonly HTMLElement[]): Promise<void> {
    const nodes = targets(roots, '.mdr-mermaid');
    if (nodes.length === 0) return;
    for (const node of nodes) node.setAttribute(DONE, '');
    const engine = await diagramEngine(nodes);
    if (engine === null) return;
    for (const node of nodes) {
      if (!alive) return;
      await draw(engine, node, node.textContent ?? '');
    }
  }

  return {
    async run(roots, run = {}) {
      if (!alive || roots.length === 0) return;
      // Settled rather than all: each of the three already leaves the
      // document as it was when it cannot do its part, and a library
      // that never loads is the same thing one step earlier. It should
      // not cost the other two their turn, or an export its page.
      await Promise.allSettled([
        highlight(roots),
        math(roots, run.math ?? 'html'),
        diagrams(roots),
      ]);
    },
    retheme() {
      if (!alive || mermaid === null) return;
      const key = diagramTheme(options.dark?.()).key;
      const stale: HTMLElement[] = [];
      for (const ref of live) {
        const node = ref.deref();
        if (node === undefined) live.delete(ref);
        else if (drawn.get(node)?.key !== key) stale.push(node);
      }
      if (stale.length === 0) return;
      void (async () => {
        const engine = await diagramEngine([]);
        if (engine === null) return;
        for (const node of stale) {
          if (!alive) return;
          const was = drawn.get(node);
          if (was !== undefined) await draw(engine, node, was.source);
        }
      })();
    },
    destroy() {
      alive = false;
    },
  };
}
