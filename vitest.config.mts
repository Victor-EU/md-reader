import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Two runners, as the build plan section 7 requires:
// - node: pure EditorState logic, fast, no layout
// - browser: anything that needs a real EditorView, on Chromium and WebKit
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'markdown',
          environment: 'node',
          include: ['packages/markdown/src/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts'],
        },
      },
      {
        // The read renderer's DOM adapter against the same goldens the node
        // project writes, in both engines (plan 7.2).
        test: {
          name: 'markdown-browser',
          include: ['packages/markdown/src/**/*.browser.test.ts'],
          // One browser project at a time, after the node ones. Every
          // project at once is six browsers and forty pages on this Mac,
          // twelve on CI's three cores, and a starved WebKit sometimes
          // never finishes loading a test's frame -- which Vitest waits
          // for without a limit, so the run hangs until something kills
          // it. Groups run lowest first; projects in one group run together.
          sequence: { groupOrder: 1 },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
          },
        },
      },
      {
        // Theme one is data; these are the invariants that keep the two
        // highlighters reading it the same way (plan WP 1.9).
        test: {
          name: 'theme',
          environment: 'node',
          include: ['packages/theme/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ipc',
          environment: 'node',
          include: ['packages/ipc/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'editor-core',
          environment: 'node',
          include: ['packages/editor-core/src/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts'],
        },
      },
      {
        test: {
          name: 'editor-core-browser',
          include: ['packages/editor-core/src/**/*.browser.test.ts'],
          sequence: { groupOrder: 2 },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
          },
        },
      },
      {
        // The shell's framework-free logic: keys, scoring, the command
        // registry, tab arithmetic. No DOM, no Svelte runtime.
        test: {
          name: 'desktop',
          environment: 'node',
          include: ['apps/desktop/src/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts'],
        },
      },
      // The shell itself: rune stores and mounted components, driven with
      // the fake IPC, on both engines. Its own file, because the Svelte
      // plugin is a dependency of the app, not of the workspace root.
      './apps/desktop/vitest.browser.config.ts',
      {
        // The release tooling: the updater manifest and the one version
        // number the three manifests have to agree on (plan WP 1.12).
        test: {
          name: 'release',
          environment: 'node',
          include: ['tools/release/**/*.test.mjs'],
        },
      },
      // The performance harness, excluded from `pnpm test` and run with
      // `pnpm bench`. Its own file, because measuring what a session of
      // two hundred tabs costs means compiling the shell.
      './tools/bench/vitest.config.ts',
    ],
  },
});
