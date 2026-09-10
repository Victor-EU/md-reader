import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  InvalidPDFException,
  PasswordException,
  PDFWorker,
  Util,
} from 'pdfjs-dist';
import {
  type PageSize,
  type PdfDocument,
  type PdfEngine,
  PdfError,
  type PdfOutlineEntry,
  type RenderRequest,
  type TextRun,
} from './engine.ts';

/**
 * pdf.js behind the engine port (ADR 0035).
 *
 * This is the only module in the repository allowed to name
 * `pdfjs-dist`, and `pdf/single-import.test.ts` holds it to that. The
 * rule is easy to break by accident — a type import for convenience, a
 * constant borrowed from the library — and each break costs nothing
 * until the day the engine is swapped, when it costs everything.
 *
 * The specifier is the package's own, and `vite.config.ts` resolves it
 * to `pdfjs-dist/legacy/build/`. That is not a detail: the modern build
 * calls `Map.prototype.getOrInsertComputed`, which the WKWebView macOS
 * ships does not have, and every page render fails at the first font
 * with a message about a private field. Playwright's WebKit does have
 * it, so this passes every test in this repository and fails on a real
 * Mac — which is what the alias, and the by-hand check that found it,
 * are for.
 *
 * Nothing here reaches into `pdfjs-dist/web/`. That is the bundled
 * viewer, and it is where a PDF's own JavaScript would come back in:
 * scripting runs in `pdf.sandbox.mjs`, which only the viewer loads, so
 * building the pane on the core API is what makes `quickjs-eval.wasm`
 * something this app never ships. The same test asserts the narrower
 * rule.
 */

/**
 * Where the self-hosted library data is served from.
 *
 * All four are copied out of `node_modules` into `public/pdfjs/` at
 * build time by `pdfjs-assets.ts`, rather than committed: it is four
 * megabytes, and it belongs to the version in the lockfile. Every one
 * needs its trailing slash — pdf.js throws without it.
 */
const BASE = '/pdfjs/';
const CMAP_URL = `${BASE}cmaps/`;
const FONT_URL = `${BASE}standard_fonts/`;
const ICC_URL = `${BASE}iccs/`;
const WASM_URL = `${BASE}wasm/`;
const WORKER_URL = `${BASE}pdf.worker.min.mjs`;

/**
 * How much of a page is drawn at once, in device pixels.
 *
 * A canvas larger than this is refused outright by the browser and
 * renders blank, which is worse than rendering slightly soft. Safari's
 * limit is the low one, so the cap is Safari's.
 */
const MAX_CANVAS_PIXELS = 16_777_216;

/**
 * Turn a page's text run into a rectangle in points from its top-left.
 *
 * `item.transform` is the text matrix in PDF user space, whose origin is
 * the bottom-left corner. The page's own viewport transform at scale 1
 * is what flips it — and it is also what applies the page's `/Rotate`,
 * so a rotated page's runs land where its rendered pixels do.
 *
 * The top of the box is a baseline less the em height rather than less
 * the ascent, because the ascent needs per-font metrics that only the
 * bundled text layer keeps. It is a point or two tall for most fonts,
 * which a selection highlight can carry and a search hit does not
 * notice.
 */
function runRect(
  transform: number[],
  itemTransform: number[],
  width: number,
  height: number,
): readonly [number, number, number, number] {
  const tx = Util.transform(transform, itemTransform) as number[];
  const em = Math.hypot(tx[2] ?? 0, tx[3] ?? 0);
  const angle = Math.atan2(tx[1] ?? 0, tx[0] ?? 0);
  const left = (tx[4] ?? 0) + (angle === 0 ? 0 : em * Math.sin(angle));
  const top = (tx[5] ?? 0) - (angle === 0 ? em : em * Math.cos(angle));
  // A vertical run measures its extent down the page rather than across.
  return [left, top, width || em, height || em];
}

/** What a `dest` on an outline entry points at, as a page number. */
async function pageOfDest(doc: PDFDocumentProxy, dest: unknown): Promise<number> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : null;
    if (ref === null || typeof ref !== 'object') return 1;
    return (await doc.getPageIndex(ref as never)) + 1;
  } catch {
    // A bookmark that points nowhere we can resolve is still a bookmark.
    return 1;
  }
}

interface RawOutline {
  title: string;
  dest: unknown;
  items: RawOutline[];
}

async function flattenOutline(
  doc: PDFDocumentProxy,
  items: readonly RawOutline[],
  level: number,
  into: PdfOutlineEntry[],
): Promise<void> {
  for (const item of items) {
    into.push({ level, text: item.title, page: await pageOfDest(doc, item.dest) });
    if (item.items?.length) await flattenOutline(doc, item.items, level + 1, into);
  }
}

class PdfJsDocument implements PdfDocument {
  readonly pages: number;
  /**
   * Pages already asked for, so that scrolling back over one is not a
   * second round trip to the worker. pdf.js caches these itself, but
   * only for as long as nothing calls `cleanup`.
   */
  private readonly cache = new Map<number, Promise<PDFPageProxy>>();
  private destroyed = false;

  constructor(private readonly doc: PDFDocumentProxy) {
    this.pages = doc.numPages;
  }

  private page(page: number): Promise<PDFPageProxy> {
    const held = this.cache.get(page);
    if (held) return held;
    const asked = this.doc.getPage(page);
    this.cache.set(page, asked);
    return asked;
  }

  async size(page: number): Promise<PageSize> {
    const viewport = (await this.page(page)).getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  async render({ page, scale, canvas, signal }: RenderRequest): Promise<void> {
    const proxy = await this.page(page);
    if (signal?.aborted || this.destroyed) return;
    const viewport = proxy.getViewport({ scale });
    const area = viewport.width * viewport.height;
    const fit = area > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / area) : 1;
    const drawn = fit === 1 ? viewport : proxy.getViewport({ scale: scale * fit });
    canvas.width = Math.max(1, Math.floor(drawn.width));
    canvas.height = Math.max(1, Math.floor(drawn.height));
    const context = canvas.getContext('2d');
    if (!context) throw new PdfError('unavailable', 'no 2d canvas context');
    const task = proxy.render({
      canvas,
      canvasContext: context,
      viewport: drawn,
      // No annotation layer, and so no path by which a PDF's own
      // JavaScript could run (ADR 0035, CVE-2026-16633).
      annotationMode: AnnotationMode.DISABLE,
    });
    const stop = () => task.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await task.promise;
    } catch (error) {
      // A page scrolled out of the window cancels rather than finishing,
      // and that is not something for the reader to be told about.
      if (signal?.aborted || this.destroyed) return;
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * A page's text, drained from the stream rather than asked for whole.
   *
   * `getTextContent()` is the same thing in one line, and it is one line
   * this app cannot use: it reads the stream with `for await`, and
   * `ReadableStream` is not async-iterable in the WebKit macOS ships —
   * the call throws `undefined is not a function`, the page comes back
   * with no text, and Find over the document finds nothing at all. The
   * bundled viewer's own text layer reads it with a reader for the same
   * reason. Playwright's WebKit *is* async-iterable, so this is another
   * thing no test in this repository would have caught (ADR 0035).
   */
  async text(page: number): Promise<TextRun[]> {
    const proxy = await this.page(page);
    const { transform } = proxy.getViewport({ scale: 1 });
    const reader = proxy.streamTextContent().getReader();
    const runs: TextRun[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value?.items ?? []) {
          if (!('str' in item)) continue;
          if (item.str === '') continue;
          runs.push({
            text: item.str,
            rect: runRect(transform as number[], item.transform, item.width, item.height),
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
    return runs;
  }

  async outline(): Promise<PdfOutlineEntry[]> {
    const raw = (await this.doc.getOutline()) as RawOutline[] | null;
    if (!raw) return [];
    const entries: PdfOutlineEntry[] = [];
    await flattenOutline(this.doc, raw, 1, entries);
    return entries;
  }

  destroy(): void {
    this.destroyed = true;
    this.cache.clear();
    // Through the loading task rather than the document: a
    // `PDFDocumentProxy` has no teardown of its own, and the task is
    // what holds the worker's copy of the file. The worker itself
    // survives, because the engine passed one in and pdf.js only
    // destroys the ones it made.
    void this.doc.loadingTask.destroy();
  }
}

/**
 * Why a worker rather than what `GlobalWorkerOptions.workerSrc` would
 * give us.
 *
 * pdf.js decides whether its worker script is same-origin by comparing
 * `URL.origin`, and a Tauri app on macOS and Linux is served from
 * `tauri://localhost`, whose origin is the string `"null"`. pdf.js reads
 * that as cross-origin and wraps the worker in a `blob:` URL, which
 * `script-src 'self'` then refuses — and it falls back to running the
 * whole worker on the main thread, where every page render blocks the
 * window. Handing it a worker we built ourselves skips the check.
 *
 * A worker that cannot start at all is not fatal: `getDocument` without
 * one takes pdf.js's own path, which ends at that same main-thread
 * fallback. Slow beats blank.
 */
function startWorker(): PDFWorker | null {
  try {
    const url = new URL(WORKER_URL, globalThis.location?.href ?? 'http://localhost/');
    const port = new Worker(url, { type: 'module', name: 'pdf' });
    // `create` rather than the constructor: it hands back the existing
    // `PDFWorker` for a port that already has one, where the constructor
    // throws. Nothing here opens two, but the difference is free.
    return PDFWorker.create({ name: 'markdown-pdf', port });
  } catch {
    GlobalWorkerOptions.workerSrc = WORKER_URL;
    return null;
  }
}

export class PdfJsEngine implements PdfEngine {
  private worker: PDFWorker | null = null;
  private started = false;

  async open(url: string): Promise<PdfDocument> {
    if (!this.started) {
      this.started = true;
      this.worker = startWorker();
    }
    const task = getDocument({
      url,
      // `useWorkerFetch` is deliberately not set. pdf.js works it out
      // from the page's origin: on an `http(s)` one the worker fetches
      // the cmaps, fonts and wasm itself; on `tauri://localhost` it
      // cannot, and the main thread fetches them and posts them across.
      // The cost of the second path is that ICC colour management goes
      // with it — `IccColorSpace` needs a synchronous fetch the worker
      // only has over `http(s)` — so ICCBased spaces fall back to their
      // alternates on macOS and Linux, and do not on Windows or in dev.
      // Forcing it either way makes one of those platforms worse.
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      iccUrl: ICC_URL,
      wasmUrl: WASM_URL,
      // JBIG2 and OpenJPEG decode in WebAssembly, which is what the
      // `'wasm-unsafe-eval'` in the CSP is for. An engine that refuses
      // it anyway falls back to the JS decoders shipped beside them.
      useWasm: true,
      // Already the default. Set so that it reads as a decision: XFA is
      // a forms engine, and this pane has no forms (ADR 0035).
      enableXfa: false,
      ...(this.worker ? { worker: this.worker } : {}),
    });
    try {
      return new PdfJsDocument(await task.promise);
    } catch (error) {
      if (error instanceof PasswordException) {
        throw new PdfError('password', error.message);
      }
      if (error instanceof InvalidPDFException) {
        throw new PdfError('corrupt', error.message);
      }
      throw new PdfError('unavailable', error instanceof Error ? error.message : String(error));
    }
  }

  destroy(): void {
    this.worker?.destroy();
    this.worker = null;
    this.started = false;
  }
}
