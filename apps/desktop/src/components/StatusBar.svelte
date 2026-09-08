<script lang="ts">
import { describeFormat } from '../lib/text.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const doc = $derived(workspace.activeDoc);
const mode = $derived(workspace.activeTab?.mode ?? null);
const cursor = $derived.by(() => {
  if (!doc || mode !== 'source') return null;
  const head = doc.state.selection.main.head;
  const line = doc.state.doc.lineAt(head);
  return `Ln ${line.number}, Col ${head - line.from + 1}`;
});
const format = $derived(doc?.meta ? describeFormat(doc.meta.format) : doc ? 'UTF-8 · LF' : '');
/**
 * Where the document stands with its file (design 4.1). With autosave
 * on this is the autosave state: `Unsaved changes` is the second before
 * the timer fires. With it off it is the dirty dot, and the cell beside
 * it says why nothing is happening.
 */
const saveState = $derived.by(() => {
  if (!doc) return '';
  if (workspace.saving) return 'Saving…';
  if (doc.meta?.read_only) return 'Read only';
  // A file that is gone is not "saved", however clean the buffer is.
  if (doc.missing) return 'File is gone';
  // A document with no file has nothing to be unsaved against; what it
  // has is nowhere to be, which is a different sentence.
  if (doc.path === null) return 'Not saved yet';
  return doc.dirty ? 'Unsaved changes' : 'Saved';
});
</script>

<div class="bar status">
  {#if doc}
    <span class="cell">{workspace.words} words</span>
    {#if cursor}<span class="cell">{cursor}</span>{/if}
    <span class="cell">{format}</span>
    <span class="cell" class:dirty={doc.dirty || doc.missing}>{saveState}</span>
    {#if !workspace.settings.autosave}<span class="cell">Autosave off</span>{/if}
  {/if}
  <span class="message">{workspace.status}</span>
</div>
