import { commands } from '@mdreader/ipc';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { createEnhancer } from './lib/read/enhance.ts';
import { createShell } from './lib/shell.svelte.ts';

const FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }];

const shell = createShell({
  commands,
  pickFiles: async () => {
    const picked = await open({ multiple: true, directory: false, filters: FILTERS });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  pickSaveTarget: (suggested) => save({ defaultPath: suggested, filters: FILTERS }),
  // A link opens in the system browser; the webview itself never navigates
  // away from the app (design 6.2).
  openExternal: (url) => {
    void openUrl(url);
  },
  enhancer: createEnhancer(),
  // Images load over the asset protocol, whose scope Rust widens to each
  // opened document's folder (design 8). Outside Tauri nothing local loads.
  assetUrl: isTauri() ? (path) => convertFileSrc(path) : undefined,
});

// The webview handles drops itself when it runs under Tauri, and only it
// knows the real paths; the DOM handler in App.svelte covers a browser.
if (isTauri()) {
  void getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === 'drop') void shell.workspace.openPaths(event.payload.paths);
  });
}

const target = document.getElementById('app');
if (!target) {
  throw new Error('missing #app root');
}

export default mount(App, { target, props: { shell } });
