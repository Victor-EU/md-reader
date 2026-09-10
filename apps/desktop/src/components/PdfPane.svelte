<script lang="ts">
import { untrack } from 'svelte';
import { focusScroller } from '../lib/scroller.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

let host: HTMLElement | undefined = $state();

/**
 * A PDF is its own view onto its own kind of file (ADR 0035), so it is
 * its own mount, on the same terms as Read mode's. Leaving it saves the
 * reader's place on the tab — the page they were on and how far down it
 * — which is what brings them back to the same page after a restart.
 *
 * The mount is async, because the file may not be open yet: a restored
 * session opens none of its PDFs until a pane asks for one.
 */
$effect(() => {
  const key = workspace.mountKey;
  const parent = host;
  if (!parent || key === null) return;
  void untrack(() => workspace.mountPdf(parent));
  // The pane is the scroller, so it is what the arrow keys have to reach.
  focusScroller(parent);
  return () => untrack(() => workspace.unmountPdf());
});

const pdf = $derived(workspace.activePdf);
</script>

<main class="page page-pdf" tabindex="-1" bind:this={host}>
  {#if pdf && pdf.failure !== null}
    <!--
      The one thing worth drawing over the pages: a file that will not
      open, said in the pane rather than only in the status bar, because
      the status bar is one line that the next thing overwrites.
    -->
    <p class="pdf-trouble">{pdf.label} could not be opened.</p>
  {/if}
</main>
