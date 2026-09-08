import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './html.ts';

/**
 * The rich text that actually arrives on the clipboard: a browser's
 * selection, a word processor's paste, an AI chat window's answer. Each
 * case is the HTML on one side and the dialect of design 5 on the other.
 */
const md = (html: string) => htmlToMarkdown(html);

describe('inline marks', () => {
  it('writes the six the dialect has syntax for', () => {
    expect(md('<b>bold</b>')).toBe('**bold**');
    expect(md('<strong>bold</strong>')).toBe('**bold**');
    expect(md('<i>it</i>')).toBe('*it*');
    expect(md('<em>it</em>')).toBe('*it*');
    expect(md('<del>gone</del>')).toBe('~~gone~~');
    expect(md('<mark>lit</mark>')).toBe('==lit==');
    expect(md('<code>x = 1</code>')).toBe('`x = 1`');
  });

  it('keeps the whitespace at the edges outside the marks', () => {
    expect(md('a <b>bold </b>b')).toBe('a **bold** b');
  });

  it('keeps the four whitelisted tags the dialect spells with the tag', () => {
    expect(md('H<sub>2</sub>O')).toBe('H<sub>2</sub>O');
    expect(md('x<sup>2</sup>')).toBe('x<sup>2</sup>');
    expect(md('press <kbd>Esc</kbd>')).toBe('press <kbd>Esc</kbd>');
    expect(md('<u>under</u>')).toBe('<u>under</u>');
  });

  it('unwraps anything else to the text inside it', () => {
    expect(md('<span class="x"><font color="red">plain</font></span>')).toBe('plain');
    expect(md('<video src="a.mp4">plain</video>')).toBe('plain');
  });

  it('drops what carries no text', () => {
    expect(md('<script>alert(1)</script>keep')).toBe('keep');
    expect(md('<style>p{color:red}</style>keep')).toBe('keep');
  });

  it('gives a code span enough backticks to hold what is in it', () => {
    expect(md('<code>a `b` c</code>')).toBe('``a `b` c``');
  });

  it('writes links and images', () => {
    expect(md('<a href="https://example.org/a">text</a>')).toBe('[text](https://example.org/a)');
    expect(md('<img src="a.png" alt="A cat">')).toBe('![A cat](a.png)');
  });

  it('wraps a destination with a space in angle brackets', () => {
    expect(md('<a href="a b.md">x</a>')).toBe('[x](<a b.md>)');
  });

  it('uses the destination as the text when a link has none', () => {
    expect(md('<a href="https://example.org/a"></a>')).toBe(
      '[https://example.org/a](https://example.org/a)',
    );
  });

  it('drops a javascript: destination and keeps the words', () => {
    expect(md('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });

  it('writes a line break as the hard break the dialect has', () => {
    expect(md('one<br>two')).toBe('one  \ntwo');
  });
});

describe('escaping', () => {
  it('escapes what would otherwise be markup', () => {
    expect(md('a * b')).toBe('a \\* b');
    expect(md('see [1] and `x`')).toBe('see \\[1\\] and \\`x\\`');
    expect(md('a \\ b')).toBe('a \\\\ b');
    expect(md('~~not struck~~')).toBe('\\~\\~not struck\\~\\~');
  });

  it('leaves an underscore inside a word alone and escapes one at an edge', () => {
    expect(md('snake_case_name')).toBe('snake_case_name');
    expect(md('_emphatic_')).toBe('\\_emphatic\\_');
  });

  it('leaves prose that only looks like markup alone', () => {
    expect(md('a < b and x & y')).toBe('a < b and x & y');
    // The clipboard carries these as entities, so the text really does
    // hold a tag and an ampersand rather than markup the parser ate.
    expect(md('a &lt;b&gt; tag and &amp;amp; an entity')).toBe('a \\<b> tag and \\&amp; an entity');
  });

  it('escapes a character that means something only at the start of a line', () => {
    expect(md('<p># not a heading</p>')).toBe('\\# not a heading\n');
    expect(md('<p>- not a bullet</p>')).toBe('\\- not a bullet\n');
    expect(md('<p>1. not a list</p>')).toBe('1\\. not a list\n');
    expect(md('<p>> not a quote</p>')).toBe('\\> not a quote\n');
  });

  it('leaves a hyphen inside a word alone', () => {
    expect(md('<p>well-worn</p>')).toBe('well-worn\n');
  });
});

describe('blocks', () => {
  it('writes ATX headings', () => {
    expect(md('<h1>One</h1><h3>Three</h3>')).toBe('# One\n\n### Three\n');
  });

  it('separates paragraphs with a blank line', () => {
    expect(md('<p>One</p><p>Two</p>')).toBe('One\n\nTwo\n');
  });

  it('collapses the whitespace a browser leaves between tags', () => {
    expect(md('<p>\n  One   two\n</p>')).toBe('One two\n');
  });

  it('writes a thematic break', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb\n');
  });

  it('writes a blockquote with a marker on every line', () => {
    expect(md('<blockquote><p>One</p><p>Two</p></blockquote>')).toBe('> One\n>\n> Two\n');
  });

  it('writes a fenced code block with its language', () => {
    expect(md('<pre><code class="language-rust">fn main() {}\n</code></pre>')).toBe(
      '```rust\nfn main() {}\n```\n',
    );
  });

  it('does not escape anything inside a code block', () => {
    expect(md('<pre><code>a * b [c]</code></pre>')).toBe('```\na * b [c]\n```\n');
  });

  it('gives a code block enough backticks to hold a fence inside it', () => {
    expect(md('<pre><code>```\nx\n```</code></pre>')).toBe('````\n```\nx\n```\n````\n');
  });
});

describe('lists', () => {
  it('writes bullets and numbers', () => {
    expect(md('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b\n');
    expect(md('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b\n');
  });

  it('starts an ordered list where the HTML says', () => {
    expect(md('<ol start="3"><li>a</li></ol>')).toBe('3. a\n');
  });

  it('indents a nested list under its parent item', () => {
    expect(md('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe('- a\n\n  - b\n');
  });

  it('writes a task list', () => {
    expect(
      md(
        '<ul><li><input type="checkbox" checked>done</li><li><input type="checkbox">todo</li></ul>',
      ),
    ).toBe('- [x] done\n- [ ] todo\n');
  });
});

describe('tables', () => {
  it('writes a GFM table with its header', () => {
    expect(
      md(
        '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
      ),
    ).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  });

  it('carries the alignment', () => {
    expect(md('<table><tr><th align="right">A</th></tr><tr><td>1</td></tr></table>')).toBe(
      '| A |\n| ---: |\n| 1 |\n',
    );
  });

  it('gives a table with no header row an empty one, so it is still a table', () => {
    expect(md('<table><tr><td>1</td><td>2</td></tr></table>')).toBe(
      '|  |  |\n| --- | --- |\n| 1 | 2 |\n',
    );
  });

  it('pads a ragged row so the columns line up', () => {
    expect(md('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>')).toBe(
      '| A | B |\n| --- | --- |\n| 1 |  |\n',
    );
  });

  it('escapes a pipe inside a cell', () => {
    expect(md('<table><tr><th>A</th></tr><tr><td>a|b</td></tr></table>')).toBe(
      '| A |\n| --- |\n| a\\|b |\n',
    );
  });
});

describe('what comes off a real clipboard', () => {
  it('takes a fragment with no block as one inline run', () => {
    expect(md('a <b>bold</b> word')).toBe('a **bold** word');
  });

  it('takes the wrapper a browser puts around a copied selection', () => {
    const html =
      '<meta charset="utf-8"><div><h2>Title</h2><p>Some <a href="/x">link</a>.</p></div>';
    expect(md(html)).toBe('## Title\n\nSome [link](/x).\n');
  });

  it('has nothing to say about empty HTML', () => {
    expect(md('')).toBe('');
    expect(md('<div>   </div>')).toBe('');
  });
});
