#!/usr/bin/env node
/**
 * The PDFs `apps/desktop/src/lib/pdf/` tests against (ADR 0035).
 *
 * They are committed, because a test that generates its own fixture
 * tests the generator; they are written by this script, because a
 * committed binary nobody can regenerate is a fossil. Between them they
 * cover the three ways a PDF says what its text is made of, which is the
 * part of the adapter that has data behind it:
 *
 * - `standard.pdf` names fonts it does not carry, including the two of
 *   the base fourteen that pdf.js still has to fetch from
 *   `standard_fonts/` rather than leave to the system.
 * - `cjk.pdf` names a Japanese font it does not carry, through a CMap
 *   pdf.js fetches from `cmaps/` — the directory that exists for exactly
 *   this and is otherwise never touched.
 * - `embedded.pdf` carries a subset of a TrueType font in the file, and
 *   is made by macOS's own `cupsfilter` rather than written here,
 *   because hand-building a font is a different project. Regenerating it
 *   needs a Mac; it is committed so that nobody else has to.
 *
 * Run with `pnpm pdf:fixtures`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '../../apps/desktop/src/lib/pdf/fixtures');

/**
 * A PDF file from a list of indirect objects.
 *
 * Object 1 is the catalogue and object 2 the page tree, by convention
 * here rather than by the format's rules. The cross-reference table is
 * the reason this is a function and not three string templates: every
 * entry is a byte offset, so nothing above it can change length without
 * being counted.
 */
function pdf(objects) {
  const header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const parts = [Buffer.from(header, 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    at += chunk.length;
  });
  const rows = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`);
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows.join('')}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

/** A content stream, with the `/Length` the format insists on. */
function stream(text) {
  const bytes = Buffer.from(text, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`, 'latin1'),
    bytes,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/**
 * `standard.pdf`: three pages, no embedded font anywhere.
 *
 * Helvetica the system substitutes for; Symbol and ZapfDingbats it does
 * not, and pdf.js fetches those two out of `standard_fonts/`. Three
 * pages rather than one so that a page count, a page size that differs
 * from its neighbours, and a bookmark that points at something other
 * than the first page all have somewhere to be wrong.
 */
function standard() {
  const page = (contents, resources, box) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box}] /Resources ${resources} ` +
    `/Contents ${contents} 0 R >>`;
  const fonts = '<< /Font << /F1 6 0 R /F2 7 0 R /F3 8 0 R >> >>';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 12 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    page(9, fonts, '612 792'),
    page(10, fonts, '612 792'),
    // A5 landscape, so that a size test cannot pass by reading page one.
    page(11, fonts, '595 420'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>',
    stream(
      'BT /F1 24 Tf 72 700 Td (Standard fonts) Tj ET\n' +
        'BT /F1 12 Tf 72 660 Td (The quick brown fox jumps over the lazy dog.) Tj ET\n' +
        'BT /F2 18 Tf 72 620 Td (abgdez) Tj ET\n' +
        'BT /F3 18 Tf 72 580 Td (34567) Tj ET',
    ),
    stream('BT /F1 24 Tf 72 700 Td (Second page) Tj ET'),
    stream('BT /F1 24 Tf 72 340 Td (Third page, landscape) Tj ET'),
    '<< /Type /Outlines /First 13 0 R /Last 14 0 R /Count 2 >>',
    '<< /Title (Standard fonts) /Parent 12 0 R /Next 14 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (Second page) /Parent 12 0 R /Prev 13 0 R /Dest [4 0 R /Fit] ' +
      '/First 15 0 R /Last 15 0 R /Count 1 >>',
    '<< /Title (A nested bookmark) /Parent 14 0 R /Dest [5 0 R /Fit] >>',
  ]);
}

/**
 * `cjk.pdf`: Japanese through a predefined CMap and no embedded font.
 *
 * `UniJIS-UCS2-H` maps UCS-2 to Adobe-Japan1 CIDs, and pdf.js has to
 * fetch it — and `Adobe-Japan1-UCS2` behind it, to get back to Unicode —
 * out of `cmaps/`. Nothing else in the app reaches that directory, so
 * this fixture is the only thing that would notice if it stopped being
 * copied into the build.
 */
function cjk() {
  // こんにちは, as UCS-2 code points the CMap turns into CIDs.
  const hello = '30533093306B3061306F';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /Ryumin-Light-UniJIS-UCS2-H ' +
      '/Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Ryumin-Light ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> ' +
      '/FontDescriptor << /Type /FontDescriptor /FontName /Ryumin-Light /Flags 6 ' +
      '/FontBBox [-170 -331 1024 903] /ItalicAngle 0 /Ascent 903 /Descent -331 ' +
      '/CapHeight 709 /StemV 69 >> /DW 1000 >>',
    stream(`BT /F1 24 Tf 72 700 Td <${hello}> Tj ET`),
  ]);
}

writeFileSync(join(OUT, 'standard.pdf'), standard());
writeFileSync(join(OUT, 'cjk.pdf'), cjk());
process.stdout.write(`wrote standard.pdf and cjk.pdf to ${OUT}\n`);
process.stdout.write('embedded.pdf is made by cupsfilter; see the comment at the top\n');
