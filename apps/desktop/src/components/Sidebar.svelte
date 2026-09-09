<script lang="ts">
import type { SidebarPanel } from '@mdreader/ipc';
import type { Workspace } from '../lib/workspace.svelte.ts';
import Files from './Files.svelte';
import History from './History.svelte';
import Outline from './Outline.svelte';

let { workspace }: { workspace: Workspace } = $props();

const panel = $derived(workspace.panel);
/** The folder tree, the outline of what is open, and its versions. */
const panels: { id: SidebarPanel; title: string }[] = [
  { id: 'files', title: 'Files' },
  { id: 'outline', title: 'Outline' },
  { id: 'history', title: 'History' },
];
const title = $derived(panels.find((entry) => entry.id === panel)?.title ?? 'Files');
</script>

<aside class="sidebar" aria-label={title}>
  <div class="sidebar-head" role="tablist" aria-label="Sidebar panel">
    {#each panels as entry (entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={panel === entry.id}
        onclick={() => workspace.showPanel(entry.id)}
      >
        {entry.title}
      </button>
    {/each}
  </div>
  {#if panel === 'files'}
    <Files {workspace} />
  {:else if panel === 'outline'}
    <Outline {workspace} />
  {:else}
    <History {workspace} />
  {/if}
</aside>
