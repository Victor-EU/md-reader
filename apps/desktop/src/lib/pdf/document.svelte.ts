import { nextId } from '../document.svelte.ts';
import { basename } from '../paths.ts';
import type { TextRun } from './engine.ts';
import { type PageSize, type PdfDocument, PdfError, type PdfOutlineEntry } from './engine.ts';

/** A PDF that is US Letter until the file says otherwise. */
const LETTER: PageSize = { width: 612, height: 792 };

/**
 * An open PDF, held beside `Doc` rather than made into one (ADR 0035).
 *
 * `Doc` is an `EditorState` with a Lezer tree over it — a buffer, an undo
 * history, an outline computed from headings, a word count. A PDF has
 * none of those. It has no source text the reader edits, nothing to
 * autosave, nothing to hand an agent, and no merge to perform when the
 * file changes underneath. Making one into a `Doc` would mean a `Doc`
 * whose every field is a lie.
 *
 * What it shares with `Doc` is the part the shell actually uses: an id
 * a tab names, a path, and a label for the tab strip.
 *
 * The file itself is opened on demand rather than in the constructor. A
 * restored session of two hundred tabs ends with the reader in one of
 * them, and every PDF among the rest would otherwise be parsed and held
 * whole in memory to draw nothing — the same reason `insert` does not
 * focus the tabs it builds (plan WP 3.3).
 */
export class PdfDoc {
  readonly id = nextId('pdf');
  readonly path: string;
  /** How many pages, once the file has been opened. Zero before that. */
  pages = $state(0);
  /** The file's size in bytes, as Rust measured it on the way in. */
  byteLen = $state(0);
  /** The document's own bookmarks, once they have been asked for. */
  outline = $state<PdfOutlineEntry[]>([]);
  /** What went wrong, for the pane to draw instead of pages. */
  failure = $state<string | null>(null);
  private document: PdfDocument | null = null;
  private opening: Promise<PdfDocument | null> | null = null;
  /** Set once given up, so a file still opening is not opened into it. */
  private gone = false;
  private readonly load: () => Promise<{ document: PdfDocument; byteLen: number }>;
  /**
   * Page sizes in points, as they have been asked for.
   *
   * A PDF page's height is exact from the file, which is what makes the
   * page list cheaper to measure than a markdown document's ever was. It
   * is not free, though: every page costs a round trip to the worker, so
   * asking for a thousand of them before the first paint would trade a
   * blank window for a scrollbar that is right from the first frame.
   * Page one is measured on open and stands in for the rest, and each
   * page corrects itself as the view reaches it — which is exactly what
   * `Heights` was built to absorb.
   */
  private readonly measured = new Map<number, PageSize>();
  private readonly runs = new Map<number, Promise<TextRun[]>>();

  constructor(options: {
    path: string;
    load: () => Promise<{ document: PdfDocument; byteLen: number }>;
  }) {
    this.path = options.path;
    this.load = options.load;
  }

  get label(): string {
    return basename(this.path);
  }

  /** Whether the file is open and the pane has something to draw. */
  get ready(): boolean {
    return this.document !== null;
  }

  /**
   * Open the file, at most once however many callers ask.
   *
   * Resolves to false when it will not open, having put the reason in
   * `failure`: a pane that says why beats a pane that stays empty.
   */
  async ensure(): Promise<boolean> {
    if (this.document) return true;
    this.opening ??= this.begin();
    return (await this.opening) !== null;
  }

  private async begin(): Promise<PdfDocument | null> {
    try {
      const { document, byteLen } = await this.load();
      // Given up while the file was opening — a tab dragged to another
      // window, or a window closed. The engine has a document nobody
      // asked for any more, and it holds the whole file.
      if (this.gone) {
        document.destroy();
        return null;
      }
      this.document = document;
      this.byteLen = byteLen;
      this.pages = document.pages;
      this.measured.set(1, await document.size(1));
      this.failure = null;
      // The bookmarks are for the sidebar, and nothing waits on them —
      // including for them to arrive, which is why the failure is
      // swallowed here rather than left to reject into nobody.
      document
        .outline()
        .then((entries) => {
          this.outline = entries;
        })
        .catch(() => {
          this.outline = [];
        });
      return document;
    } catch (error) {
      this.failure =
        error instanceof PdfError
          ? error.reason
          : error instanceof Error
            ? error.message
            : 'unavailable';
      // Cleared so that a second attempt — the reader closing the tab
      // and opening the file again — is a second attempt.
      this.opening = null;
      throw error;
    }
  }

  /** Page one's size, which stands in for every page not yet measured. */
  get nominal(): PageSize {
    return this.measured.get(1) ?? LETTER;
  }

  /** What a page measures, if it has been asked before. */
  sizeOf(page: number): PageSize | null {
    return this.measured.get(page) ?? null;
  }

  /**
   * A page's size, or page one's if it cannot be had.
   *
   * Never rejects. The view asks for this on the way to drawing a page
   * and cannot wait for the answer, so a document given up underneath it
   * — a tab closed, a window shut, a PDF dragged to another window —
   * would otherwise reject into nobody at all.
   */
  async size(page: number): Promise<PageSize> {
    const known = this.measured.get(page);
    if (known) return known;
    if (!this.document) return this.nominal;
    try {
      const size = await this.document.size(page);
      this.measured.set(page, size);
      return size;
    } catch {
      return this.nominal;
    }
  }

  async render(
    page: number,
    scale: number,
    canvas: HTMLCanvasElement,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.document) return;
    await this.document.render({ page, scale, canvas, ...(signal ? { signal } : {}) });
  }

  /**
   * A page's text, asked once and kept: Find walks all of them.
   *
   * A page whose text will not come back is empty rather than fatal, and
   * it is not remembered as empty — Find over a document is a hundred of
   * these, and one page that failed once should not decide the answer
   * for the rest of the session.
   */
  async text(page: number): Promise<TextRun[]> {
    const held = this.runs.get(page);
    if (held) return held;
    if (!this.document) return [];
    const asked = this.document.text(page).catch((error: unknown) => {
      this.runs.delete(page);
      this.failure = error instanceof Error ? error.message : String(error);
      return [];
    });
    this.runs.set(page, asked);
    return asked;
  }

  destroy(): void {
    this.gone = true;
    this.document?.destroy();
    this.document = null;
    this.opening = null;
    this.measured.clear();
    this.runs.clear();
  }
}
