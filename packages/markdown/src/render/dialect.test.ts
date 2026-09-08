import { describe, expect, it } from 'vitest';
import { parser } from '../parser.ts';
import { toHtml } from './html.ts';
import { type ImageResolver, type RenderOptions, renderDocument } from './render.ts';

/** The rendered document, without the ranges, so a case reads as HTML. */
function render(source: string, options: RenderOptions = {}): string {
  return toHtml(renderDocument(parser.parse(source), source, options), {
    ranges: false,
    indent: false,
  });
}

describe('footnotes', () => {
  it('numbers by the order the text first refers to a label', () => {
    const html = render('a[^b] c[^a]\n\n[^a]: first defined\n\n[^b]: second defined\n');
    expect(html).toContain(
      '<sup class="mdr-fnref-sup"><a href="#fn-1" class="mdr-fnref" id="fnref-1">1</a></sup>',
    );
    expect(html).toContain(
      '<sup class="mdr-fnref-sup"><a href="#fn-2" class="mdr-fnref" id="fnref-2">2</a></sup>',
    );
    expect(html).toContain('<div class="mdr-footnote" id="fn-2" data-footnote="a">');
    expect(html).toContain('<div class="mdr-footnote" id="fn-1" data-footnote="b">');
  });

  it('gives only the first reference the id the note links back to', () => {
    const html = render('x[^n] y[^n]\n\n[^n]: note\n');
    expect(html.match(/id="fnref-1"/g)).toHaveLength(1);
    expect(html.match(/href="#fn-1"/g)).toHaveLength(2);
    expect(html).toContain(
      '<a href="#fnref-1" class="mdr-fn-back" aria-label="Back to reference">↩</a>',
    );
  });

  it('leaves a label nothing defines as the text it is', () => {
    expect(render('see[^gone] here')).toBe('<p>see[^gone] here</p>');
  });

  it('leaves a note nobody refers to without a back link', () => {
    expect(render('[^n]: alone\n')).toBe(
      '<div class="mdr-footnote" id="fn-1" data-footnote="n">' +
        '<span class="mdr-fn-number">1.</span>' +
        '<div class="mdr-fn-body"><p>alone</p></div></div>',
    );
  });

  it('renders a note that holds several blocks', () => {
    const html = render('a[^n]\n\n[^n]: one\n\n    two\n');
    expect(html).toContain('<p>one</p>');
    expect(html).toContain('<p>two <a href="#fnref-1"');
  });

  it('keeps footnote anchors out of the way of heading ids', () => {
    const html = render('# fn 1\n\ntext[^x]\n\n[^x]: note\n');
    expect(html).toContain('<h1 id="fn-1">fn 1</h1>');
    expect(html).toContain('id="fn-1-1"');
    expect(html).toContain('href="#fn-1-1"');
  });
});

describe('callouts', () => {
  it.each([
    ['> [!NOTE]\n> a', 'note', 'Note'],
    ['> [!TIP]\n> a', 'tip', 'Tip'],
    ['> [!IMPORTANT]\n> a', 'important', 'Important'],
    ['> [!CAUTION]\n> a', 'caution', 'Caution'],
    ['> [!tldr]\n> a', 'abstract', 'Abstract'],
    ['> [!hint]\n> a', 'tip', 'Tip'],
    ['> [!done]\n> a', 'success', 'Success'],
    ['> [!faq]\n> a', 'question', 'Question'],
    ['> [!attention]\n> a', 'warning', 'Warning'],
    ['> [!missing]\n> a', 'failure', 'Failure'],
    ['> [!error]\n> a', 'danger', 'Danger'],
    ['> [!cite]\n> a', 'quote', 'Quote'],
  ])('%j is a %s callout', (source, kind, title) => {
    expect(render(source)).toBe(
      `<blockquote class="mdr-callout" data-callout="${kind}">` +
        `<div class="mdr-callout-title">${title}</div><p>a</p></blockquote>`,
    );
  });

  it('styles a type nobody defined like a note, under its own name', () => {
    expect(render('> [!bananas]\n> a')).toBe(
      '<blockquote class="mdr-callout" data-callout="note" data-callout-unknown>' +
        '<div class="mdr-callout-title">Bananas</div><p>a</p></blockquote>',
    );
  });

  it('keeps a title the header carries', () => {
    expect(render('> [!note] My *title*\n> a')).toContain(
      '<div class="mdr-callout-title">My <em>title</em></div>',
    );
  });

  it('folds with details, open for + and closed for -', () => {
    expect(render('> [!tip]+ Open\n> a')).toBe(
      '<details class="mdr-callout" data-callout="tip" open>' +
        '<summary class="mdr-callout-title">Open</summary><p>a</p></details>',
    );
    expect(render('> [!tip]- Shut\n> a')).toBe(
      '<details class="mdr-callout" data-callout="tip">' +
        '<summary class="mdr-callout-title">Shut</summary><p>a</p></details>',
    );
  });

  it('leaves an ordinary blockquote alone', () => {
    expect(render('> [not a callout]\n> a')).toBe(
      '<blockquote><p>[not a callout]\n a</p></blockquote>',
    );
  });
});

describe('the inline HTML whitelist', () => {
  it.each([
    ['<mark>x</mark>', '<mark>x</mark>'],
    ['<sub>x</sub>', '<sub>x</sub>'],
    ['<sup>x</sup>', '<sup>x</sup>'],
    ['<u>x</u>', '<u>x</u>'],
    ['<s>x</s>', '<s>x</s>'],
    ['<kbd>x</kbd>', '<kbd>x</kbd>'],
    ['a<br>b', 'a<br>b'],
    ['a<br />b', 'a<br>b'],
    ['<span style="color: red">x</span>', '<span style="color:red">x</span>'],
    ['<span style="color:#ff0000">x</span>', '<span style="color:#ff0000">x</span>'],
    ['<span style="color: rgb(1, 2, 3)">x</span>', '<span style="color:rgb(1, 2, 3)">x</span>'],
  ])('renders %j', (source, expected) => {
    expect(render(source)).toBe(`<p>${expected}</p>`);
  });

  it.each([
    '<script>alert(1)</script>',
    '<iframe src="x"></iframe>',
    '<style>b{}</style>',
    '<b onclick="x()">b</b>',
    '<div>block</div>',
    '<a href="x">link</a>',
    '<span style="color:red;font-size:9px">x</span>',
    '<span style="color:url(x)">x</span>',
    '<span class="x">x</span>',
    '<mark id="x">x</mark>',
  ])('shows %j as the text it is', (source) => {
    const html = render(source);
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;');
  });

  it('nests, and gives back a tag nothing closes', () => {
    expect(render('<mark>a <sup>b</sup> c</mark>')).toBe('<p><mark>a <sup>b</sup> c</mark></p>');
    expect(render('<mark>never closed')).toBe('<p>&lt;mark&gt;never closed</p>');
    expect(render('<mark>a <sup>b</mark> c</sup>')).toBe(
      '<p><mark>a &lt;sup&gt;b</mark> c&lt;/sup&gt;</p>',
    );
    expect(render('</mark>alone')).toBe('<p>&lt;/mark&gt;alone</p>');
  });

  it('keeps markdown inside an allowed tag', () => {
    expect(render('<mark>a *b* c</mark>')).toBe('<p><mark>a <em>b</em> c</mark></p>');
  });

  it('builds a details block written without blank lines', () => {
    expect(render('<details>\n<summary>More</summary>\nBody\n</details>')).toBe(
      '<details><summary>More</summary>\nBody\n</details>',
    );
  });

  it('shows a summary with no details around it as text', () => {
    expect(render('<summary>lonely</summary>')).toContain('&lt;summary&gt;');
  });

  it('shows a block whose tags are not all allowed as the block it is', () => {
    expect(render('<div align="center">\n<b>x</b>\n</div>')).toBe(
      '<pre class="mdr-html">&lt;div align="center"&gt;\n&lt;b&gt;x&lt;/b&gt;\n&lt;/div&gt;</pre>',
    );
  });
});

describe('images', () => {
  const local: ImageResolver = (src) =>
    /^https?:/i.test(src) ? { url: null, blocked: 'remote' } : { url: `asset://${src}` };

  it('blocks every source without a resolver', () => {
    expect(render('![a](x.png)')).toBe(
      '<p><span class="mdr-image" data-src="x.png" data-blocked="unavailable">a</span></p>',
    );
    expect(render('![a](https://x.test/y.png)')).toBe(
      '<p><span class="mdr-image" data-src="https://x.test/y.png" data-blocked="remote">a</span></p>',
    );
  });

  it('loads a data URL without asking anyone', () => {
    const src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    expect(render(`![a](${src})`)).toBe(`<p><img src="${src}" alt="a"></p>`);
  });

  it('loads what the resolver allows and shows the rest as its source', () => {
    expect(render('![a](pictures/x.png "T")', { image: local })).toBe(
      '<p><img src="asset://pictures/x.png" alt="a" title="T"></p>',
    );
    expect(render('![](pictures/x.png)', { image: local })).toBe(
      '<p><img src="asset://pictures/x.png" alt></p>',
    );
    expect(render('![a](https://x.test/y.png)', { image: local })).toContain(
      'data-blocked="remote"',
    );
  });

  it('shows the source when there is no alt text to show', () => {
    expect(render('![](pictures/nameless.png)')).toContain('>pictures/nameless.png<');
  });

  it('sends an HTML image through the same rules', () => {
    expect(render('<img src="a.png" alt="x" width="10">', { image: local })).toBe(
      '<img src="asset://a.png" alt="x" width="10">',
    );
    // A remote source never even reaches the resolver.
    expect(render('<img src="https://x.test/a.png">', { image: local })).toContain('&lt;img');
  });

  it('never writes a source whose scheme is not one of the three', () => {
    const html = render('![a](javascript:alert(1))', { image: () => ({ url: 'javascript:x' }) });
    expect(html).toContain('class="mdr-image"');
    expect(html).not.toContain('<img');
  });
});

describe('bare links', () => {
  it('renders a GFM autolink, a www address, and an email', () => {
    expect(render('see https://x.test/a now')).toBe(
      '<p>see <a href="https://x.test/a" data-external>https://x.test/a</a> now</p>',
    );
    expect(render('see www.x.test now')).toBe(
      '<p>see <a href="http://www.x.test" data-external>www.x.test</a> now</p>',
    );
    expect(render('mail a.b@x.test now')).toBe(
      '<p>mail <a href="mailto:a.b@x.test" data-external>a.b@x.test</a> now</p>',
    );
  });

  it('keeps the address of a link that was never closed', () => {
    expect(render('[label](https://x.test rest')).toContain('>https://x.test</a>');
  });
});

describe('frontmatter properties', () => {
  it('shows one row per property', () => {
    expect(render('---\ntitle: A\ndraft: false\n---\n')).toBe(
      '<div class="mdr-frontmatter mdr-properties">' +
        '<div class="mdr-property"><span class="mdr-property-key">title</span>' +
        '<span class="mdr-property-value">A</span></div>' +
        '<div class="mdr-property"><span class="mdr-property-key">draft</span>' +
        '<span class="mdr-property-value">false</span></div></div>',
    );
  });

  it('joins the items of a list property', () => {
    expect(render('---\ntags:\n  - a\n  - b\n---\n')).toContain(
      '<span class="mdr-property-item">a, </span><span class="mdr-property-item">b</span>',
    );
  });

  it('falls back to the YAML when the block holds something else', () => {
    expect(render('---\nnested:\n  key: value\n---\n')).toBe(
      '<div class="mdr-frontmatter"><pre>nested:\n  key: value</pre></div>',
    );
  });
});
