/**
 * The PDF engine port (ADR 0035).
 *
 * No pdf.js type may appear in this file, and neither may the library's
 * name: `single-import.test.ts` reads that literally. It is the whole of
 * what the shell is allowed to know about rendering a PDF, and it is
 * written to be satisfiable by more than one library: pdf.js is the
 * engine we chose, PDFium is the one we might choose later, and the
 * point of the seam is that swapping them is writing one file rather
 * than unpicking the shell.
 *
 * Three properties of this interface are deliberate.
 *
 * It renders into a canvas the *caller* owns, because the caller is what
 * knows about virtualization and device pixel ratio, and because both
 * candidate engines rasterize to a bitmap. It measures in points rather
 * than pixels, because points are what a PDF is written in and pixels
 * are what a zoom level makes of them — putting the conversion on one
 * side of the line keeps the other side honest. And `text()` returns
 * runs with geometry rather than a rendered DOM layer, because pdf.js's
 * `TextLayerBuilder` and PDFium's text extraction agree on that shape
 * and disagree on everything above it.
 *
 * What it deliberately does not carry: annotations, forms, editing,
 * printing, or anything that would make it a description of pdf.js
 * rather than of PDF viewing. A port wide enough to express one
 * library's whole surface is not a port.
 */

/** A page's intrinsic size, in PDF points (1/72 inch). */
export interface PageSize {
  width: number;
  height: number;
}

/** One bookmark in a document's own table of contents. */
export interface PdfOutlineEntry {
  level: number;
  text: string;
  page: number;
}

export interface RenderRequest {
  /** One-based, the way a PDF numbers its own pages. */
  page: number;
  /** CSS pixels per point, so the caller owns zoom and device ratio. */
  scale: number;
  canvas: HTMLCanvasElement;
  /** A page scrolled out of the window cancels rather than finishing. */
  signal?: AbortSignal;
}

/** A run of text and where it sits, for the selection layer. */
export interface TextRun {
  text: string;
  /** Left, top, width, height, in points from the page's top-left. */
  rect: readonly [number, number, number, number];
}

export interface PdfDocument {
  readonly pages: number;
  size(page: number): Promise<PageSize>;
  render(request: RenderRequest): Promise<void>;
  text(page: number): Promise<TextRun[]>;
  outline(): Promise<PdfOutlineEntry[]>;
  destroy(): void;
}

export interface PdfEngine {
  /** The URL is the asset protocol's; the engine fetches it itself. */
  open(url: string): Promise<PdfDocument>;
  destroy(): void;
}

/**
 * Why a document would not open, in terms the status bar can use.
 *
 * A password is its own case rather than a corruption because it is the
 * one the reader can do something about, and `too_large` is its own
 * because it is a limit this app chose rather than anything wrong with
 * the file.
 */
export type PdfFailure = 'password' | 'corrupt' | 'too_large' | 'unavailable';

export class PdfError extends Error {
  constructor(
    readonly reason: PdfFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PdfError';
  }
}

/** What the status bar says when a PDF will not open. */
export function describePdfError(error: unknown, name: string): string {
  if (!(error instanceof PdfError)) return `${name} could not be opened`;
  switch (error.reason) {
    case 'password':
      return `${name} is password protected`;
    case 'too_large':
      return `${name} is too large to open`;
    case 'corrupt':
      return `${name} is not a readable PDF`;
    default:
      return `${name} could not be opened`;
  }
}
