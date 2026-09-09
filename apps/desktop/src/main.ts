import { commands, events } from '@mdreader/ipc';
import { getVersion } from '@tauri-apps/api/app';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { mount } from 'svelte';
import App from './App.svelte';
// Which pulls in every theme's colours and the bundled faces.
import './app.css';
import { isMac } from './lib/platform.ts';
import { createEnhancer } from './lib/read/enhance.ts';
import { createShell } from './lib/shell.svelte.ts';
import { watchFullScreen } from './lib/titlebar.ts';
import { tauriUpdater } from './lib/update.ts';

const FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }];

const shell = createShell({
  commands,
  pickFiles: async () => {
    const picked = await open({ multiple: true, directory: false, filters: FILTERS });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  },
  pickSaveTarget: (suggested) => save({ defaultPath: suggested, filters: FILTERS }),
  pickFolder: async () => {
    const picked = await open({ multiple: false, directory: true });
    return Array.isArray(picked) ? (picked[0] ?? null) : picked;
  },
  // A link opens in the system browser; the webview itself never navigates
  // away from the app (design 6.2).
  openExternal: (url) => {
    void openUrl(url);
  },
  enhancer: createEnhancer({ dark: () => shell.workspace.darkPage }),
  // Images load over the asset protocol, whose scope Rust widens to each
  // opened document's folder (design 8). Outside Tauri nothing local loads.
  assetUrl: isTauri() ? (path) => convertFileSrc(path) : undefined,
  // Only the installed app has anywhere to update from: a dev build's
  // version is whatever the config says, and the endpoint would answer
  // every launch with the release that is already running.
  updater: isTauri() && import.meta.env.PROD ? tauriUpdater() : undefined,
  // Nothing draws the window's name now that the tabs are where it used
  // to be, but the Window menu and Mission Control still read it.
  setTitle: isTauri()
    ? (title) => {
        void getCurrentWindow().setTitle(title);
      }
    : undefined,
});

/*
 * The tab strip is this window's title bar (plan WP 2.8). macOS draws
 * the window no bar of its own and keeps its three buttons in the corner
 * the strip leaves clear for them; Windows and Linux keep their
 * decorations for now, and a browser build has none to keep.
 *
 * Full screen is when that corner is not wanted, and a resize is the
 * only news of it the page gets — see `watchFullScreen` for why one
 * question at that moment is not enough.
 */
if (isTauri() && isMac) {
  const self = getCurrentWindow();
  shell.workspace.titleBar = true;
  watchFullScreen(
    (listener) => window.addEventListener('resize', listener),
    () => self.isFullscreen(),
    (full) => {
      shell.workspace.fullScreen = full;
    },
  );
}

// The system's light and dark, kept current for the settings that follow
// it. The paper is what decides whether the page is dark, but "system" is
// the appearance the app starts with and most readers leave it there.
if (typeof matchMedia === 'function') {
  const query = matchMedia('(prefers-color-scheme: dark)');
  shell.workspace.systemDark = query.matches;
  query.addEventListener('change', (event) => {
    shell.workspace.systemDark = event.matches;
  });
}

// What the watcher has to say about the open files (design 7.2). The
// window listens for as long as it exists, so nothing unsubscribes.
//
// Every listener for an addressed event is registered as this window
// rather than as anybody, which is what makes an event Rust addresses to
// one window arrive at one window (plan WP 2.5). A listener that asks
// for nothing in particular is matched by every emit, addressed or not,
// so with a second window open the untargeted form would have this one
// closing because that one was asked to, and opening a copy of every tab
// torn off over there. The one event below that is deliberately
// untargeted is the settings, which are the app's rather than a
// window's and are sent to all of them.
if (isTauri()) {
  const self = getCurrentWindow();
  void events.externalChangeEvent(self).listen((event) => {
    void shell.workspace.externalChange(event.payload);
  });
  void events.fileRemovedEvent(self).listen((event) => shell.workspace.fileRemoved(event.payload));
  void events.fileRenamedEvent(self).listen((event) => shell.workspace.fileRenamed(event.payload));
  // A second launch, a Finder double-click, or `open` from a terminal
  // (WP 1.8). Rust has already decided this window is the one for them.
  void events.openPathsEvent(self).listen((event) => {
    void shell.workspace.openPaths(event.payload);
  });
  // The folder workspace (plan WP 2.4): the watch on the open folder,
  // and the results of a content search as they are found. Both are this
  // window's folder, which is not the window next to it's.
  void events
    .folderChangedEvent(self)
    .listen((event) => shell.workspace.folderChanged(event.payload));
  void events
    .searchProgressEvent(self)
    .listen((event) => shell.workspace.searchProgress(event.payload));
  void events.searchDoneEvent(self).listen((event) => shell.workspace.searchDone(event.payload));
  // A tab another window has given up (plan WP 2.5). Rust has already
  // decided this window is the one to take it in.
  void events.tabArrivedEvent(self).listen((event) => shell.workspace.adoptTab(event.payload));
  // The preferences, changed here or in another window (plan WP 2.6).
  // Not addressed to a window, because they are not a window's: every
  // window applies them, and applies them without writing back.
  void events.settingsChangedEvent.listen((event) => shell.workspace.applySettings(event.payload));
  // The window is closing and Rust is holding the close open for us.
  // Answering is in a `finally` because a window that cannot write its
  // session should still close now rather than wait out Rust's grace.
  void events.beforeCloseEvent(self).listen(async () => {
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
  shell.workspace.applySettings(restore.settings);
  if (restore.content) await shell.workspace.restore(restore.content, restore.recents);
  // A window made for a torn-off tab is given it before it is listening,
  // so it asks; asking is also what says it is listening from here on.
  for (const move of await commands.takeMovedTabs()) shell.workspace.adoptTab(move);
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
if (isTauri()) {
  void boot();
  void getVersion().then((version) => {
    shell.workspace.version = version;
  });
  shell.workspace.watchForUpdates();
}

export default app;
