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
// Autosave itself arrives in WP 1.11; this is the field it will report in.
const saveState = $derived.by(() => {
  if (!doc) return '';
  if (workspace.saving) return 'Saving…';
  if (doc.meta?.read_only) return 'Read only';
  // A file that is gone is not "saved", however clean the buffer is.
  if (doc.missing) return 'File is gone';
  if (doc.dirty) return 'Unsaved changes';
  return doc.path === null ? 'Not saved yet' : 'Saved';
});
</script>

<div class="bar status">
  {#if doc}
    <span class="cell">{workspace.words} words</span>
    {#if cursor}<span class="cell">{cursor}</span>{/if}
    <span class="cell">{format}</span>
    <span class="cell" class:dirty={doc.dirty || doc.missing}>{saveState}</span>
  {/if}
  <span class="message">{workspace.status}</span>
</div>
