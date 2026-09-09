<script lang="ts">
import { describeReadOnly } from '../lib/text.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

/**
 * The one banner (design 8): why the document in front cannot be edited.
 *
 * Two files arrive read-only — one the app cannot write back, because it
 * is not UTF-8, and one it will not put in an editor, because of its size
 * (plan WP 2.7). Neither is an error, so neither is a dialog: the reader
 * asked for this file and is getting it, with a line saying what they
 * can and cannot do with it. The encoding is the one with a way out, and
 * carries it.
 */
let { workspace }: { workspace: Workspace } = $props();

const doc = $derived(workspace.activeDoc);
const meta = $derived(doc?.meta ?? null);
const reason = $derived(meta?.read_only ?? null);
</script>

{#if doc && meta && reason}
  <div class="bar notice" role="status">
    <span class="what">{describeReadOnly(reason, doc.label, meta)}</span>
    {#if reason === 'encoding'}
      <button type="button" class="fix" onclick={() => void workspace.convertToUtf8()}>
        Convert to UTF-8
      </button>
    {/if}
  </div>
{/if}
