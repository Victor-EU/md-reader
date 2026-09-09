<script lang="ts">
import type { SnapshotInfo } from '@mdreader/ipc';
import { snapshotSize, snapshotTime, versionAuthor } from '../lib/history.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const doc = $derived(workspace.activeDoc);
const versions = $derived(workspace.snapshots);
/** The version the marks are being measured against, if it is one of these. */
const against = $derived(doc?.againstId ?? null);

/**
 * A version older than this one, which is what a comparison falls back
 * to. Shown on the row so that "Open" says what it is about to show.
 */
function previous(info: SnapshotInfo): SnapshotInfo | null {
  return versions.find((other) => other.timestamp_ms < info.timestamp_ms) ?? null;
}

function opening(info: SnapshotInfo): string {
  const base = against !== null && against !== info.id ? null : previous(info);
  const other = base ?? versions.find((v) => v.id === against) ?? null;
  return other === null
    ? `Open ${snapshotTime(info)} on its own`
    : `Open ${snapshotTime(info)}, marked against ${snapshotTime(other)}`;
}
</script>

<div class="history">
  {#if doc === null}
    <p class="muted empty">No document</p>
  {:else if doc.path === null}
    <!--
      The history is kept per path, so a buffer that has never been
      anywhere has no versions. Saying so beats an empty list.
    -->
    <p class="muted empty">Save this file to start keeping its versions</p>
  {:else if versions.length === 0}
    <p class="muted empty">No versions yet</p>
  {:else}
    {#if against !== null}
      <button type="button" class="comparing" onclick={() => void workspace.compareWith(null)}>
        Comparing · show changes since you last looked
      </button>
    {/if}
    <ul class="versions">
      {#each versions as info (info.id)}
        <li class="version" class:against={info.id === against}>
          <button
            type="button"
            class="pick"
            title="Mark what has changed since {snapshotTime(info)}"
            onclick={() => void workspace.compareWith(info)}
          >
            <span class="when">{snapshotTime(info)}</span>
            <span class="who">{versionAuthor(info)}</span>
            <span class="size">{snapshotSize(info.byte_len)}</span>
          </button>
          <div class="acts">
            <button type="button" title={opening(info)} onclick={() => void workspace.openVersion(info)}>
              Open
            </button>
            <button
              type="button"
              title="Put this version in the buffer; the one there now is kept"
              onclick={() => void workspace.restoreSnapshot(info)}
            >
              Restore
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
