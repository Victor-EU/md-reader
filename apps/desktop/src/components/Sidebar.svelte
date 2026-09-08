<script lang="ts">
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const outline = $derived(workspace.outline);
</script>

<aside class="sidebar" aria-label="Outline">
  <div class="sidebar-head">Outline</div>
  <nav class="outline">
    {#each outline as entry, i (i)}
      <button
        type="button"
        class="outline-entry"
        style="padding-left: {2 + entry.level * 10}px"
        onclick={() => workspace.goToHeading(entry)}
      >
        {entry.text || '—'}
      </button>
    {/each}
    {#if outline.length === 0}
      <p class="muted empty">No headings</p>
    {/if}
    {#if !workspace.outlineComplete}
      <p class="muted empty">Still reading the document…</p>
    {/if}
  </nav>
</aside>
