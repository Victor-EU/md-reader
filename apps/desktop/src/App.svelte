<script lang="ts">
import Banner from './components/Banner.svelte';
import EditorPane from './components/EditorPane.svelte';
import FindBar from './components/FindBar.svelte';
import Palette from './components/Palette.svelte';
import PdfPane from './components/PdfPane.svelte';
import ReadPane from './components/ReadPane.svelte';
import Settings from './components/Settings.svelte';
import Sidebar from './components/Sidebar.svelte';
import StatusBar from './components/StatusBar.svelte';
import TabStrip from './components/TabStrip.svelte';
import Toolbar from './components/Toolbar.svelte';
import { applyAppearance } from './lib/appearance.ts';
import { fileUrlToPath } from './lib/paths.ts';
import type { Shell } from './lib/shell.svelte.ts';

let { shell }: { shell: Shell } = $props();
const workspace = $derived(shell.workspace);
const registry = $derived(shell.registry);
const settings = $derived(workspace.activeTab?.kind === 'settings');
const pdf = $derived(workspace.activeTab?.kind === 'pdf');

/**
 * Dress the window (design 11). Three attributes and three custom
 * properties on the root element; the generated stylesheet holds every
 * colour of every theme, so nothing here computes one. What is applied
 * is the app's settings under the ones the document in front was given
 * (plan WP 2.6), which is why moving between tabs can change it.
 */
$effect(() => {
  applyAppearance(document.documentElement, workspace.applied, workspace.systemDark);
});

/**
 * Name the window after the tab in front (plan WP 2.8). The title bar
 * no longer draws it, but the Window menu and Mission Control still
 * read it, and a window called after the file in it is findable there.
 */
$effect(() => {
  workspace.nameWindow();
});

/**
 * The whole keymap, derived from the command registry. A key the editor
 * has already handled arrives with `defaultPrevented` set and is left
 * alone; anything bound to a command belongs to the shell, enabled or not,
 * so it never falls through to the webview's own default.
 */
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  // Escape closes the find bar from anywhere, not only from its own
  // field: the reader is usually back in the text by the time they are
  // done with it.
  if (event.key === 'Escape' && workspace.find.open && !workspace.palette.open) {
    event.preventDefault();
    workspace.closeFind();
    return;
  }
  const command = registry.forEvent(event);
  if (!command) return;
  event.preventDefault();
  registry.run(command.id);
}

/**
 * Files dropped on the window. Under Tauri the webview reports the drop
 * itself with real paths (see `main.ts`); this is the same gesture in a
 * plain browser, where the OS hands over `text/uri-list`.
 */
function drop(event: DragEvent) {
  // An image dropped into the editor is already an asset by now, and
  // opening it again here would insert it twice.
  if (event.defaultPrevented) return;
  const list = event.dataTransfer?.getData('text/uri-list') ?? '';
  const paths = list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map(fileUrlToPath)
    .filter((path): path is string => path !== null);
  if (paths.length === 0) return;
  event.preventDefault();
  void workspace.openPaths(paths);
}
</script>

<!--
  Losing focus is one of the moments autosave writes (design 6.6): the
  reader has gone to the agent's window, and what it reads should be
  what they left behind. Element blur does not bubble, so this fires
  only when the window itself goes.
-->
<svelte:window onkeydown={keydown} onblur={() => void workspace.flushAutosave()} />

<div class="frame" ondragover={(event) => event.preventDefault()} ondrop={drop} role="application">
  <TabStrip {workspace} />
  <Toolbar {workspace} {registry} />
  <Banner {workspace} />
  {#if workspace.find.open}
    <FindBar {workspace} {registry} />
  {/if}
  <div class="middle">
    {#if workspace.sidebar}
      <Sidebar {workspace} />
    {/if}
    {#if workspace.activeId === null}
      <main class="page">
        <div class="blank">
          <h1>Markdown</h1>
          <p>Open a markdown file, drop one on the window, or start a new one.</p>
          <!--
            The two ways in, where a window with nothing in it can find
            them: a file to write, or a folder to work in (design 4.1).
          -->
          <button type="button" class="start" onclick={() => workspace.newUntitled()}>
            New File
          </button>
          <button
            type="button"
            class="start"
            onclick={() => void workspace.pickAndOpenFolder()}
          >
            Open Folder…
          </button>
        </div>
      </main>
    {:else if settings}
      <Settings {workspace} />
    {:else if pdf}
      <PdfPane {workspace} />
    {:else if workspace.readMode}
      <ReadPane {workspace} />
    {:else}
      <EditorPane {workspace} />
    {/if}
  </div>
  <StatusBar {workspace} />
  {#if workspace.palette.open}
    <Palette {workspace} {registry} />
  {/if}
</div>
