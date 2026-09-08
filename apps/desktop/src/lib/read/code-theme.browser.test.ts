import { EditorView } from '@codemirror/view';
import { createEditorState } from '@mdreader/editor-core';
import { parser, renderDocument, toDom } from '@mdreader/markdown';
import { codeTokens, paletteFor, themeOne } from '@mdreader/theme';
import { afterEach, describe, expect, it } from 'vitest';
// The palette reaches both engines through the stylesheet.
import '../../app.css';

/**
 * The same fence, rendered both ways, with the colours compared
 * character by character (plan WP 1.9).
 *
 * Read mode highlights with Shiki against TextMate grammars; Source mode
 * highlights with CodeMirror against Lezer ones. Two different parsers
 * will not agree about every character — but they are handed one
 * palette, out of one JSON file, and where they do recognise the same
 * thing they have to reach for the same colour. The golden is the whole
 * comparison, so a change to the theme is reviewed as a diff.
 */

const CODE = [
  '// a line comment',
  'const answer: number = 42;',
  'function greet(name: string) {',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: it is the sample
  '  return `hello ${name}`;',
  '}',
].join('\n');

const SOURCE = `\`\`\`ts\n${CODE}\n\`\`\`\n`;

interface Line {
  text: string;
  /** One colour per character of `text`. */
  colors: string[];
}

let host: HTMLElement | null = null;
let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  host?.remove();
  host = null;
});

function frame(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'width: 700px;';
  document.body.appendChild(el);
  return el;
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Let the engine style what was just inserted. WebKit will answer
 * `getComputedStyle` on a fresh subtree with what the custom properties
 * said a moment ago, which reads as a token wearing its neighbour's
 * colour; a couple of frames is enough for it to catch up.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  }
}

/** The text under `root` with the colour each character is painted. */
function painted(root: HTMLElement): { text: string; colors: string[] } {
  let text = '';
  const colors: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const data = (node as Text).data;
    const parent = node.parentElement;
    const color = parent === null ? '' : getComputedStyle(parent).color;
    text += data;
    for (let i = 0; i < data.length; i++) colors.push(color);
  }
  return { text, colors };
}

function split(whole: { text: string; colors: string[] }): Line[] {
  const lines: Line[] = [];
  let at = 0;
  for (const text of whole.text.split('\n')) {
    lines.push({ text, colors: whole.colors.slice(at, at + text.length) });
    at += text.length + 1;
  }
  return lines;
}

/** Read mode: the renderer's DOM with Shiki over it. */
async function readLines(): Promise<Line[]> {
  host = frame();
  host.className = 'read';
  const { createEnhancer } = await import('./enhance.ts');
  const enhancer = createEnhancer();
  host.appendChild(toDom(renderDocument(parser.parse(SOURCE), SOURCE)).fragment);
  const code = host.querySelector('pre.mdr-code code') as HTMLElement;
  enhancer.run([host]);
  await until(() => code.querySelector('span') !== null);
  await settle();
  const lines = split(painted(code));
  enhancer.destroy();
  return lines;
}

/** Source mode: the same buffer under the CodeMirror highlighter. */
async function sourceLines(): Promise<Line[]> {
  host = frame();
  // In the app the editor is inside the page, which is what gives the
  // characters no rule colours their colour.
  host.className = 'page source';
  view = new EditorView({ state: createEditorState(SOURCE, { mode: 'source' }), parent: host });
  const content = view.contentDOM;
  // The fence's language is loaded lazily and the markdown around it is
  // highlighted straight away, so waiting for spans is not enough: wait
  // for a colour only the nested grammar can produce.
  const keyword = paletteFor(themeOne, 'light').code.keyword;
  await until(() =>
    Array.from(content.querySelectorAll<HTMLElement>('.cm-line span')).some(
      (el) => hex(getComputedStyle(el).color) === keyword,
    ),
  );
  await settle();
  return Array.from(content.querySelectorAll<HTMLElement>('.cm-line')).map((line) => {
    const { text, colors } = painted(line);
    // CodeMirror puts a zero-width space in an otherwise empty line.
    return { text: text.replace(/​/g, ''), colors };
  });
}

/** The comparison, as a page a human can read. */
function report(read: Line[], source: Line[]): string {
  const rows: string[] = [];
  for (const [i, expected] of CODE.split('\n').entries()) {
    const left = read[i];
    // The fence's own first line is the ``` that opens it.
    const right = source[i + 1];
    rows.push(expected);
    rows.push(`  read   ${strip(left, expected)}`);
    rows.push(`  source ${strip(right, expected)}`);
  }
  return `${rows.join('\n')}\n`;
}

/**
 * One line's colours as a run-length string: `5×#97428f`. Per character
 * is what is compared; per run is what is readable.
 */
function strip(line: Line | undefined, expected: string): string {
  if (!line || line.text !== expected) return `MISSING (${line?.text ?? 'no line'})`;
  const runs: string[] = [];
  for (const color of line.colors) {
    const name = hex(color);
    const last = runs.at(-1);
    if (last?.endsWith(name)) runs[runs.length - 1] = `${Number(last.split('×')[0]) + 1}×${name}`;
    else runs.push(`1×${name}`);
  }
  return runs.join(' ');
}

/** `rgb(151, 66, 143)` as the `#97428f` the theme file writes. */
function hex(color: string): string {
  const parts = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!parts) return color;
  return `#${parts
    .slice(1, 4)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')}`;
}

describe('theme one in both modes', () => {
  it('paints the same fence from one palette', async () => {
    const read = await readLines();
    const source = await sourceLines();
    const lines = CODE.split('\n');

    // The invariant. Whitespace joins whichever token the grammar felt
    // like, and the two grammars do not always feel the same way — but
    // a space has no colour, so what has to match is every character
    // that can be seen.
    for (const [row, text] of lines.entries()) {
      const left = read[row];
      const right = source[row + 1];
      expect(left?.text, `read line ${row}`).toBe(text);
      expect(right?.text, `source line ${row}`).toBe(text);
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i] as string)) continue;
        expect(
          hex(right?.colors[i] ?? ''),
          `${text}\n${' '.repeat(i)}^ character ${i}\n${report(read, source)}`,
        ).toBe(hex(left?.colors[i] ?? ''));
      }
    }

    // And the colours are theme one's, not a highlighter's own: this is
    // what would catch Shiki quietly falling back to a bundled theme.
    const palette = paletteFor(themeOne, 'light');
    const known = new Set(codeTokens.map((token) => palette.code[token]));
    for (const [row, text] of lines.entries()) {
      for (const line of [read[row], source[row + 1]]) {
        for (const [i, color] of (line?.colors ?? []).entries()) {
          if (/\s/.test(text[i] as string)) continue;
          expect(known.has(hex(color)), `${hex(color)} is not in theme one`).toBe(true);
        }
      }
    }

    await expect(report(read, source)).toMatchFileSnapshot('./__goldens__/code-theme.txt');
  });
});
