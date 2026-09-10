import { createFakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Workspace } from '../workspace.svelte.ts';
import { type PdfDocument, PdfError } from './engine.ts';
import { hitsInPage, queryRegExp } from './find.ts';
import cjkUrl from './fixtures/cjk.pdf?url';
import embeddedUrl from './fixtures/embedded.pdf?url';
import standardUrl from './fixtures/standard.pdf?url';
import { PdfJsEngine } from './pdfjs.ts';

/**
 * The adapter against real files, in both engines (ADR 0035, WP 4.1).
 *
 * This is the test the work package ends at, and it runs here rather
 * than in the node project because everything that can go wrong is a
 * browser fact: the worker has to start, the WebAssembly decoders have
 * to compile under a policy that names `'wasm-unsafe-eval'`, and the
 * character maps and standard fonts have to be reachable at the URLs
 * `pdfjs-assets.ts` copies them to. WebKit is the engine that matters,
 * because it is what ships on macOS.
 *
 * What it cannot cover is the origin a bundled app actually runs on.
 * Vite serves this over `http`, so pdf.js lets its worker fetch the
 * library data itself; under `tauri://localhost` it cannot, and the main
 * thread fetches instead. Both paths end at the same bytes, but only one
 * of them is exercised here.
 */

const engine = new PdfJsEngine();

describe('a PDF with no embedded fonts', () => {
  let doc: PdfDocument;
  beforeAll(async () => {
    doc = await engine.open(standardUrl);
  });

  it('counts its pages', () => {
    expect(doc.pages).toBe(3);
  });

  it('measures each page in points, and not all of them alike', async () => {
    // US Letter is 612 by 792 points, and the third page is A5
    // landscape, so a size read off page one cannot pass for all three.
    await expect(doc.size(1)).resolves.toEqual({ width: 612, height: 792 });
    await expect(doc.size(3)).resolves.toEqual({ width: 595, height: 420 });
  });

  it('extracts text with geometry the page agrees with', async () => {
    const runs = await doc.text(1);
    const joined = runs.map((run) => run.text).join(' ');
    expect(joined).toContain('Standard fonts');
    expect(joined).toContain('The quick brown fox');
    const title = runs.find((run) => run.text.includes('Standard fonts'));
    expect(title).toBeDefined();
    const [left, top, width, height] = title?.rect ?? [0, 0, 0, 0];
    // Written at 72, 700 from the bottom in 24pt type, so the box sits a
    // little under 92 points down a 792 point page and is 24 tall.
    expect(left).toBeCloseTo(72, 0);
    expect(top).toBeCloseTo(792 - 700 - 24, 0);
    expect(height).toBeCloseTo(24, 0);
    expect(width).toBeGreaterThan(24);
    expect(top + height).toBeLessThan(792);
  });

  it('reads the document’s own bookmarks, nesting and all', async () => {
    const outline = await doc.outline();
    expect(outline).toEqual([
      { level: 1, text: 'Standard fonts', page: 1 },
      { level: 1, text: 'Second page', page: 2 },
      { level: 2, text: 'A nested bookmark', page: 3 },
    ]);
  });

  it('draws onto a canvas the caller owns, at the scale it asked for', async () => {
    const canvas = document.createElement('canvas');
    await doc.render({ page: 1, scale: 2, canvas });
    expect(canvas.width).toBe(1224);
    expect(canvas.height).toBe(1584);
    // Something was actually drawn: the page is black on white, so a
    // strip through the title has to hold more than one shade. This is
    // also what proves the standard fonts were fetched — Symbol and
    // ZapfDingbats are the two the system is not allowed to substitute.
    const context = canvas.getContext('2d');
    const strip = context?.getImageData(0, 150, canvas.width, 120).data ?? new Uint8ClampedArray();
    const shades = new Set<number>();
    for (let i = 0; i < strip.length; i += 4) shades.add(strip[i] as number);
    expect(shades.size).toBeGreaterThan(1);
  });
});

describe('a PDF whose text is Japanese', () => {
  it('reads it back through the character maps', async () => {
    // Nothing else in the app reaches `cmaps/`. If it stopped being
    // copied into the build, this is the only test that would notice.
    const doc = await engine.open(cjkUrl);
    const runs = await doc.text(1);
    expect(runs.map((run) => run.text).join('')).toBe('こんにちは');
    doc.destroy();
  });
});

describe('a PDF that carries its own font', () => {
  it('reads and draws it', async () => {
    const doc = await engine.open(embeddedUrl);
    expect(doc.pages).toBe(1);
    const runs = await doc.text(1);
    expect(runs.map((run) => run.text).join('')).toContain('Embedded font fixture');
    const canvas = document.createElement('canvas');
    await doc.render({ page: 1, scale: 1, canvas });
    expect(canvas.width).toBeGreaterThan(0);
    doc.destroy();
  });
});

describe('when a PDF will not open', () => {
  it('says which of the ways it failed', async () => {
    await expect(engine.open('/pdf/does-not-exist.pdf')).rejects.toBeInstanceOf(PdfError);
  });
});

describe('a render that is abandoned', () => {
  it('stops rather than finishing, and does not report it', async () => {
    const doc = await engine.open(standardUrl);
    const canvas = document.createElement('canvas');
    const controller = new AbortController();
    const drawing = doc.render({ page: 1, scale: 4, canvas, signal: controller.signal });
    controller.abort();
    // A page scrolled out of the window is not an error the reader
    // should hear about, so the promise settles rather than rejecting.
    await expect(drawing).resolves.toBeUndefined();
    doc.destroy();
  });
});

describe('the search this pane actually runs', () => {
  it('finds words in a real document through the real adapter', async () => {
    // The fake engine's own runs are what `tab.browser.test.ts` searches,
    // so this is the one place the search meets a real `getTextContent`.
    const doc = await engine.open(standardUrl);
    const pattern = queryRegExp('brown');
    expect(pattern).not.toBeNull();
    const runs = await doc.text(1);
    expect(runs.length).toBeGreaterThan(0);
    expect(hitsInPage(runs, 1, pattern as RegExp).length).toBe(1);
    doc.destroy();
  });
});

describe('the whole thing, with the real engine', () => {
  /**
   * Every test in `tab.browser.test.ts` swaps pdf.js out, which is the
   * point of the port. This one puts it back, because the wiring and the
   * library have to meet somewhere and a fake that agrees with the shell
   * about everything proves only that they agree. It lives here rather
   * than beside those, so that the real library is loaded by one file.
   */
  let workspace: Workspace;
  let host: HTMLDivElement;

  /** Wait for something to be true rather than for a fixed moment. */
  async function until(check: () => boolean, ms = 20_000): Promise<void> {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  afterEach(() => {
    workspace?.destroy();
    host?.remove();
  });

  // The one test in the suite that loads the whole library into a
  // browser, and it does it while every other file is running, so it is
  // given a budget rather than the default two seconds.
  it('opens, draws, searches and steps, all through the port', { timeout: 60_000 }, async () => {
    host = document.createElement('div');
    host.style.height = '600px';
    host.style.overflow = 'auto';
    document.body.append(host);
    const ipc = createFakeIpc({ '/a/standard.pdf': '%PDF' });
    workspace = new Workspace({
      commands: ipc.commands,
      pdfEngine: engine,
      // The fixture is served by the test runner, so the "asset URL"
      // of the one path this workspace knows about is that.
      assetUrl: () => standardUrl,
    });
    await workspace.openPaths(['/a/standard.pdf']);
    expect(workspace.activePdf?.pages).toBe(3);
    await workspace.mountPdf(host);
    await until(() => host.querySelectorAll('.pdf-page').length > 0);
    await until(() => workspace.outlineRows.length === 3);
    expect(workspace.outlineRows.length).toBe(3);
    workspace.openFind(false);
    workspace.updateFind({ query: 'brown' });
    await until(() => workspace.matches.total === 1);
    expect(workspace.matches.total).toBe(1);
    expect(workspace.findStep(true)).toBe(true);
    expect(workspace.pdfPage).toBe(1);
    // The match is marked where the word is, not across the line it
    // happens to share with the rest of the sentence.
    const marks = host.querySelectorAll('.pdf-text mark');
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe('brown');
    expect(marks[0]?.className).toBe('here');
  });
});
