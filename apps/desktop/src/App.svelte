<script lang="ts">
import EditorPane from './components/EditorPane.svelte';
import Palette from './components/Palette.svelte';
import ReadPane from './components/ReadPane.svelte';
import Sidebar from './components/Sidebar.svelte';
import StatusBar from './components/StatusBar.svelte';
import TabStrip from './components/TabStrip.svelte';
import Toolbar from './components/Toolbar.svelte';
import { fileUrlToPath } from './lib/paths.ts';
import type { Shell } from './lib/shell.svelte.ts';

let { shell }: { shell: Shell } = $props();
const workspace = $derived(shell.workspace);
const registry = $derived(shell.registry);

/**
 * The whole keymap, derived from the command registry. A key the editor
 * has already handled arrives with `defaultPrevented` set and is left
 * alone; anything bound to a command belongs to the shell, enabled or not,
 * so it never falls through to the webview's own default.
 */
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
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

<svelte:window onkeydown={keydown} />

<div class="frame" ondragover={(event) => event.preventDefault()} ondrop={drop} role="application">
  <TabStrip {workspace} />
  <Toolbar {workspace} {registry} />
  <div class="middle">
    {#if workspace.sidebar}
      <Sidebar {workspace} />
    {/if}
    {#if workspace.activeId === null}
      <main class="page">
        <div class="blank">
          <h1>MD Reader</h1>
          <p>Open a markdown file, drop one on the window, or start a new one.</p>
        </div>
      </main>
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
