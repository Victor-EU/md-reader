<script lang="ts">
import type { Workspace } from '../lib/workspace.svelte.ts';
import History from './History.svelte';
import Outline from './Outline.svelte';

let { workspace }: { workspace: Workspace } = $props();

const panel = $derived(workspace.panel);
</script>

<aside class="sidebar" aria-label={panel === 'outline' ? 'Outline' : 'History'}>
  <div class="sidebar-head" role="tablist" aria-label="Sidebar panel">
    <button
      type="button"
      role="tab"
      aria-selected={panel === 'outline'}
      onclick={() => workspace.showPanel('outline')}
    >
      Outline
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={panel === 'history'}
      onclick={() => workspace.showPanel('history')}
    >
      History
    </button>
  </div>
  {#if panel === 'outline'}
    <Outline {workspace} />
  {:else}
    <History {workspace} />
  {/if}
</aside>
