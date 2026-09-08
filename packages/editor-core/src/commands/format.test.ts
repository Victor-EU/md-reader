import type { StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { parsedState } from '../test-helpers.ts';
import { applyBold, applyCode, applyItalic, applyLink, isUrl } from './format.ts';

/**
 * Run a command and show the result with the cursor as `|` and a
 * selection in brackets, so each expectation reads as the line the writer
 * is looking at.
 */
function run(command: StateCommand, doc: string, at: number | { anchor: number; head: number }) {
  let state = parsedState(doc, at);
  const handled = command({
    state,
    dispatch: (tr) => {
      state = tr.state;
    },
  });
  if (!handled) return false;
  const { from, to } = state.selection.main;
  const text = state.doc.toString();
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`;
}

/** The offsets of `word` in the fixture, as a selection. */
function around(doc: string, word: string) {
  const at = doc.indexOf(word);
  return { anchor: at, head: at + word.length };
}

/** A cursor in the middle of `word`. */
function inside(doc: string, word: string) {
  return doc.indexOf(word) + 1;
}

describe('bold, italic and code', () => {
  const doc = 'One two three.\n';

  it('wraps a selection', () => {
    expect(run(applyBold, doc, around(doc, 'two'))).toBe('One **[two]** three.\n');
    expect(run(applyItalic, doc, around(doc, 'two'))).toBe('One *[two]* three.\n');
    expect(run(applyCode, doc, around(doc, 'two'))).toBe('One `[two]` three.\n');
  });

  it('wraps the word under the cursor and leaves the cursor in it', () => {
    expect(run(applyBold, doc, inside(doc, 'two'))).toBe('One **t|wo** three.\n');
    expect(run(applyItalic, doc, inside(doc, 'three'))).toBe('One two *t|hree*.\n');
  });

  it('takes the mark off text that already has it', () => {
    const bold = 'One **two** three.\n';
    expect(run(applyBold, bold, around(bold, 'two'))).toBe('One [two] three.\n');
    const italic = 'One *two* three.\n';
    expect(run(applyItalic, italic, around(italic, 'two'))).toBe('One [two] three.\n');
    const code = 'One `two` three.\n';
    expect(run(applyCode, code, around(code, 'two'))).toBe('One [two] three.\n');
  });

  it('unwraps from a cursor in the word as well as from a selection', () => {
    const bold = 'One **two** three.\n';
    expect(run(applyBold, bold, inside(bold, 'two'))).toBe('One t|wo three.\n');
  });

  // The trap: `*` sits inside `**`, so asking "are the characters either
  // side the marker" would read bold as italic and halve it.
  it('adds italic to bold rather than halving it', () => {
    const bold = 'One **two** three.\n';
    expect(run(applyItalic, bold, around(bold, 'two'))).toBe('One ***[two]*** three.\n');
  });

  it('takes italic off text that is bold and italic', () => {
    const both = 'One ***two*** three.\n';
    expect(run(applyItalic, both, around(both, 'two'))).toBe('One **[two]** three.\n');
  });

  it('takes bold off text that is bold and italic, leaving italic', () => {
    const both = 'One ***two*** three.\n';
    expect(run(applyBold, both, around(both, 'two'))).toBe('One *[two]* three.\n');
  });

  it('adds bold to italic', () => {
    const italic = 'One *two* three.\n';
    expect(run(applyBold, italic, around(italic, 'two'))).toBe('One ***[two]*** three.\n');
  });

  /**
   * Found by hand: a selection dragged past the end of a line takes the
   * line break with it, and `**` either side of a break is four
   * asterisks rather than bold.
   */
  it('leaves the whitespace at the edges of a selection outside the marks', () => {
    const doc = 'One two three.\n';
    const at = doc.indexOf('two');
    expect(run(applyBold, doc, { anchor: at - 1, head: at + 4 })).toBe('One **[two]** three.\n');
  });

  it('does nothing at all to a selection that is only a line break', () => {
    const doc = '# One\n\nTwo.\n';
    expect(run(applyBold, doc, { anchor: 5, head: 7 })).toBe(false);
  });

  it('leaves an empty pair to type into when there is no word', () => {
    expect(run(applyBold, 'One  two.\n', 4)).toBe('One **|** two.\n');
    expect(run(applyCode, '\n', 0)).toBe('`|`\n');
  });
});

describe('links', () => {
  const doc = 'One two three.\n';

  it('wraps a selection and waits in the destination', () => {
    expect(run(applyLink(), doc, around(doc, 'two'))).toBe('One [two](|) three.\n');
  });

  it('wraps the word under the cursor', () => {
    expect(run(applyLink(), doc, inside(doc, 'three'))).toBe('One two [three](|).\n');
  });

  it('makes a selected URL the destination and waits in the text', () => {
    const text = 'See https://example.org/a for more.\n';
    expect(run(applyLink(), text, around(text, 'https://example.org/a'))).toBe(
      'See [|](https://example.org/a) for more.\n',
    );
  });

  it('writes the whole link when the destination is given, as a paste does', () => {
    expect(run(applyLink('https://example.org/a'), doc, around(doc, 'two'))).toBe(
      'One [two](https://example.org/a)| three.\n',
    );
  });

  it('puts an empty link where the caret is rather than over the whitespace', () => {
    expect(run(applyLink(), 'One  two.\n', { anchor: 3, head: 5 })).toBe('One  [|]()two.\n');
  });

  it('leaves an empty link to type into when there is no word', () => {
    expect(run(applyLink(), 'One  two.\n', 4)).toBe('One [|]() two.\n');
  });
});

describe('what counts as a URL', () => {
  it('takes schemes, bare www, and paths', () => {
    for (const url of [
      'https://example.org',
      'HTTP://EXAMPLE.ORG',
      'mailto:a@b.c',
      'www.example.org',
      '/notes/a.md',
      './a.md',
      '../a.md',
    ])
      expect(isUrl(url), url).toBe(true);
  });

  it('leaves prose, fragments, and anything with a space alone', () => {
    for (const text of ['two', 'a: b', 'https://example.org and more', '#section', ''])
      expect(isUrl(text), text).toBe(false);
  });
});
