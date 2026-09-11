<script lang="ts">
import type { Workspace } from '../lib/workspace.svelte.ts';
import Icon from './Icon.svelte';

let { workspace }: { workspace: Workspace } = $props();

let strip: HTMLElement | undefined = $state();
let dragging: string | null = null;
/** Set when the drag ended on the strip itself, which is a reorder. */
let reordered = false;
/** Set when the reader pressed Escape while dragging (see `dragend`). */
let cancelled = false;

/** The tab in front, brought into view when the strip overflows (design 4.1). */
function reveal() {
  const id = workspace.activeId;
  if (!strip || id === null) return;
  strip
    .querySelector(`[data-tab="${id}"]`)
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

// Coming to the front is one way a tab ends up out of sight.
$effect(reveal);

/*
 * The other is the strip getting narrower under it: tabs shrink to a
 * floor and the strip scrolls from there, so a window dragged in from
 * the right can push the tab the reader is in off the end of it.
 */
$effect(() => {
  if (!strip) return;
  const observer = new ResizeObserver(() => reveal());
  observer.observe(strip);
  return () => observer.disconnect();
});

function drop(event: DragEvent, index: number) {
  event.preventDefault();
  reordered = true;
  const from = workspace.tabs.findIndex((tab) => tab.id === dragging);
  dragging = null;
  if (from !== -1) workspace.move(from, index);
}

/**
 * A tab let go of anywhere but the strip: the window under it takes it
 * in, and nothing under it tears it into a window of its own (design
 * 4.1, plan WP 2.5).
 *
 * Where it was dropped is the whole of the decision and Rust makes it,
 * from the pointer's own position: only Rust knows where the windows
 * are, and a drag that has left this window is past what the page can
 * measure — `dragend` reports the end of one only roughly.
 */
function dragend(id: string) {
  const [onStrip, escaped] = [reordered, cancelled];
  reordered = false;
  cancelled = false;
  dragging = null;
  if (onStrip || escaped) return;
  void workspace.moveTab(id, true);
}

function auxclick(event: MouseEvent, id: string) {
  if (event.button === 1) {
    event.preventDefault();
    workspace.close(id);
  }
}
</script>

<!--
  Escape during a drag cancels it, and the browser reports that as a drag
  that ended on nothing — the same thing it says about a tab dropped on
  the desktop. The key is what tells the two apart.
-->
<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && dragging !== null) cancelled = true;
  }}
/>

<!--
  The strip is the window's title bar (plan WP 2.8). Everything in it
  that is not a tab is a place to pick the window up by: the corner kept
  clear for the system's own three buttons, the gap after the last tab,
  and the strip's own background between them. `data-tauri-drag-region`
  is what Tauri reads for that, and it moves the window on a press and
  zooms it on a double-click, so neither is ours to implement.

  Bare rather than `deep`, deliberately: only a press that lands on the
  marked element itself drags, so a press on a tab, its close button or
  the new-tab button is that button's and not the window's.
-->
<div class="titlebar" class:lights={workspace.lights} data-tauri-drag-region>
  <div class="tabs" role="tablist" aria-label="Open documents" bind:this={strip}>
    {#each workspace.tabs as tab, index (tab.id)}
      {@const doc = workspace.docOf(tab)}
      <div
        class="tab"
        class:active={tab.id === workspace.activeId}
        class:pinned={tab.pinned}
        role="presentation"
        data-tab={tab.id}
        draggable="true"
        ondragstart={() => {
          dragging = tab.id;
          reordered = false;
          cancelled = false;
        }}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => drop(event, index)}
        ondragend={() => dragend(tab.id)}
        onauxclick={(event) => auxclick(event, tab.id)}
      >
        <button
          type="button"
          class="label"
          role="tab"
          aria-selected={tab.id === workspace.activeId}
          title={doc?.path ?? doc?.untitledName ?? 'Settings'}
          onclick={() => workspace.activate(tab.id)}
          ondblclick={() => workspace.togglePin(tab.id)}
        >
          {#if tab.pinned}<span class="pin" aria-hidden="true"><Icon name="pin" size={12} /></span>{/if}
          {workspace.labels[index]}
          <!-- Only a document can be unsaved, so only a document has a dot. -->
          {#if doc}<span class="dot" class:dirty={doc.dirty} aria-hidden="true">•</span>{/if}
        </button>
        <button
          type="button"
          class="close"
          aria-label={`Close ${workspace.labels[index]}`}
          onclick={() => workspace.close(tab.id)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    {/each}
  </div>
  <button
    type="button"
    class="new-tab"
    aria-label="New File"
    title="New File"
    onclick={() => workspace.newUntitled()}
  >
    <Icon name="plus" size={14} />
  </button>
  <div class="rest" data-tauri-drag-region></div>
</div>
