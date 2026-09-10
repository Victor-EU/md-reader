import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { pdfjsAssets } from './pdfjs-assets.ts';

/** The shell's components and rune stores, in both engines. */
export default defineConfig({
  plugins: [svelte(), pdfjsAssets()],
  // The same alias `vite.config.ts` sets, and here for a reason worth
  // saying out loud: Playwright's WebKit is newer than the one macOS
  // ships, so the modern build passes every test here and fails on a
  // real Mac. The tests run what the app runs.
  resolve: {
    alias: [{ find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' }],
  },
  // Read mode loads these three on demand; naming them here means the
  // runner optimizes them up front instead of reloading mid-test.
  optimizeDeps: {
    include: [
      'katex',
      'mermaid',
      'shiki/core',
      'shiki/engine/javascript',
      'shiki/langs',
      'shiki/themes',
      // And these five, which are not loaded on demand at all: they are
      // what `update.ts` reaches for, and the runner finds them only
      // when it reaches the file that does. Discovering a dependency
      // mid-run makes Vite re-optimize and reload the page under
      // whatever else is running, and the two files in flight die with
      // `Failed to fetch dynamically imported module` — the flake that
      // has taken one or two files out of every full run on CI.
      '@tauri-apps/api/app',
      '@tauri-apps/api/webview',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-opener',
    ],
    // pdf.js is the opposite case: it is one prebuilt file of two and a
    // half megabytes, so there is nothing to pre-bundle and the
    // optimizer sat on it for ten minutes trying. Excluding it says so
    // up front, which is also what keeps it from being *discovered*
    // mid-run — that reloads the page under whatever else is running,
    // and takes half a dozen unrelated files down with it.
    exclude: ['pdfjs-dist', 'pdfjs-dist/legacy/build/pdf.mjs'],
  },
  test: {
    name: 'desktop-browser',
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
    },
  },
});
