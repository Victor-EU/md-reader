<script lang="ts">
import { untrack } from 'svelte';
import { focusScroller } from '../lib/scroller.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

let host: HTMLElement | undefined = $state();

// Read mode is its own view onto the same buffer, so it is its own mount.
// Leaving it saves the reader's place on the tab as a source offset, which
// is what lets Edit open at the same paragraph.
$effect(() => {
  const key = workspace.mountKey;
  const parent = host;
  if (!parent || key === null) return;
  untrack(() => workspace.mountRead(parent));
  // The page is the scroller, so it is what the arrow keys have to reach.
  focusScroller(parent);
  return () => untrack(() => workspace.unmountRead());
});
</script>

<main class="page page-read" tabindex="-1" bind:this={host}></main>
