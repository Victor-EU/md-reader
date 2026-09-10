import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { pdfjsAssets } from './pdfjs-assets.ts';

const host = process.env.TAURI_DEV_HOST;
const platform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  plugins: [svelte(), pdfjsAssets()],
  // pdf.js ships two builds and this app needs the transpiled one: the
  // modern build calls `Map.prototype.getOrInsertComputed`, and the
  // WKWebView that comes with macOS does not have it, so every page
  // render fails at the first font. `build.target` below cannot help —
  // it rewrites syntax, not missing methods — and the worker is copied
  // rather than bundled, so it is switched in `pdfjs-assets.ts` too.
  // An exact match, so that `pdfjs-dist/legacy/...` is not rewritten
  // again into itself.
  resolve: {
    alias: [{ find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' }],
  },
  // Tauri expects a fixed port and fails if it is taken.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // WebView2 on Windows, WKWebView elsewhere.
    target: platform === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
