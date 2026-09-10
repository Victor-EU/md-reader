import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { toHtml } from './html.ts';
import type { RenderNode } from './nodes.ts';
import { renderDocument } from './render.ts';

/** The rendered document, without the ranges, so a case reads as HTML. */
function render(source: string): string {
  return toHtml(renderDocument(parser.parse(source), source), { ranges: false, indent: false });
}

/** The rendered document with its ranges, for the cases that are about them. */
function withRanges(source: string): string {
  return toHtml(renderDocument(parser.parse(source), source), { indent: false });
}

describe('blocks', () => {
  it.each([
    ['# One', '<h1 id="one">One</h1>'],
    ['### Three ###', '<h3 id="three">Three</h3>'],
    ['Title\n=====', '<h1 id="title">Title</h1>'],
    ['Sub\n---', '<h2 id="sub">Sub</h2>'],
    ['a\n\nb', '<p>a</p><p>b</p>'],
    ['***', '<hr>'],
    ['> quoted', '<blockquote><p>quoted</p></blockquote>'],
  ])('%j', (source, expected) => {
    expect(render(source)).toBe(expected);
  });

  it('numbers repeated headings the way GitHub does', () => {
    expect(render('# Notes\n\n# Notes\n\n# Notes')).toBe(
      '<h1 id="notes">Notes</h1><h1 id="notes-1">Notes</h1><h1 id="notes-2">Notes</h1>',
    );
  });

  it('drops the paragraph wrapper in a tight list and keeps it in a loose one', () => {
    expect(render('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(render('- one\n\n- two')).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>');
  });

  it('keeps the start of an ordered list', () => {
    expect(render('5. five\n6. six')).toBe('<ol start="5"><li>five</li><li>six</li></ol>');
    expect(render('1. one')).toBe('<ol><li>one</li></ol>');
  });

  it('renders tasks as disabled checkboxes', () => {
    expect(render('- [ ] todo\n- [x] done')).toBe(
      '<ul><li class="mdr-task"><input type="checkbox" disabled>todo</li>' +
        '<li class="mdr-task"><input type="checkbox" disabled checked>done</li></ul>',
    );
  });

  it('gives a table its alignments and its own scroll container', () => {
    expect(render('| a | b |\n|:--|--:|\n| 1 | 2 |')).toBe(
      '<div class="mdr-table-wrap"><table>' +
        '<thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead>' +
        '<tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr></tbody>' +
        '</table></div>',
    );
  });

  it('labels a fence with its language and marks the code verbatim', () => {
    expect(render('```js\nrun();\n```')).toBe(
      '<pre class="mdr-code" data-lang="js"><code class="language-js" data-verbatim>run();</code></pre>',
    );
  });

  it('joins the lines of a fence inside a blockquote', () => {
    expect(render('> ```\n> one\n> two\n> ```')).toBe(
      '<blockquote><pre class="mdr-code"><code>one\ntwo</code></pre></blockquote>',
    );
  });

  it('renders an indented code block without its indent', () => {
    expect(render('    one\n    two')).toBe('<pre class="mdr-code"><code>one\ntwo</code></pre>');
  });

  it('leaves a mermaid fence for the diagram renderer', () => {
    expect(render('```mermaid\ngraph TD;\n```')).toBe(
      '<div class="mdr-mermaid" data-lang="mermaid">graph TD;</div>',
    );
  });

  it('renders a callout with its type and title', () => {
    expect(render('> [!warning] Careful\n> body')).toBe(
      '<blockquote class="mdr-callout" data-callout="warning">' +
        '<div class="mdr-callout-title">Careful</div><p>body</p></blockquote>',
    );
  });

  it('names an untitled callout after its type', () => {
    expect(render('> [!tip]\n> body')).toBe(
      '<blockquote class="mdr-callout" data-callout="tip">' +
        '<div class="mdr-callout-title">Tip</div><p>body</p></blockquote>',
    );
  });

  it('shows frontmatter as a properties panel', () => {
    expect(render('---\ntitle: x\n---\n\nbody')).toBe(
      '<div class="mdr-frontmatter mdr-properties"><div class="mdr-property">' +
        '<span class="mdr-property-key">title</span>' +
        '<span class="mdr-property-value">x</span></div></div><p>body</p>',
    );
  });

  it('folds a comment away as the note it is, and keeps the text after one', () => {
    const note =
      '<span class="mdr-comment" data-kind="note" hidden>' +
      '<span class="mdr-comment-kind">note</span>' +
      '<span class="mdr-comment-text">hi</span></span>';
    expect(render('<!-- note: hi -->')).toBe(note);
    expect(render('<!-- note: hi --> and text')).toBe(
      `<div class="mdr-comment-block">${note}<p> and text</p></div>`,
    );
  });

  it('leaves a comment outside the vocabulary as its own source', () => {
    expect(render('<!-- todo: hi -->')).toBe(
      '<span class="mdr-comment" hidden>&lt;!-- todo: hi --&gt;</span>',
    );
  });

  it('keeps a comment out of the heading id it sits in', () => {
    expect(render('# Title <!-- question: why -->')).toContain('<h1 id="title"');
  });

  it('shows an HTML block as the literal text it is, until the whitelist of WP 1.5', () => {
    expect(render('<div onclick="x()">hi</div>')).toBe(
      '<pre class="mdr-html">&lt;div onclick="x()"&gt;hi&lt;/div&gt;</pre>',
    );
  });
});

describe('inline', () => {
  it.each([
    ['*em*', '<p><em>em</em></p>'],
    ['**strong**', '<p><strong>strong</strong></p>'],
    ['`code`', '<p><code>code</code></p>'],
    ['==mark==', '<p><mark>mark</mark></p>'],
    ['~~gone~~', '<p><s>gone</s></p>'],
    ['a\\*b', '<p>a*b</p>'],
    // The decoded `&` is escaped again on the way out, as it must be.
    ['&amp; &#65; &copy;', '<p>&amp; A ©</p>'],
    ['&unknown;', '<p>&amp;unknown;</p>'],
    ['line  \nbreak', '<p>line<br>break</p>'],
    ['$x^2$', '<p><span class="mdr-math" data-tex="x^2">x^2</span></p>'],
  ])('%j', (source, expected) => {
    expect(render(source)).toBe(expected);
  });

  it('renders a number that is not a character as the replacement character', () => {
    // The grammar takes any run of digits, and `String.fromCodePoint`
    // throws on most of them. A throw here would be the whole render.
    expect(render('a &#99999999; b')).toBe('<p>a \ufffd b</p>');
    expect(render('&#0; &#xD800;')).toBe('<p>\ufffd \ufffd</p>');
  });

  it('renders block math with its source as the placeholder', () => {
    expect(render('$$\na = b\n$$')).toBe(
      '<div class="mdr-math-block" data-tex="a = b">a = b</div>',
    );
  });

  it('renders inline HTML as literal text, until the whitelist of WP 1.5', () => {
    expect(render('a <b>c</b> d')).toBe('<p>a &lt;b&gt;c&lt;/b&gt; d</p>');
  });
});

describe('links', () => {
  it.each([
    ['[a](http://x.test)', '<p><a href="http://x.test" data-external>a</a></p>'],
    ['[a](http://x.test "t")', '<p><a href="http://x.test" title="t" data-external>a</a></p>'],
    ['<http://x.test>', '<p><a href="http://x.test" data-external>http://x.test</a></p>'],
    ['<a@b.test>', '<p><a href="mailto:a@b.test" data-external>a@b.test</a></p>'],
    ['[a](#section)', '<p><a href="#section">a</a></p>'],
    ['[a](./other.md)', '<p><a href="./other.md">a</a></p>'],
    ['[not a link]', '<p>[not a link]</p>'],
    ['[a](javascript:alert(1))', '<p>a</p>'],
  ])('%j', (source, expected) => {
    expect(render(source)).toBe(expected);
  });

  it('refuses a destination that hides its scheme behind a control character', () => {
    // The tab is gone by the time a browser reads this, so what the
    // destination says here and what it means there are two different
    // strings; the one that matters is `javascript:`.
    expect(render('[x]: <java\tscript:alert(1)>\n\n[x]')).toBe('<p>x</p>');
    expect(render('[a](javascript:alert(1))')).toBe('<p>a</p>');
  });

  it('takes the angle brackets off a destination, as a definition already does', () => {
    expect(render('[x](<a b.md>)')).toBe('<p><a href="a b.md">x</a></p>');
    expect(render('[x](<http://e.test/a>)')).toBe(
      '<p><a href="http://e.test/a" data-external>x</a></p>',
    );
    expect(render('![alt](<a b.png>)')).toBe(
      '<p><span class="mdr-image" data-src="a b.png" data-blocked="unavailable">alt</span></p>',
    );
  });

  it('leaves a destination that names a host to the browser', () => {
    // Neither of these is relative to this document, and following one
    // as if it were asks a machine on the network for a file.
    expect(render('[a](//host.test/x)')).toBe('<p><a href="//host.test/x" data-external>a</a></p>');
    expect(render('[a](\\\\host\\share)')).toContain('data-external');
  });

  it('resolves a reference defined anywhere in the document', () => {
    expect(render('[ref][r] and [r]\n\n[r]: http://x.test')).toBe(
      '<p><a href="http://x.test" data-external>ref</a> and ' +
        '<a href="http://x.test" data-external>r</a></p>',
    );
  });

  it('ignores a definition that only exists inside a fence', () => {
    expect(render('```\n[r]: http://x.test\n```\n\n[r]')).toContain('<p>[r]</p>');
  });

  it('blocks a remote image and stands in for one it cannot resolve', () => {
    expect(render('![alt](https://x.test/a.png)')).toBe(
      '<p><span class="mdr-image" data-src="https://x.test/a.png" data-blocked="remote">alt</span></p>',
    );
    expect(render('![alt](pictures/a.png)')).toBe(
      '<p><span class="mdr-image" data-src="pictures/a.png" data-blocked="unavailable">alt</span></p>',
    );
  });
});

describe('source ranges', () => {
  it('gives every element the range it came from', () => {
    expect(withRanges('# Hi')).toBe('<h1 id="hi" data-from="0" data-to="4">Hi</h1>');
  });

  it('points inside the marks, not at them', () => {
    const source = 'a **bold** b';
    const html = withRanges(source);
    expect(html).toContain('<strong data-from="2" data-to="10">bold</strong>');
    expect(source.slice(2, 10)).toBe('**bold**');
  });

  it('keeps every range inside the document and inside its parent', () => {
    const source =
      '# H\n\n> [!note] T\n> a *b* [c](http://d.test)\n\n- [ ] task\n\n| a |\n|---|\n| 1 |\n';
    const nodes = renderDocument(parser.parse(source), source);
    const check = (list: readonly RenderNode[], from: number, to: number): void => {
      for (const node of list) {
        expect(node.from).toBeGreaterThanOrEqual(from);
        expect(node.to).toBeLessThanOrEqual(to);
        expect(node.to).toBeGreaterThanOrEqual(node.from);
        if (node.kind === 'element') check(node.children, node.from, node.to);
        else if (node.verbatim) expect(node.text).toBe(source.slice(node.from, node.to));
      }
    };
    check(nodes, 0, source.length);
  });
});

describe('html adapter', () => {
  it('escapes text and attributes', () => {
    expect(render('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
    expect(render('[x](http://a.test/?a=1&b="2")')).toContain('href="http://a.test/?a=1&amp;b=');
  });

  it('indents containers and leaves inline content alone', () => {
    const html = toHtml(renderDocument(parser.parse('- a\n- b'), '- a\n- b'), { ranges: false });
    expect(html).toBe('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>');
  });
});
