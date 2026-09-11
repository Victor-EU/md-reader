import type { ExportWrite } from '@markdown/ipc';
import { type ImageResolver, parser, renderDocument, toDom } from '@markdown/markdown';
import { type Appearance, type Family, type Paper, pageCss, themeById } from '@markdown/theme';
import readCss from '../read.css?inline';
import type { Reading } from './appearance.ts';
import { type ImageRules, resolveImage } from './images.ts';
import { basename } from './paths.ts';
import type { Enhancer } from './read/enhance.ts';
import { count } from './text.ts';

/**
 * A document as a page that stands on its own (plan WP 3.2).
 *
 * The same renderer Read mode uses, over the whole document at once
 * rather than a screenful at a time, with the same three enhancers run
 * over the result — so a fence is coloured, a formula is set and a
 * diagram is drawn in the exported file exactly as they are in the
 * window. What it wears is `read.css`, the stylesheet Read mode wears,
 * with the theme's variables written into a `:root` of its own: the
 * window chooses its palette with attributes a script writes, and an
 * exported page has no script and nothing arriving later, so the choice
 * is made here and written down.
 *
 * Three things the window has are deliberately not in it. There is no
 * chrome, because there is no app around the document. There are no
 * controls — no copy button on a fence, no fold arrow on a heading, no
 * clickable task box — because a copy of a document has nothing behind
 * them to act on. And there are no fonts: the three bundled faces are
 * megabytes, and every family is declared with the system stacks behind
 * it that design 11 keeps for exactly this.
 *
 * Formulas are the one place the export renders differently on purpose.
 * KaTeX's HTML output is spans positioned against its own stylesheet and
 * its own fonts, which a single file cannot carry; its MathML output is
 * the browser's own business and needs neither.
 */

/**
 * What stands in for a local image until the bytes are dealt with.
 *
 * The page cannot carry a path, and what it will carry — the bytes
 * inline, or a name beside it — is decided where the bytes are, which is
 * Rust. So each local image renders as its number, and `write_export`
 * puts the answer in. The other half of this literal is `SENTINEL` in
 * `crates/core/src/export.rs`.
 */
const SENTINEL = 'mdr-export-image-';

/** A source that is already something a browser can load on its own. */
const READY = /^(?:https?:|\/\/|data:)/i;

/**
 * What the exported page is allowed to do, which is almost nothing.
 *
 * Everything the page is made of is already in it: the stylesheet is
 * inline, a diagram is inline SVG, a formula is MathML the browser sets
 * itself, and a picture is either its own bytes in the `src` or a file in
 * the folder beside it. Nothing arrives later and nothing runs, so the
 * policy refuses everything and then names the three things that are
 * really there.
 *
 * It is here because the page outlives the app. Inside the window a
 * destination is checked before it is written, but this file can be
 * mailed on and opened in a real browser years from now, where a
 * `javascript:` href that got past that check once is a script running
 * on a click. Two lines in the head cost nothing and hold whatever the
 * renderer got wrong.
 *
 * `file:` stands beside `'self'`, because a page opened from disk has no
 * origin for `'self'` to match in some browsers and the images in the
 * folder beside it would simply go missing. `http:` and `https:` are
 * there because a document whose reader has turned remote images on
 * keeps those addresses as they were written (design 8), and an export
 * that dropped them would show holes where the window shows pictures.
 */
const POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "img-src 'self' data: file: http: https:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Attributes the window needs and a copy of the document does not. */
const NOISE = ['data-from', 'data-to', 'data-enhanced'];

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

const FAMILIES: Record<Family, string> = {
  sans: 'var(--family-sans)',
  serif: 'var(--family-serif)',
  mono: 'var(--family-mono)',
};

export interface ExportOptions {
  /** The buffer, as the file would be written. */
  source: string;
  /** The page's `<title>`, which is what a browser tab and a bookmark say. */
  title: string;
  /** Design 8's rules for this document; its own folder, and whether remote is allowed. */
  images: ImageRules;
  /** Show the annotation comments, as the reader has Read mode set (design 4.3). */
  comments: boolean;
  /** The reader's settings for this document, overrides already applied. */
  reading: Reading;
  /** Light or dark, with `system` already answered by the OS. */
  appearance: Appearance;
  /** Shiki, KaTeX and Mermaid. Without one the page is still a page. */
  enhancer?: Enhancer | undefined;
  /** Where the document is built. The window's, unless a test says otherwise. */
  document?: Document;
}

export interface ExportedPage {
  html: string;
  /**
   * Every local image the page names, in the order their numbers were
   * handed out, so the nth path answers to the nth sentinel.
   */
  images: string[];
}

function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => ESCAPE[c] as string);
}

/**
 * Design 8's rules, with the answer written down rather than loaded. The
 * resolver is handed an `assetUrl` that gives back the path itself,
 * because what an export needs is the file and not a URL the webview
 * could fetch.
 */
function exportImages(rules: ImageRules, found: string[]): ImageResolver {
  return (src) => {
    const target = resolveImage(src, { ...rules, assetUrl: (path) => path });
    if (target.url === null || READY.test(target.url)) return target;
    const at = found.indexOf(target.url);
    return { url: `${SENTINEL}${at === -1 ? found.push(target.url) - 1 : at}` };
  };
}

/**
 * A fence's language, the way Read mode writes it (design 11). The copy
 * button that sits beside it there does not come: there is no clipboard
 * behind it here, and a button that does nothing is worse than none.
 */
function labelFence(doc: Document, pre: HTMLElement): void {
  const language = pre.dataset.lang ?? '';
  if (language === '') return;
  const label = doc.createElement('span');
  label.className = 'mdr-code-lang';
  label.setAttribute('aria-hidden', 'true');
  label.textContent = language;
  pre.prepend(label);
}

/**
 * What the window wrote on the document for its own use: where every
 * element came from in the source, and which ones an enhancer has
 * already been over. Two attributes on every element is most of a
 * megabyte on a large document, and nothing outside the app reads them.
 */
function strip(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const name of NOISE) el.removeAttribute(name);
  }
}

/**
 * The rules an exported page needs and the window does not: it is the
 * whole surface rather than a pane inside one, and it has no scroller of
 * its own to give the document a place in.
 */
function frame(reading: Reading): string {
  return [
    ':root {',
    `  --read-family: ${FAMILIES[reading.family as Family]};`,
    `  --read-size: ${reading.size}px;`,
    `  --read-measure: ${reading.measure}ch;`,
    '}',
    '',
    'body {',
    '  margin: 0;',
    '  background: var(--page-bg);',
    '  color: var(--page-fg);',
    '}',
    '',
    '/*',
    ' * Read mode leaves half a screen under the last line so that the end',
    ' * of a document can be scrolled up to somewhere comfortable. A page',
    ' * that simply ends does not need it.',
    ' */',
    '.read {',
    '  padding-bottom: 64px;',
    '}',
    '',
  ].join('\n');
}

function page(body: string, options: ExportOptions): string {
  // The theme's variables, then the rules that read them, then the few
  // an exported page needs and a window does not -- last, because two of
  // them are overrides and the cascade decides that by order.
  const css = [
    pageCss(themeById(options.reading.theme), options.appearance, options.reading.paper as Paper),
    readCss,
    frame(options.reading),
  ].join('\n');
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Markdown">',
    `<title>${escapeText(options.title)}</title>`,
    `<style>\n${css}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Render `source` as a page, and say which images it wants.
 *
 * The document is built in the window rather than in a fragment because
 * Mermaid measures text to lay a diagram out. So it goes into the page
 * out of sight, and comes out again as soon as it has been read back —
 * including when something in the middle of it throws.
 */
export async function exportPage(options: ExportOptions): Promise<ExportedPage> {
  const doc = options.document ?? document;
  const images: string[] = [];
  const nodes = renderDocument(parser.parse(options.source), options.source, {
    image: exportImages(options.images, images),
    // Nothing behind a checkbox to change: this is a copy, not the document.
    interactiveTasks: false,
  });
  const article = doc.createElement('article');
  article.className = options.comments ? 'read mdr-show-comments' : 'read';
  article.append(toDom(nodes, { document: doc }).fragment);
  for (const pre of Array.from(article.querySelectorAll<HTMLElement>('pre.mdr-code[data-lang]'))) {
    labelFence(doc, pre);
  }
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:820px;visibility:hidden';
  host.append(article);
  doc.body.append(host);
  try {
    await options.enhancer?.run([article], { math: 'mathml' });
    strip(article);
    return { html: page(article.outerHTML, options), images };
  } finally {
    host.remove();
  }
}

/**
 * What an export did, as the one line the status bar has for it (build
 * plan rule 5: there are no dialogs to say it in).
 *
 * Where the images went is worth saying because the reader is about to
 * move the file: a page that carries them is one thing to send, and a
 * page that names a folder is two. What could not be carried is worth
 * saying because nothing else will ever mention it.
 */
export function describeExport(write: ExportWrite, name: string): string {
  const parts = [`Exported ${name}`];
  if (write.images > 0) {
    const carried = write.images - write.missing;
    if (write.folder === null) {
      if (carried > 0) parts.push(`${count(carried, 'image')} inside it`);
    } else {
      parts.push(`${count(carried, 'image')} in ${basename(write.folder)}`);
    }
  }
  if (write.missing > 0) parts.push(`${count(write.missing, 'image')} could not be read`);
  return parts.join(' · ');
}
