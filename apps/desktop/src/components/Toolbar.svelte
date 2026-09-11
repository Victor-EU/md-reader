<script lang="ts">
import { palette } from '@markdown/markdown';
import { type CommandRegistry, titleOf } from '../lib/commands.ts';
import { segments } from '../lib/paths.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';
import Icon from './Icon.svelte';
import Reading from './Reading.svelte';

let { workspace, registry }: { workspace: Workspace; registry: CommandRegistry } = $props();

/** Enough of the path to place the file, with the whole of it in the tooltip. */
const DEPTH = 4;
const doc = $derived(workspace.activeDoc);
const path = $derived(doc?.path ? segments(doc.path) : []);
/**
 * A file inside the open folder is placed from that folder down: the
 * folder is where the reader chose to work, and whatever is above it is
 * the same on every tab. Anywhere else it is the last few folders.
 */
const fromFolder = $derived.by(() => {
  const root = workspace.folder.root;
  if (root === null) return null;
  const base = segments(root);
  const inside =
    base.length > 0 && base.length < path.length && base.every((part, i) => part === path[i]);
  return inside ? path.slice(base.length - 1) : null;
});
const crumbs = $derived(fromFolder ?? path.slice(-DEPTH));
const clipped = $derived(fromFolder === null && path.length > crumbs.length);
// A tab that is not a document has no mode, whatever its tab says.
const mode = $derived(doc === null ? null : (workspace.activeTab?.mode ?? null));
/** How much of the document the reader has not marked seen (design 4.4). */
const unreviewed = $derived(workspace.unreviewed);
/** What the path says when there is no document to place. */
const nothing = $derived(workspace.activeTab?.kind === 'settings' ? 'Settings' : 'No document');

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
  <!-- The sidebar's own switch, where a Mac reader looks for one (design 2, rule 6). -->
  <button
    type="button"
    class="tool"
    aria-label="Sidebar"
    aria-pressed={workspace.sidebar}
    title={tip('view.sidebar')}
    onmousedown={hold}
    onclick={() => registry.run('view.sidebar')}
  >
    <Icon name="sidebar" />
  </button>

  <nav class="breadcrumb" aria-label="Path" title={doc?.path ?? ''}>
    {#if doc === null}
      <span class="crumb muted">{nothing}</span>
    {:else if crumbs.length === 0}
      <span class="crumb last">{doc.untitledName}</span>
    {:else}
      {#if clipped}
        <span class="crumb" aria-hidden="true">…</span>
        <span class="sep" aria-hidden="true">›</span>
      {/if}
      {#each crumbs as crumb, i (i)}
        {#if i > 0}<span class="sep" aria-hidden="true">›</span>{/if}
        <span class="crumb" class:last={i === crumbs.length - 1}>{crumb}</span>
      {/each}
    {/if}
  </nav>

  <!--
    The mode switch and the annotation tools are about a document, so a
    window without one in front — the blank window, the settings tab, a
    PDF — does not show them at all rather than showing them dead.
  -->
  {#if doc !== null}
    <div class="modes" role="group" aria-label="Mode">
      <button type="button" aria-pressed={mode === 'read'} onclick={() => workspace.setMode('read')}>
        Read
      </button>
      <button type="button" aria-pressed={mode === 'edit'} onclick={() => workspace.setMode('edit')}>
        Edit
      </button>
      <button
        type="button"
        aria-pressed={mode === 'source'}
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
        onmousedown={hold}
        onclick={() => registry.run('edit.strikethrough')}
      >
        A
      </button>
      <div class="swatches">
        {#each palette as entry (entry.meaning)}
          <button
            type="button"
            class="tool swatch"
            style="--swatch: {entry.color}"
            title={tip(`edit.color.${entry.meaning}`)}
            aria-label="Mark as {entry.title}"
            onmousedown={hold}
            onclick={() => registry.run(`edit.color.${entry.meaning}`)}
          ></button>
        {/each}
      </div>
      <button
        type="button"
        class="tool"
        title={tip('edit.comment')}
        aria-label="Add comment"
        onmousedown={hold}
        onclick={() => registry.run('edit.comment')}
      >
        <Icon name="comment" />
      </button>
    </div>
  {/if}

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
