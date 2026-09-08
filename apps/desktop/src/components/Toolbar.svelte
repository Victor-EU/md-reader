<script lang="ts">
import { segments } from '../lib/paths.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

/** Enough of the path to place the file, with the whole of it in the tooltip. */
const DEPTH = 4;
const doc = $derived(workspace.activeDoc);
const path = $derived(doc?.path ? segments(doc.path) : []);
const crumbs = $derived(path.slice(-DEPTH));
const mode = $derived(workspace.activeTab?.mode ?? null);
// WP 1.7 fills this in; the slot is here so the toolbar does not move later.
const unreviewed = $derived(0);
</script>

<div class="bar toolbar">
  <nav class="breadcrumb" aria-label="Path" title={doc?.path ?? ''}>
    {#if doc === null}
      <span class="crumb muted">No document</span>
    {:else if crumbs.length === 0}
      <span class="crumb">{doc.untitledName}</span>
    {:else}
      {#if path.length > crumbs.length}
        <span class="crumb" aria-hidden="true">…</span>
        <span class="sep" aria-hidden="true">›</span>
      {/if}
      {#each crumbs as crumb, i (i)}
        {#if i > 0}<span class="sep" aria-hidden="true">›</span>{/if}
        <span class="crumb" class:last={i === crumbs.length - 1}>{crumb}</span>
      {/each}
    {/if}
  </nav>

  <div class="modes" role="group" aria-label="Mode">
    <button type="button" disabled title="Read mode arrives with the Read renderer (WP 1.4)">
      Read
    </button>
    <button
      type="button"
      aria-pressed={mode === 'edit'}
      disabled={doc === null}
      onclick={() => workspace.setMode('edit')}
    >
      Edit
    </button>
    <button
      type="button"
      aria-pressed={mode === 'source'}
      disabled={doc === null}
      onclick={() => workspace.setMode('source')}
    >
      Source
    </button>
  </div>

  {#if unreviewed > 0}
    <button type="button" class="changes">Changes {unreviewed}</button>
  {/if}
</div>
