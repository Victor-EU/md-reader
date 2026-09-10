import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsedEditor } from '../../test-helpers.ts';
import type { Editor } from '../../view.ts';
import type { PreviewOptions } from './options.ts';

const doc = [
  '---',
  'title: A doc',
  'tags:',
  '  - one',
  '  - two',
  'draft: false',
  '---',
  '',
  'Intro.',
  '',
  '$$',
  'e = mc^2',
  '$$',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '![a picture](pictures/x.png)',
  '',
  'An ![inline](y.png) image stays inline.',
  '',
].join('\n');

const enhanced: HTMLElement[] = [];
const preview: PreviewOptions = {
  enhance: {
    run(roots) {
      for (const root of roots) enhanced.push(root);
    },
  },
  image: (src) => (src.startsWith('pictures/') ? { url: `asset://${src}` } : { url: null }),
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('block widgets', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  beforeEach(() => {
    enhanced.length = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = parsedEditor(host, doc, { preview });
    editor.view.dispatch({ selection: { anchor: doc.indexOf('Intro.') } });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  const find = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector);

  it('renders math, a diagram and a lone image as widgets', () => {
    // The line decoration for a revealed math block shares the class, so
    // the widget is the one carrying the formula.
    expect(find('.mdr-math-block[data-tex]')?.dataset.tex).toBe('e = mc^2');
    expect(find('.mdr-mermaid')?.textContent).toBe('graph TD; A-->B;');
    expect(find<HTMLImageElement>('img.mdr-image-widget')?.src).toBe('asset://pictures/x.png');
    expect(find<HTMLImageElement>('img.mdr-image-widget')?.alt).toBe('a picture');
  });

  it('hands math and diagrams to the same enhancer Read mode uses', () => {
    const classes = enhanced.map((el) => el.className);
    expect(classes).toContain('mdr-math-block');
    expect(classes).toContain('mdr-mermaid');
  });

  it('leaves an image inside a sentence to the inline decorations', () => {
    expect(host.querySelectorAll('img.mdr-image-widget')).toHaveLength(1);
    expect(host.textContent).toContain('An inline image stays inline.');
  });

  it('shows a blocked image as its alt text and says why', () => {
    const text = 'Above.\n\n![x](remote.png)\n';
    const one = parsedEditor(document.createElement('div'), text, {
      preview: { image: () => ({ url: null, blocked: 'remote' }) },
    });
    one.view.dispatch({ selection: { anchor: 0 } });
    const span = one.view.dom.querySelector<HTMLElement>('span.mdr-image[data-blocked]');
    expect(span?.dataset.blocked).toBe('remote');
    expect(span?.textContent).toBe('x');
    one.destroy();
  });

  it('gives the source back when the cursor touches a widget', () => {
    editor.view.dispatch({ selection: { anchor: doc.indexOf('e = mc^2') } });
    expect(find('.mdr-math-block[data-tex]')).toBeNull();
    expect(host.textContent).toContain('e = mc^2');
    editor.view.dispatch({ selection: { anchor: doc.indexOf('Intro.') } });
    expect(find('.mdr-math-block[data-tex]')).not.toBeNull();
  });

  it('gives the source back when the cursor touches a lone image', () => {
    editor.view.dispatch({ selection: { anchor: doc.indexOf('![a picture]') + 3 } });
    expect(find('img.mdr-image-widget')).toBeNull();
    expect(host.textContent).toContain('![a picture](pictures/x.png)');
  });

  it('leaves an unclosed math block as source', () => {
    const one = parsedEditor(document.createElement('div'), '$$\nx = 1\n');
    expect(one.view.dom.querySelector('.mdr-math-block[data-tex]')).toBeNull();
    one.destroy();
  });
});

describe('the frontmatter properties panel', () => {
  let host: HTMLDivElement;
  let editor: Editor;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    editor = parsedEditor(host, doc, { preview });
    editor.view.dispatch({ selection: { anchor: doc.indexOf('Intro.') } });
  });

  afterEach(() => {
    editor.destroy();
    host.remove();
  });

  const inputs = (selector: string) =>
    Array.from(host.querySelectorAll<HTMLInputElement>(selector));

  function change(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('shows one row per property, with a list read only', () => {
    expect(inputs('.mdr-property-key').map((i) => i.value)).toEqual(['title', 'tags', 'draft']);
    expect(inputs('input.mdr-property-value').map((i) => i.value)).toEqual(['A doc', 'false']);
    expect(host.querySelector('.mdr-property-list')?.textContent).toBe('one, two');
  });

  it('replaces exactly the line of the property it edits', () => {
    const value = inputs('input.mdr-property-value')[0];
    expect(value).toBeDefined();
    if (value) change(value, 'Another doc');
    expect(editor.getDoc()).toBe(doc.replace('title: A doc', 'title: Another doc'));
  });

  it('renames a key without touching its value or its neighbours', () => {
    const key = inputs('.mdr-property-key')[2];
    expect(key).toBeDefined();
    if (key) change(key, 'published');
    expect(editor.getDoc()).toBe(doc.replace('draft: false', 'published: false'));
  });

  it('appends a new property before the closing mark', async () => {
    host.querySelector<HTMLButtonElement>('.mdr-property-add')?.click();
    await tick();
    expect(editor.getDoc()).toBe(doc.replace('draft: false\n---', 'draft: false\nproperty:\n---'));
    expect(inputs('.mdr-property-key').map((i) => i.value)).toContain('property');
  });

  it('falls back to the YAML when the block holds something the panel cannot show', () => {
    const one = parsedEditor(document.createElement('div'), '---\na:\n  b: c\n---\n\nx\n');
    one.view.dispatch({ selection: { anchor: one.getDoc().indexOf('x') } });
    expect(one.view.dom.querySelector('.mdr-properties')).toBeNull();
    expect(one.view.dom.textContent).toContain('b: c');
    one.destroy();
  });
});

/**
 * Where a block widget's own box ends is the only thing the editor knows
 * about its height: it measures the element it was handed. A vertical
 * margin is outside that box, so every margin on a widget moves the text
 * below it down by an amount the editor does not know about, and the
 * error adds up down the document until a click lands on the wrong line.
 * The spacing around these four is padding for that reason (Phase 3
 * gate). This asserts the consequence rather than the rule: a click on a
 * line below all of them lands on that line.
 */
describe('block widgets and the lines below them', () => {
  const text = [
    '---',
    'title: A doc',
    '---',
    '',
    '| Task | Owner |',
    '|---|---|',
    '| Write | Sam |',
    '| Ship | Lee |',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
    '![a picture](pictures/x.png)',
    '',
    'The order matters more than the dates do.',
    'Nothing after the review can start until the brief is agreed.',
    'And the build is the only step with any slack in it.',
    '',
  ].join('\n');

  it('puts a click on the line under the pointer', () => {
    const host = document.createElement('div');
    host.style.cssText = 'height: 700px; width: 800px; overflow: hidden;';
    document.body.appendChild(host);
    const one = parsedEditor(host, text, { preview });
    one.view.dispatch({ selection: { anchor: 0 } });

    const line = (n: number) => one.view.state.doc.lineAt(n).number;
    for (const word of ['order', 'review', 'slack']) {
      const at = text.indexOf(word) + 1;
      const box = one.view.coordsAtPos(at);
      expect(box, word).not.toBeNull();
      if (box === null) continue;
      const got = one.view.posAtCoords({ x: box.left + 1, y: (box.top + box.bottom) / 2 });
      expect(got, word).not.toBeNull();
      expect(line(got ?? 0), `a click on "${word}"`).toBe(line(at));
    }
    one.destroy();
    host.remove();
  });
});
