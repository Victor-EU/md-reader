import { commands, events } from '@mdreader/ipc';
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

// What the watcher has to say about the open files (design 7.2). The
// window listens for as long as it exists, so nothing unsubscribes.
if (isTauri()) {
  void events.externalChangeEvent.listen((event) => {
    void shell.workspace.externalChange(event.payload);
  });
  void events.fileRemovedEvent.listen((event) => shell.workspace.fileRemoved(event.payload));
  void events.fileRenamedEvent.listen((event) => shell.workspace.fileRenamed(event.payload));
  // A second launch, a Finder double-click, or `open` from a terminal
  // (WP 1.8). Rust has already decided this window is the one for them.
  void events.openPathsEvent.listen((event) => {
    void shell.workspace.openPaths(event.payload);
  });
  // The window is closing and Rust is holding the close open for us.
  // Answering is in a `finally` because a window that cannot write its
  // session should still close now rather than wait out Rust's grace.
  void events.beforeCloseEvent.listen(async () => {
    try {
      await shell.workspace.flushPending();
    } finally {
      await commands.confirmClose();
    }
  });
}

/**
 * Put back the tabs from last time, then open whatever the launch was
 * asked to open (design 4.1).
 *
 * In that order, so double-clicking a file that was already open focuses
 * its tab rather than opening a second one.
 */
async function boot(): Promise<void> {
  const restore = await commands.loadWindow();
  shell.workspace.settings = restore.settings;
  if (restore.content) await shell.workspace.restore(restore.content, restore.recents);
  const paths = await commands.takeLaunchPaths();
  if (paths.length > 0) await shell.workspace.openPaths(paths);
}

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

const app = mount(App, { target, props: { shell } });

// After the mount, so the window is drawing while the files are read.
if (isTauri()) void boot();

export default app;
