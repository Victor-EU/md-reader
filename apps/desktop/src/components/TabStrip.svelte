<script lang="ts">
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

let strip: HTMLElement | undefined = $state();
let dragging: string | null = null;

// The active tab is kept visible when the strip overflows (design 4.1).
$effect(() => {
  const id = workspace.activeId;
  if (!strip || id === null) return;
  strip
    .querySelector(`[data-tab="${id}"]`)
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
});

function drop(event: DragEvent, index: number) {
  event.preventDefault();
  const from = workspace.tabs.findIndex((tab) => tab.id === dragging);
  dragging = null;
  if (from !== -1) workspace.move(from, index);
}

function auxclick(event: MouseEvent, id: string) {
  if (event.button === 1) {
    event.preventDefault();
    workspace.close(id);
  }
}
</script>

<div class="tabs" role="tablist" aria-label="Open documents" bind:this={strip}>
  {#each workspace.tabs as tab, index (tab.id)}
    {@const doc = workspace.doc(tab)}
    <div
      class="tab"
      class:active={tab.id === workspace.activeId}
      class:pinned={tab.pinned}
      role="presentation"
      data-tab={tab.id}
      draggable="true"
      ondragstart={() => {
        dragging = tab.id;
      }}
      ondragover={(event) => event.preventDefault()}
      ondrop={(event) => drop(event, index)}
      onauxclick={(event) => auxclick(event, tab.id)}
    >
      <button
        type="button"
        class="label"
        role="tab"
        aria-selected={tab.id === workspace.activeId}
        title={doc.path ?? doc.untitledName}
        onclick={() => workspace.activate(tab.id)}
        ondblclick={() => workspace.togglePin(tab.id)}
      >
        {#if tab.pinned}<span class="pin" aria-hidden="true">▪</span>{/if}
        {workspace.labels[index]}
        <span class="dot" class:dirty={doc.dirty} aria-hidden="true">•</span>
      </button>
      <button
        type="button"
        class="close"
        aria-label={`Close ${workspace.labels[index]}`}
        onclick={() => workspace.close(tab.id)}
      >
        ×
      </button>
    </div>
  {/each}
</div>
