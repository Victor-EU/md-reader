<script lang="ts">
import EditorPane from './components/EditorPane.svelte';
import FindBar from './components/FindBar.svelte';
import Palette from './components/Palette.svelte';
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

/**
 * Dress the window (design 11). Two attributes and three custom
 * properties on the root element; theme one's own stylesheet holds every
 * colour, so nothing here computes one.
 */
$effect(() => {
  applyAppearance(document.documentElement, workspace.settings, workspace.systemDark);
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
          <h1>MD Reader</h1>
          <p>Open a markdown file, drop one on the window, or start a new one.</p>
          <!--
            The window says a new file can be started here, so there is a
            way to start one. Until the sidebar arrives in Phase 2 the
            other two are Cmd+N and the command palette.
          -->
          <button type="button" class="start" onclick={() => workspace.newUntitled()}>
            New File
          </button>
        </div>
      </main>
    {:else if settings}
      <Settings {workspace} />
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
