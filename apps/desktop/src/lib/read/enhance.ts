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

async function loadMermaid(dark: boolean) {
  const module = await import('mermaid');
  module.default.initialize({
    startOnLoad: false,
    // Untrusted input: a diagram in a document an agent wrote is not a
    // reason to let it into the page as markup.
    securityLevel: 'strict',
    // The paper's darkness, not the system's: a diagram on the
    // high-contrast page is on a dark ground in a light window.
    theme: dark ? 'dark' : 'default',
  });
  return module.default;
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
  destroy(): void;
}

export interface EnhancerOptions {
  /**
   * Whether the page is a dark one, asked when Mermaid first loads.
   * Mermaid bakes its palette into the SVG it produces, so unlike Shiki
   * it cannot be given both and left to the stylesheet.
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

  async function diagrams(roots: readonly HTMLElement[]): Promise<void> {
    const nodes = targets(roots, '.mdr-mermaid');
    if (nodes.length === 0) return;
    for (const node of nodes) node.setAttribute(DONE, '');
    mermaid ??= loadMermaid(options.dark?.() ?? false);
    const engine = await mermaid;
    for (const node of nodes) {
      if (!alive || !node.isConnected) continue;
      const source = node.textContent ?? '';
      mermaidCount += 1;
      try {
        const { svg } = await engine.render(`mdr-diagram-${mermaidCount}`, source);
        if (!alive || !node.isConnected) continue;
        const template = document.createElement('template');
        template.innerHTML = svg;
        node.replaceChildren(template.content);
        node.classList.add('mdr-mermaid-done');
      } catch (error) {
        node.classList.add('mdr-mermaid-failed');
        node.setAttribute('title', error instanceof Error ? error.message : 'diagram failed');
      }
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
    destroy() {
      alive = false;
    },
  };
}
