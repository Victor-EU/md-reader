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
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});
