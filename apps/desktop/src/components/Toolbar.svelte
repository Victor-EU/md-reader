<script lang="ts">
import { palette } from '@mdreader/markdown';
import { type CommandRegistry, titleOf } from '../lib/commands.ts';
import { segments } from '../lib/paths.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';
import Reading from './Reading.svelte';

let { workspace, registry }: { workspace: Workspace; registry: CommandRegistry } = $props();

/** Enough of the path to place the file, with the whole of it in the tooltip. */
const DEPTH = 4;
const doc = $derived(workspace.activeDoc);
const path = $derived(doc?.path ? segments(doc.path) : []);
const crumbs = $derived(path.slice(-DEPTH));
// A tab that is not a document has no mode, whatever its tab says.
const mode = $derived(doc === null ? null : (workspace.activeTab?.mode ?? null));
/** How much of the document the reader has not marked seen (design 4.4). */
const unreviewed = $derived(workspace.unreviewed);

/**
 * A toolbar button must not take the selection away before it acts: in
 * Read mode the selection is the browser's own, and pressing a button
 * would collapse it. Preventing the default on mousedown keeps both the
 * selection and the keyboard where they were.
 */
function hold(event: MouseEvent): void {
  event.preventDefault();
}

/** The command's own title and shortcut, so the toolbar cannot drift from the palette. */
function tip(id: string): string {
  const command = registry.get(id);
  const title = titleOf(command);
  return command.shortcut === '' ? title : `${title} (${command.shortcut})`;
}
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
    <button
      type="button"
      aria-pressed={mode === 'read'}
      disabled={doc === null}
      onclick={() => workspace.setMode('read')}
    >
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

  <div class="annotate" role="group" aria-label="Annotate">
    <button
      type="button"
      class="tool highlight"
      title={tip('edit.highlight')}
      aria-label="Highlight"
      disabled={doc === null}
      onmousedown={hold}
      onclick={() => registry.run('edit.highlight')}
    >
      A
    </button>
    <button
      type="button"
      class="tool strike"
      title={tip('edit.strikethrough')}
      aria-label="Strikethrough"
      disabled={doc === null}
      onmousedown={hold}
      onclick={() => registry.run('edit.strikethrough')}
    >
      A
    </button>
    {#each palette as entry (entry.meaning)}
      <button
        type="button"
        class="tool swatch"
        style="--swatch: {entry.color}"
        title={tip(`edit.color.${entry.meaning}`)}
        aria-label="Mark as {entry.title}"
        disabled={doc === null}
        onmousedown={hold}
        onclick={() => registry.run(`edit.color.${entry.meaning}`)}
      ></button>
    {/each}
    <button
      type="button"
      class="tool"
      title={tip('edit.comment')}
      aria-label="Add comment"
      disabled={doc === null}
      onmousedown={hold}
      onclick={() => registry.run('edit.comment')}
    >
      ✎
    </button>
  </div>

  <Reading {workspace} />

  {#if unreviewed > 0}
    <button
      type="button"
      class="changes"
      title={tip('edit.markReviewed')}
      onclick={() => registry.run('edit.markReviewed')}
    >
      Changes {unreviewed}
    </button>
  {/if}
</div>
