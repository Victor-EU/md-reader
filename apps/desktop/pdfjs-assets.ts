import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Put pdf.js's self-hosted data where the page can fetch it (ADR 0035).
 *
 * pdf.js is one package but four sets of files, and the three that are
 * data rather than code have to be reachable by URL: the character maps
 * a CJK document needs, the fourteen standard fonts a document is
 * allowed to assume, the CMYK profile, and the WebAssembly decoders.
 * Four megabytes of it, belonging to the version in the lockfile, so it
 * is copied at build time rather than committed — `public/pdfjs` is in
 * `.gitignore` for that reason.
 *
 * It runs from `config`, which is earlier than it looks like it needs
 * to be. Vite decides how to serve `public/` when the server is made,
 * and `buildStart` is after that: files written then are on disk and
 * not reachable, which is a worker that never loads, a `getDocument`
 * that never resolves, and a suite that times out saying nothing.
 * `config` is before there is a server at all, and it covers the three
 * ways this app is run — `vite build`, `vite dev`, and the browser test
 * runner, which is a Vite server too.
 */

/** What is copied, and where it lands under `public/pdfjs/`. */
const DIRECTORIES = ['cmaps', 'standard_fonts', 'iccs'] as const;

/**
 * The WebAssembly decoders, named one by one rather than copied whole.
 *
 * `wasm/` also holds `quickjs-eval.wasm`, which is the sandbox a PDF's
 * own JavaScript runs in. This app has no annotation layer and so no
 * scripting path, and the surest way to keep it that way is for the 469
 * KB never to reach the bundle. The `_nowasm_fallback.js` files are the
 * JS decoders pdf.js drops to by itself when WebAssembly is refused,
 * which is what makes an old WebKit degrade rather than fail.
 */
const WASM = [
  'jbig2.wasm',
  'jbig2_nowasm_fallback.js',
  'openjpeg.wasm',
  'openjpeg_nowasm_fallback.js',
  'qcms_bg.wasm',
];

/** The licences Apache-2.0 asks us to carry beside the binaries. */
const WASM_LICENCES = [
  'LICENSE_JBIG2',
  'LICENSE_OPENJPEG',
  'LICENSE_PDFJS_JBIG2',
  'LICENSE_PDFJS_OPENJPEG',
  'LICENSE_PDFJS_QCMS',
  'LICENSE_QCMS',
];

/**
 * What is written beside the copy to say which version it is of.
 *
 * The copy is skipped when it matches, which is almost always. Four and
 * a half megabytes is a second of every start — and, worse, the old copy
 * has to come out before the new one goes in, so doing it every time
 * leaves a window with no files in it.
 */
const STAMP = '.version';

/**
 * The worker, served rather than bundled; see `pdf/pdfjs.ts`.
 *
 * The `legacy` build, for the same reason the main thread takes it: the
 * modern one calls `Map.prototype.getOrInsertComputed`, which the
 * WKWebView macOS ships does not have. Both halves have to match — they
 * check each other's `apiVersion` — and both are 6.3.289.
 */
const WORKER = 'legacy/build/pdf.worker.min.mjs';

export function pdfjsAssets(): Plugin {
  return {
    name: 'markdown:pdfjs-assets',
    config() {
      const require = createRequire(import.meta.url);
      const packaged = require.resolve('pdfjs-dist/package.json');
      const from = dirname(packaged);
      const to = join(import.meta.dirname, 'public', 'pdfjs');
      // A stale copy is a version skew between the code and its data,
      // and it shows up as a font that silently fails to load rather
      // than as an error — so the version is written beside it and read
      // back rather than trusted.
      const version = String(JSON.parse(readFileSync(packaged, 'utf8')).version);
      const stamp = join(to, STAMP);
      if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return;
      rmSync(to, { recursive: true, force: true });
      mkdirSync(join(to, 'wasm'), { recursive: true });
      for (const name of DIRECTORIES) {
        cpSync(join(from, name), join(to, name), { recursive: true });
      }
      for (const name of [...WASM, ...WASM_LICENCES]) {
        cpSync(join(from, 'wasm', name), join(to, 'wasm', name));
      }
      cpSync(join(from, WORKER), join(to, 'pdf.worker.min.mjs'));
      cpSync(join(from, 'LICENSE'), join(to, 'LICENSE'));
      if (!existsSync(join(to, 'cmaps'))) {
        throw new Error('pdfjs-dist data did not copy; PDFs will not render');
      }
      writeFileSync(stamp, version);
    },
  };
}
