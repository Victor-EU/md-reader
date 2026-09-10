import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '../workspace.svelte.ts';
import type {
  PageSize,
  PdfDocument,
  PdfEngine,
  PdfOutlineEntry,
  RenderRequest,
  TextRun,
} from './engine.ts';
import { PdfError } from './engine.ts';

/**
 * A PDF as a tab (ADR 0035, WP 4.2 and 4.3), with a fake engine.
 *
 * The whole point of the port is that the shell cannot tell which
 * library is behind it, and the proof of that is these tests: they open
 * PDFs, restore sessions of them, search them and scroll them without
 * pdf.js being loaded at all — exactly as every test in this suite
 * already runs without an `Enhancer`.
 */

/** Two pages, some text, and one bookmark. A dozen lines, as promised. */
function fakeEngine(pages = 2): PdfEngine & { opened: string[]; alive: number } {
  const engine = {
    opened: [] as string[],
    alive: 0,
    async open(url: string): Promise<PdfDocument> {
      if (url.includes('missing')) throw new PdfError('corrupt', 'not a PDF');
      engine.opened.push(url);
      engine.alive += 1;
      return {
        pages,
        async size(page: number): Promise<PageSize> {
          // Page two is a different shape, so a test cannot pass by
          // reading page one and assuming the rest.
          return page === 2 ? { width: 400, height: 300 } : { width: 600, height: 800 };
        },
        async render(request: RenderRequest): Promise<void> {
          request.canvas.width = Math.round(600 * request.scale);
          request.canvas.height = Math.round(800 * request.scale);
        },
        async text(page: number): Promise<TextRun[]> {
          return [
            { text: `page ${page} `, rect: [10, 10, 60, 12] },
            { text: 'hello world', rect: [70, 10, 80, 12] },
          ];
        },
        async outline(): Promise<PdfOutlineEntry[]> {
          return [
            { level: 1, text: 'Front', page: 1 },
            { level: 2, text: 'Back', page: 2 },
          ];
        },
        destroy(): void {
          engine.alive -= 1;
        },
      };
    },
    destroy(): void {},
  };
  return engine;
}

/**
 * Wait for something to become true rather than for a fixed moment.
 *
 * Everything a PDF does crosses a worker, and how long that takes
 * depends on the machine and on whether the runner has pre-bundled the
 * library yet. A sleep long enough to be safe on the slowest of those is
 * a sleep the whole suite pays on every run.
 */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let ipc: FakeIpc;
let engine: ReturnType<typeof fakeEngine>;
let workspace: Workspace;
let host: HTMLDivElement;

function open(files: Record<string, string>, pages = 2) {
  ipc = createFakeIpc(files);
  engine = fakeEngine(pages);
  workspace = new Workspace({
    commands: ipc.commands,
    pdfEngine: engine,
    assetUrl: (path) => `asset://localhost/${path}`,
  });
}

beforeEach(() => {
  host = document.createElement('div');
  // The pane is the scroller, and a view with no height draws no pages.
  host.style.height = '600px';
  host.style.overflow = 'auto';
  document.body.append(host);
  open({});
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('opening a PDF', () => {
  it('opens it as its own kind of tab, with no document behind it', async () => {
    open({ '/a/paper.pdf': '%PDF-1.7 ...' });
    await workspace.openPaths(['/a/paper.pdf']);
    const tab = workspace.activeTab;
    expect(tab?.kind).toBe('pdf');
    expect(workspace.activeDoc).toBeNull();
    expect(workspace.activePdf?.label).toBe('paper.pdf');
    expect(workspace.labels).toEqual(['paper.pdf']);
    expect(workspace.status).toBe('paper.pdf · 2 pages');
  });

  it('never reads it as text', async () => {
    open({ '/a/paper.pdf': '%PDF-1.7 ...' });
    await workspace.openPaths(['/a/paper.pdf']);
    // `open_document` is what reads a file as text, and a PDF read as
    // text is mojibake with a progress bar.
    expect(ipc.calls.map((call) => call.command)).not.toContain('open_document');
  });

  it('asks for the asset scope itself, since `load` never runs', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    // Without this the protocol answers 403 and the pane stays blank.
    expect(ipc.calls.map((call) => call.command)).toContain('open_pdf');
    expect(engine.opened).toEqual(['asset://localhost//a/paper.pdf']);
  });

  it('finds the tab that is already showing it', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    const first = workspace.tabs[0]?.id;
    await workspace.openPaths(['/a/paper.pdf']);
    // A PDF tab has no `Doc` to answer "which file are you showing", so
    // an already-open check that asks the document reports every PDF as
    // not open and opens a second tab on it every time.
    expect(workspace.tabs.length).toBe(1);
    expect(workspace.activeId).toBe(first);
  });

  it('says why, when it will not open', async () => {
    open({ '/a/missing.pdf': 'not really a pdf' });
    await workspace.openPaths(['/a/missing.pdf']);
    expect(workspace.tabs.length).toBe(0);
    expect(workspace.status).toBe('missing.pdf is not a readable PDF');
  });

  it('says so when the file is not there at all', async () => {
    open({});
    await workspace.openPaths(['/a/gone.pdf']);
    expect(workspace.tabs.length).toBe(0);
    expect(workspace.status).toContain('gone.pdf');
  });

  it('opens markdown beside it without asking for the folder twice', async () => {
    open({ '/a/paper.pdf': '%PDF', '/a/notes.md': '# Notes\n' });
    await workspace.openPaths(['/a/paper.pdf', '/a/notes.md']);
    const scope = ipc.calls.filter(
      (call) => call.command === 'allow_document_images' || call.command === 'open_pdf',
    );
    // One call per folder, not one per file (design 8).
    expect(scope.length).toBe(1);
    expect(workspace.tabs.map((tab) => tab.kind)).toEqual(['pdf', 'document']);
  });
});

describe('what a PDF tab does not share', () => {
  it('leaves every command that acts on a buffer unavailable', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    expect(workspace.canSave).toBe(false);
    expect(workspace.words).toBe(0);
    expect(workspace.unsettled).toBe(0);
    expect(workspace.unreviewed).toBe(0);
    // The `activeDoc` discipline is what turns all of these off, and it
    // was already there for Settings (plan WP 1.9).
    expect(workspace.activeDoc).toBeNull();
  });

  it('offers its bookmarks where a document offers its headings', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    expect(workspace.outlineRows).toEqual([
      { level: 1, text: 'Front', target: { kind: 'page', page: 1 } },
      { level: 2, text: 'Back', target: { kind: 'page', page: 2 } },
    ]);
  });
});

describe('the session', () => {
  it('writes a PDF tab down with the page it was on', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    const tab = workspace.activeTab;
    if (tab) tab.pdf = { page: 2, fraction: 0.5, zoom: 1.5 };
    const state = workspace.sessionState();
    expect(state.documents).toEqual([{ path: '/a/paper.pdf', untitled: null }]);
    const saved = state.tabs?.[0];
    expect(saved?.kind).toBe('pdf');
    // The page, and not the fraction: landing at the top of the right
    // page is honest, and `anchor` stays a source offset.
    expect(saved?.page).toBe(2);
    expect(saved?.anchor).toBe(0);
  });

  it('puts one back without reading the file as text', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    const state = workspace.sessionState();
    const before = ipc.calls.length;
    workspace.destroy();
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.restore(state);
    expect(workspace.tabs.map((tab) => tab.kind)).toEqual(['pdf']);
    expect(workspace.activePdf?.path).toBe('/a/paper.pdf');
    // `restore` walks every entry through `restoreDoc`, which calls
    // `load`, which reads the file as text. A PDF has to be turned away
    // there as well as in `openPaths`.
    expect(ipc.calls.slice(before).map((call) => call.command)).not.toContain('open_document');
  });

  it('opens none of them until a pane asks', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    const state = workspace.sessionState();
    workspace.destroy();
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.restore(state);
    // A restored session of two hundred tabs ends with the reader in
    // one of them; the rest cost nothing until they are looked at.
    expect(engine.opened).toEqual([]);
    await workspace.mountPdf(host);
    expect(engine.opened).toEqual(['asset://localhost//a/paper.pdf']);
    expect(workspace.activePdf?.pages).toBe(2);
  });

  it('restores a document beside it, indexed by the same list', async () => {
    open({ '/a/paper.pdf': '%PDF', '/a/notes.md': '# Notes\n' });
    await workspace.openPaths(['/a/notes.md', '/a/paper.pdf']);
    const state = workspace.sessionState();
    expect(state.documents?.length).toBe(2);
    workspace.destroy();
    open({ '/a/paper.pdf': '%PDF', '/a/notes.md': '# Notes\n' });
    await workspace.restore(state);
    // `TabState.document` is an index into one list, so a PDF needs an
    // entry in it and everything after it depends on that entry being
    // in the right place.
    expect(workspace.tabs.map((tab) => tab.kind)).toEqual(['document', 'pdf']);
    expect(workspace.tabs.map((tab) => workspace.pathOf(tab))).toEqual([
      '/a/notes.md',
      '/a/paper.pdf',
    ]);
  });
});

describe('the pane', () => {
  it('draws the pages in the window and gives back the ones that leave', async () => {
    open({ '/a/paper.pdf': '%PDF' }, 40);
    await workspace.openPaths(['/a/paper.pdf']);
    await workspace.mountPdf(host);
    const view = workspace.pdfView;
    expect(view).not.toBeNull();
    await until(() => host.querySelectorAll('.pdf-page').length > 0);
    const drawn = host.querySelectorAll('.pdf-page').length;
    // A forty-page document at 800 points a page is 32,000 points of
    // scroll; a 600-pixel window holds a handful of them (plan WP 2.7).
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(20);
  });

  it('knows which page is in front, and says so', async () => {
    open({ '/a/paper.pdf': '%PDF' }, 10);
    await workspace.openPaths(['/a/paper.pdf']);
    await workspace.mountPdf(host);
    workspace.goToPdfPage(4);
    await until(() => workspace.pdfPage === 4);
    expect(workspace.pdfView?.page).toBe(4);
    expect(workspace.pdfPage).toBe(4);
  });

  it('saves the reader’s place on the tab when the pane goes', async () => {
    open({ '/a/paper.pdf': '%PDF' }, 10);
    await workspace.openPaths(['/a/paper.pdf']);
    await workspace.mountPdf(host);
    workspace.goToPdfPage(3);
    workspace.unmountPdf();
    expect(workspace.activeTab?.pdf?.page).toBe(3);
  });

  it('zooms the page rather than the reading size', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    await workspace.mountPdf(host);
    const size = workspace.applied.size;
    workspace.zoom(1);
    // Same key, same gesture; the tab in front decides what it means.
    expect(workspace.pdfView?.scale).toBeGreaterThan(1);
    expect(workspace.applied.size).toBe(size);
    // And the status bar can see it: a cell that read the view would
    // say 100% for the life of the tab, because the view is not state.
    expect(workspace.pdfZoom).toBe(workspace.pdfView?.scale);
    workspace.resetZoom();
    expect(workspace.pdfView?.scale).toBe(1);
    expect(workspace.pdfZoom).toBe(1);
  });
});

describe('find over a PDF', () => {
  it('searches the extracted text and steps through what it finds', async () => {
    open({ '/a/paper.pdf': '%PDF' }, 3);
    await workspace.openPaths(['/a/paper.pdf']);
    await workspace.mountPdf(host);
    workspace.openFind(false);
    workspace.updateFind({ query: 'hello' });
    await until(() => workspace.matches.total === 3);
    // One per page, from the fake's own runs.
    expect(workspace.pdfSearch.hits.map((hit) => hit.page)).toEqual([1, 2, 3]);
    expect(workspace.matches.total).toBe(3);
    expect(workspace.findStep(true)).toBe(true);
    expect(workspace.matches.current).toBe(1);
  });

  it('does not carry one document’s matches to the next tab', async () => {
    open({ '/a/one.pdf': '%PDF', '/a/two.pdf': '%PDF' }, 2);
    await workspace.openPaths(['/a/one.pdf', '/a/two.pdf']);
    workspace.activate(workspace.tabs[0]?.id ?? null);
    workspace.openFind(false);
    workspace.updateFind({ query: 'hello' });
    await until(() => workspace.matches.total === 2);
    workspace.activate(workspace.tabs[1]?.id ?? null);
    // Cleared and asked again of the file now in front, rather than
    // counting matches in one nobody is looking at.
    await until(() => workspace.matches.total === 2 && !workspace.pdfSearch.running);
    expect(workspace.pdfSearch.at).toBe(-1);
    expect(workspace.matches.total).toBe(2);
  });

  it('never offers replace, because a PDF is read here and never written', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    workspace.openFind(true);
    expect(workspace.find.open).toBe(true);
    expect(workspace.find.replace).toBe(false);
  });
});

describe('closing', () => {
  it('closes and reopens the same PDF rather than opening it again', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    const opened = engine.opened.length;
    workspace.close(workspace.tabs[0]?.id ?? '');
    expect(workspace.tabs.length).toBe(0);
    expect(workspace.status).toBe('Closed paper.pdf');
    workspace.reopenClosed();
    expect(workspace.activePdf?.path).toBe('/a/paper.pdf');
    expect(engine.opened.length).toBe(opened);
    expect(workspace.status).toBe('Reopened paper.pdf');
  });

  it('gives the file back when the window goes', async () => {
    open({ '/a/paper.pdf': '%PDF' });
    await workspace.openPaths(['/a/paper.pdf']);
    expect(engine.alive).toBe(1);
    workspace.destroy();
    expect(engine.alive).toBe(0);
  });
});

describe('a PDF tab moved to another window', () => {
  /**
   * Two windows are two webviews and share nothing, so a file belongs to
   * one of them at a time (design 6.5). A document travels as its buffer
   * and its undo history; a PDF has neither, so what travels is the path
   * and the page the reader was on, and the window taking it in opens
   * the file for itself.
   */
  let here: Workspace;
  let there: Workspace;

  function windows(files: Record<string, string>) {
    ipc = createFakeIpc(files);
    engine = fakeEngine(4);
    const options = { commands: ipc.commands, pdfEngine: engine, assetUrl: (p: string) => p };
    here = new Workspace(options);
    there = new Workspace({ ...options, pdfEngine: fakeEngine(4) });
  }

  function handed() {
    const move = ipc.moved.at(-1);
    if (!move) throw new Error('nothing has been moved');
    return move;
  }

  afterEach(() => {
    here?.destroy();
    there?.destroy();
  });

  it('hands over the path and the page, and no buffer at all', async () => {
    windows({ '/w/paper.pdf': '%PDF' });
    await here.openPaths(['/w/paper.pdf']);
    const tab = here.tabs[0];
    if (tab) tab.pdf = { page: 3, fraction: 0.5, zoom: 2 };
    expect(await here.moveTab(tab?.id ?? '')).toBe(true);
    const move = handed();
    expect(move.path).toBe('/w/paper.pdf');
    expect(move.page).toBe(3);
    // The fields that carry a buffer travel empty rather than carrying
    // something made up to fill them.
    expect(move.text).toBe('');
    expect(move.state).toBe('');
    expect(move.meta).toBeNull();
    expect(here.tabs).toHaveLength(0);
    expect(here.status).toContain('Moved paper.pdf');
  });

  it('gives the file back rather than holding it in two windows', async () => {
    windows({ '/w/paper.pdf': '%PDF' });
    await here.openPaths(['/w/paper.pdf']);
    expect(engine.alive).toBe(1);
    await here.moveTab(here.tabs[0]?.id ?? '');
    // The window that sent it is not the one reading it any more, and a
    // PDF held open is the whole file in memory.
    expect(engine.alive).toBe(0);
  });

  it('arrives on the page it left, without asking who has the file', async () => {
    windows({ '/w/paper.pdf': '%PDF' });
    await here.openPaths(['/w/paper.pdf']);
    const tab = here.tabs[0];
    if (tab) tab.pdf = { page: 2, fraction: 0, zoom: 1 };
    await here.moveTab(tab?.id ?? '');
    const before = ipc.calls.length;
    await there.adoptTab(handed());
    expect(there.tabs.map((open) => open.kind)).toEqual(['pdf']);
    expect(there.activePdf?.path).toBe('/w/paper.pdf');
    expect(there.activeTab?.pdf?.page).toBe(2);
    // The window that sent it has not written its session down yet, so
    // asking the registry would have the tab turned away at the door.
    expect(ipc.calls.slice(before).map((call) => call.command)).not.toContain('reveal_path');
  });

  it('keeps a pinned tab pinned', async () => {
    windows({ '/w/paper.pdf': '%PDF' });
    await here.openPaths(['/w/paper.pdf']);
    here.togglePin(here.tabs[0]?.id ?? '');
    await here.moveTab(here.tabs[0]?.id ?? '');
    await there.adoptTab(handed());
    expect(there.tabs[0]?.pinned).toBe(true);
  });

  it('leaves Settings where it is', async () => {
    windows({ '/w/paper.pdf': '%PDF' });
    const settings = here.openSettings();
    expect(await here.moveTab(settings.id)).toBe(false);
    expect(here.status).toContain('document or a PDF');
  });
});
