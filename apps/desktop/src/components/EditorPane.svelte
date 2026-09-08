<script lang="ts">
import { untrack } from 'svelte';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

let host: HTMLElement | undefined = $state();

// One mounted view at a time: the tab in front. Switching tabs saves the
// outgoing view state onto its tab and builds the incoming one.
$effect(() => {
  const key = workspace.mountKey;
  const parent = host;
  if (!parent || key === null) return;
  untrack(() => workspace.mount(parent));
  return () => untrack(() => workspace.unmount());
});
</script>

<!-- Source mode is set in the monospace, so the pane says which it is. -->
<main class="page" class:source={workspace.activeTab?.mode === 'source'} bind:this={host}></main>
