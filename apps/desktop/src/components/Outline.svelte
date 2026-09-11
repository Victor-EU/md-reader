<script lang="ts">
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const rows = $derived(workspace.outlineRows);
/**
 * A PDF's outline is its bookmarks, which is the same idea as headings
 * and not the same word (ADR 0035). The panel says which it is looking
 * for, because "No headings" over a PDF reads as a bug.
 */
const nothing = $derived(workspace.activePdf ? 'No bookmarks' : 'No headings');
</script>

<nav class="outline">
  {#each rows as row, i (i)}
    <button
      type="button"
      class="outline-entry"
      class:top={row.level === 1}
      style="padding-left: {row.level * 12 - 4}px"
      onclick={() => workspace.goToOutline(row.target)}
    >
      {row.text || '—'}
    </button>
  {/each}
  {#if rows.length === 0}
    <p class="muted empty">{nothing}</p>
  {/if}
  {#if !workspace.outlineComplete}
    <p class="muted empty">Still reading the document…</p>
  {/if}
</nav>
