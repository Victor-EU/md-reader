import type { PdfDocument, PdfEngine } from './engine.ts';

/**
 * The engine, loaded the first time a PDF is opened (ADR 0035).
 *
 * pdf.js is a megabyte of code and four of data, and most launches of a
 * markdown reader never meet a PDF. Read mode makes the same bargain
 * with Shiki, KaTeX and Mermaid: the port is handed over at startup and
 * the library behind it arrives when something asks for it.
 *
 * This is also the only reason the shell can be built without pdf.js in
 * its first chunk while still holding a `PdfEngine` from the beginning —
 * the port is what makes a stand-in like this possible at all.
 */
export function lazyPdfEngine(): PdfEngine {
  let engine: PdfEngine | null = null;
  return {
    async open(url: string): Promise<PdfDocument> {
      if (!engine) {
        const { PdfJsEngine } = await import('./pdfjs.ts');
        engine = new PdfJsEngine();
      }
      return engine.open(url);
    },
    destroy(): void {
      engine?.destroy();
      engine = null;
    },
  };
}
