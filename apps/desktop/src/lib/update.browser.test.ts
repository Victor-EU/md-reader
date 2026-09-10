import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Available, describeUpdate, type Updater } from './update.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * The updater as the workspace sees it (plan WP 1.12). Nothing here
 * reaches the network or the plugin: what is under test is the order the
 * workspace does things in, which is where the loss would be.
 */
class FakeUpdater implements Updater {
  found: Available | null = null;
  failCheck: string | null = null;
  failInstall: string | null = null;
  /** Fractions to feed the progress callback before install resolves. */
  progress: (number | null)[] = [];
  checks = 0;
  installs = 0;
  relaunches = 0;
  /** What had been written to disk by the time relaunch was called. */
  writtenAtRelaunch: string | null = null;

  constructor(private readonly ipc: () => FakeIpc) {}

  async check(): Promise<Available | null> {
    this.checks += 1;
    if (this.failCheck !== null) throw new Error(this.failCheck);
    return this.found;
  }

  async install(onProgress: (fraction: number | null) => void): Promise<void> {
    this.installs += 1;
    for (const fraction of this.progress) onProgress(fraction);
    if (this.failInstall !== null) throw new Error(this.failInstall);
  }

  async relaunch(): Promise<void> {
    this.relaunches += 1;
    this.writtenAtRelaunch = this.ipc().files.get('/a/one.md')?.content ?? null;
  }
}

let host: HTMLDivElement;
let ipc: FakeIpc;
let updater: FakeUpdater;
let workspace: Workspace;

function open(files: Record<string, string> = {}, withUpdater = true) {
  ipc = createFakeIpc(files);
  updater = new FakeUpdater(() => ipc);
  workspace = new Workspace({
    commands: ipc.commands,
    pickFiles: async () => Object.keys(files),
    updater: withUpdater ? updater : undefined,
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open();
});

afterEach(() => {
  workspace.destroy();
  workspace.stopWatchingForUpdates();
  host.remove();
});

describe('checking', () => {
  it('reports both ways when the reader asked, and only one way when they did not', async () => {
    await workspace.checkForUpdates(true);
    expect(workspace.update.phase).toBe('none');
    expect(workspace.status).toBe('Markdown is up to date');

    workspace.status = '';
    await workspace.checkForUpdates();
    expect(workspace.update.phase).toBe('none');
    expect(workspace.status).toBe('');
  });

  it('keeps a failed check quiet unless the reader asked', async () => {
    updater.failCheck = 'network unreachable';
    await workspace.checkForUpdates();
    expect(workspace.update.phase).toBe('failed');
    expect(workspace.status).toBe('');
    expect(describeUpdate(workspace.update)).toBe('');

    await workspace.checkForUpdates(true);
    expect(workspace.status).toBe('Could not check for updates — network unreachable');
  });

  it('says where updates come from when there is no updater at all', async () => {
    open({}, false);
    await workspace.checkForUpdates(true);
    expect(workspace.status).toBe('Updates are only checked in the installed app');
    expect(workspace.update.phase).toBe('idle');
  });

  it('puts what it found on the status bar', async () => {
    updater.found = { version: '0.2.0' };
    await workspace.checkForUpdates();
    expect(describeUpdate(workspace.update)).toBe('Version 0.2.0 is available');
  });
});

describe('installing', () => {
  beforeEach(async () => {
    updater.found = { version: '0.2.0' };
    await workspace.checkForUpdates();
  });

  it('shows the download and ends ready to restart', async () => {
    const seen: string[] = [];
    updater.progress = [null, 0.5, 1];
    // The fractions arrive synchronously inside install, so the sentence
    // is read from the last one; what matters is that it ends ready.
    await workspace.installUpdate();
    seen.push(describeUpdate(workspace.update));
    expect(updater.installs).toBe(1);
    expect(seen).toEqual(['Version 0.2.0 is ready — restart to finish']);
  });

  it('does not sit in "downloading" after the download failed', async () => {
    updater.failInstall = 'checksum mismatch';
    await workspace.installUpdate();
    expect(workspace.update.phase).toBe('failed');
    expect(workspace.status).toBe('Could not install the update — checksum mismatch');
    expect(describeUpdate(workspace.update)).toBe('');
  });

  it('ignores a check that arrives while the download is running', async () => {
    const installing = workspace.installUpdate();
    await workspace.checkForUpdates(true);
    await installing;
    expect(updater.checks).toBe(1);
  });

  it('says what is already happening when a check arrives during one', async () => {
    workspace.update = { phase: 'checking' };
    await workspace.checkForUpdates(true);
    expect(workspace.status).toBe('Checking for updates…');
    expect(updater.checks).toBe(1);
  });

  it('installs nothing when nothing was found', async () => {
    open();
    await workspace.installUpdate();
    expect(updater.installs).toBe(0);
  });
});

describe('restarting', () => {
  it('writes what is pending before it relaunches', async () => {
    // A relaunch is a close the window is never told about, so an
    // autosave still on its timer would go out the window with it.
    open({ '/a/one.md': '# One\n' });
    await workspace.pickAndOpen();
    workspace.setMode('edit');
    workspace.mount(host);
    const view = workspace.view;
    expect(view).not.toBeNull();
    view?.dispatch({ changes: { from: view.state.doc.length, insert: 'edited\n' } });
    expect(workspace.activeDoc?.dirty).toBe(true);

    updater.found = { version: '0.2.0' };
    await workspace.checkForUpdates();
    await workspace.installUpdate();
    await workspace.restartForUpdate();

    expect(updater.relaunches).toBe(1);
    expect(updater.writtenAtRelaunch).toBe('# One\nedited\n');
  });

  it('does not relaunch before an update is ready', async () => {
    updater.found = { version: '0.2.0' };
    await workspace.checkForUpdates();
    await workspace.restartForUpdate();
    expect(updater.relaunches).toBe(0);
  });
});
