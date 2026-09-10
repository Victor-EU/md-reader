import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/**
 * The performance harness (plan 7.4), as its own project.
 *
 * Its own file rather than a block in the root config because it needs
 * the Svelte compiler: what a session of two hundred tabs costs is the
 * shell's own arithmetic, and the shell is written in runes. The plugin
 * is a dependency of the app and of this harness, and the root config
 * has no business holding one.
 *
 * The root is this directory, so a path in here is a path in the
 * harness: `src` is the benches and `results` is what they wrote.
 */
export default defineConfig({
  // No `svelte.config.js` at the repository root to find, so the one
  // thing that file says is said here: components are written in
  // TypeScript and have to be preprocessed before they compile.
  plugins: [svelte({ preprocess: vitePreprocess() })],
  test: {
    // Excluded from `pnpm test`; run with `pnpm bench`. Writes JSON to
    // tools/bench/results.
    name: 'bench',
    include: ['src/**/*.bench.test.ts'],
    testTimeout: 300_000,
    // One file at a time. Everything here is a measurement, and five
    // files racing two browsers for one machine's cores measures the
    // machine's load: the numbers moved by three to twenty times
    // between a bench run alone and the same bench run beside the
    // others.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
    },
  },
});
