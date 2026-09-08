/**
 * HTML to markdown, for the rich text that arrives on the clipboard
 * (design 4.5).
 *
 * This is not a general converter. It writes the dialect of design 5 and
 * nothing else — ATX headings, `-` bullets, fenced code, GFM tables, the
 * six inline marks — because design 5.4 says the app only ever writes
 * what that section lists. Anything it does not recognise is unwrapped to
 * the text inside it, which is the reading a browser would give it
 * anyway, rather than passed through as HTML the parser would then have
 * to decide about.
 *
 * The three tags of the inline whitelist that markdown has no syntax for
 * — `sub`, `sup`, `kbd`, and `u` — are the exception: they are written
 * back as themselves, because that is how the dialect spells them.
 */

import { linkDestination } from '../write.ts';

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Kept as themselves: the dialect spells these with the tag (design 5.3). */
const KEPT = new Set(['sub', 'sup', 'kbd', 'u']);

/** Never contributes text, whatever it holds. */
const DROPPED = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript']);

const HEADING = /^h([1-6])$/;

function tagOf(node: Node): string {
  return node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : '';
}

function isBlock(node: Node): boolean {
  return BLOCK.has(tagOf(node));
}

// --- escaping -------------------------------------------------------------

/**
 * Escape what would otherwise be markup inside a run of text.
 *
 * `_` is escaped only at a word boundary, where CommonMark reads it as
 * emphasis; `snake_case` is left as it is, because escaping it there
 * would be noise in every identifier anybody pastes. `<` and `&` are
 * escaped only when they look like a tag or an entity, for the same
 * reason: `a < b` is prose and stays prose.
 */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/[`*[\]]/g, (c) => `\\${c}`)
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace('_', '\\_'))
    .replace(/~~/g, '\\~\\~')
    .replace(/==/g, '\\=\\=')
    .replace(/!(?=\\\[)/g, '\\!')
    .replace(/<(?=[a-zA-Z/!])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&');
}

/**
 * Escape what a character means only because it is the first thing on a
 * line: a heading, a quote, a bullet, a number, a table pipe, or a setext
 * underline. Applied once per line of a finished paragraph, which is
 * where the question can be answered.
 */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>|+])/, '$1\\$2')
    .replace(/^(\s*)([-])(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4')
    .replace(/^(\s*)(={2,}|-{2,})\s*$/, '$1\\$2');
}

function escapeLines(text: string): string {
  return text.split('\n').map(escapeLineStart).join('\n');
}

/** A code span needs more backticks than the longest run it contains. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || /^\s|\s$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// --- inline ---------------------------------------------------------------

function attr(node: Node, name: string): string {
  return node.nodeType === 1 ? ((node as Element).getAttribute(name) ?? '') : '';
}

function inlineChildren(node: Node): string {
  let out = '';
  for (const child of Array.from(node.childNodes)) out += inline(child);
  return out;
}

/**
 * Wrap `text` in `marker`, moving the whitespace at its edges outside the
 * marks: `** bold** ` is not emphasis, and a browser's selection is full
 * of edges like that.
 */
function wrap(text: string, marker: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before, body, after] = m as RegExpExecArray;
  return body === '' ? text : `${before}${marker}${body}${marker}${after}`;
}

function inline(node: Node): string {
  if (node.nodeType === 3) return escapeText((node.nodeValue ?? '').replace(/\s+/g, ' '));
  if (node.nodeType !== 1) return '';
  const tag = tagOf(node);
  if (DROPPED.has(tag)) return '';
  switch (tag) {
    case 'br':
      // Two trailing spaces: the hard break design 5 already knows about.
      return '  \n';
    case 'img': {
      const src = attr(node, 'src');
      return src === '' ? '' : `![${escapeText(attr(node, 'alt'))}](${linkDestination(src)})`;
    }
    case 'strong':
    case 'b':
      return wrap(inlineChildren(node), '**');
    case 'em':
    case 'i':
    case 'cite':
      return wrap(inlineChildren(node), '*');
    case 's':
    case 'del':
    case 'strike':
      return wrap(inlineChildren(node), '~~');
    case 'mark':
      return wrap(inlineChildren(node), '==');
    case 'code':
    case 'samp':
    case 'tt':
      return codeSpan((node.textContent ?? '').replace(/\s+/g, ' '));
    case 'a': {
      const href = attr(node, 'href');
      const text = inlineChildren(node);
      if (href === '' || href.startsWith('javascript:')) return text;
      return `[${text.trim() === '' ? escapeText(href) : text}](${linkDestination(href)})`;
    }
    default:
      if (KEPT.has(tag)) return `<${tag}>${inlineChildren(node)}</${tag}>`;
      return inlineChildren(node);
  }
}

// --- blocks ---------------------------------------------------------------

/** Collapse the runs of whitespace a paragraph of HTML is full of. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '  \n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/g, '')
    .trim();
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first + line : line === '' ? rest.trimEnd() : rest + line))
    .join('\n');
}

/** The blocks of `parent`, with runs of inline children gathered into paragraphs. */
function blocksOf(parent: Node): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    const text = escapeLines(tidy(run));
    if (text !== '') out.push(text);
    run = '';
  };
  for (const child of Array.from(parent.childNodes)) {
    if (isBlock(child)) {
      flush();
      out.push(...blockOf(child as Element));
    } else {
      run += inline(child);
    }
  }
  flush();
  return out;
}

function fencedCode(el: Element): string {
  const code = el.querySelector('code');
  const classes = `${attr(el, 'class')} ${code ? attr(code, 'class') : ''}`;
  const lang = /(?:language|lang|highlight)-([\w+#.-]+)/.exec(classes)?.[1] ?? '';
  const text = (el.textContent ?? '').replace(/\n$/, '');
  const longest = Math.max(2, ...[...text.matchAll(/^`{3,}/gm)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** The task box a list item starts with, when it starts with one. */
function taskBox(el: Element): string {
  const input = el.querySelector('input[type=checkbox]');
  if (!input || input.closest('li') !== el) return '';
  return (input as HTMLInputElement).checked || input.hasAttribute('checked') ? '[x] ' : '[ ] ';
}

function listBlock(el: Element): string {
  const ordered = tagOf(el) === 'ol';
  const start = Number.parseInt(attr(el, 'start'), 10);
  let n = Number.isFinite(start) ? start : 1;
  const items: string[] = [];
  for (const child of Array.from(el.children)) {
    if (tagOf(child) !== 'li') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const box = taskBox(child);
    const body = blocksOf(child).join('\n\n').trim();
    items.push(prefixLines(`${box}${body}`, marker, ' '.repeat(marker.length)));
  }
  return items.join('\n');
}

const ALIGN: Record<string, string> = {
  left: ':---',
  center: ':---:',
  right: '---:',
};

function cellAlign(cell: Element): string {
  const style = attr(cell, 'style').toLowerCase();
  const align = /text-align\s*:\s*(left|center|right)/.exec(style)?.[1] ?? attr(cell, 'align');
  return ALIGN[align.toLowerCase()] ?? '---';
}

function cellText(cell: Element): string {
  return tidy(inlineChildren(cell)).replace(/\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * A GFM table, which needs a header row: a table whose first row is data
 * gets an empty one, because a pipe table without a delimiter line is not
 * a table at all and would paste as a wall of pipes.
 */
function tableBlock(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll(':scope > th, :scope > td')),
  );
  const first = rows[0];
  if (first === undefined || first.length === 0) return blocksOf(el).join('\n\n');
  const width = Math.max(...rows.map((cells) => cells.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill('')];
  const headed = first.every((cell) => tagOf(cell) === 'th');
  const header = headed ? pad(first.map(cellText)) : pad([]);
  const align = pad(first.map(cellAlign)).map((a) => (a === '' ? '---' : a));
  const body = (headed ? rows.slice(1) : rows).map((cells) => pad(cells.map(cellText)));
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(align), ...body.map(line)].join('\n');
}

function blockOf(el: Element): string[] {
  const tag = tagOf(el);
  if (DROPPED.has(tag)) return [];
  const heading = HEADING.exec(tag);
  if (heading) {
    const text = tidy(inlineChildren(el)).replace(/\n/g, ' ');
    return text === '' ? [] : [`${'#'.repeat(Number(heading[1]))} ${text}`];
  }
  switch (tag) {
    case 'hr':
      return ['---'];
    case 'pre':
      return [fencedCode(el)];
    case 'ul':
    case 'ol':
      return [listBlock(el)].filter((b) => b !== '');
    case 'table':
      return [tableBlock(el)];
    case 'blockquote': {
      const inner = blocksOf(el).join('\n\n');
      return inner === '' ? [] : [prefixLines(inner, '> ', '> ')];
    }
    default:
      return blocksOf(el);
  }
}

// --- the door -------------------------------------------------------------

/**
 * Convert a fragment of HTML to markdown.
 *
 * A fragment with no block in it comes back as one inline run, with no
 * trailing newline: a few words dragged out of a page are pasted into the
 * middle of a sentence, not as a paragraph of their own.
 */
export function domToMarkdown(root: Node): string {
  const blocks = blocksOf(root);
  const only = blocks[0];
  if (only === undefined) return '';
  const inlineOnly = !Array.from(root.childNodes).some(isBlock);
  return inlineOnly ? only : `${blocks.join('\n\n')}\n`;
}

/** The same, from the string the clipboard hands over. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return domToMarkdown(doc.body);
}
