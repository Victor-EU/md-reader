import { commands } from '@mdreader/ipc';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, save } from '@tauri-apps/plugin-dialog';
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
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
