<script lang="ts">
import { describeAgent } from '../lib/agent.ts';
import { count, describeFormat } from '../lib/text.ts';
import { describeUpdate, updateAction } from '../lib/update.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const doc = $derived(workspace.activeDoc);
const pdf = $derived(workspace.activePdf);
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
  // A conflict holds the write, whatever the buffer's state (design
  // 7.2). Saying `Unsaved changes` here would be true and useless: the
  // reader would wait for a timer that is deliberately not running.
  if (workspace.unsettled > 0) return 'Save held';
  if (doc.meta?.read_only) return 'Read only';
  // A file that is gone is not "saved", however clean the buffer is.
  if (doc.missing) return 'File is gone';
  // A document with no file has nothing to be unsaved against; what it
  // has is nowhere to be, which is a different sentence.
  if (doc.path === null) return 'Not saved yet';
  return doc.dirty ? 'Unsaved changes' : 'Saved';
});
/**
 * The updater speaks here or nowhere (plan WP 1.12). There are no
 * dialogs, and an update is never urgent enough to be one: it is a cell
 * in the status bar that says what it is and does it when pressed.
 */
const update = $derived(describeUpdate(workspace.update));
const updates = $derived(updateAction(workspace.update));
/**
 * The one thing in the bar that is waiting on the reader, so it is the
 * one cell that is a button: pressing it goes to the next conflict,
 * switching to Edit if that is where the widget is (scenario S5).
 */
const conflicts = $derived(workspace.unsettled === 0 ? '' : count(workspace.unsettled, 'conflict'));
/**
 * The agent server (design 9). A cell rather than an icon because it is
 * a fact about this window and not an alarm, and a button because the
 * one thing a reader wants from it is the configuration to paste into
 * whatever they want to connect.
 */
const agent = $derived(describeAgent(workspace.agent));
/** Where the port and the token are written, for whoever wants to know. */
const endpoint = $derived(
  workspace.agent.endpoint === null
    ? 'Copy the configuration for an agent client'
    : `Copy the configuration for an agent client · ${workspace.agent.endpoint}`,
);
</script>

<div class="bar status">
  <!--
    A PDF has none of the cells beside it: no words to count, no format
    to name, nothing unsaved. What it has is where the reader is in it
    (ADR 0035), which is the one fact this bar can tell them that the
    page itself cannot.
  -->
  {#if pdf}
    <span class="cell">
      {workspace.pdfPage > 0 ? `Page ${workspace.pdfPage} of ${pdf.pages}` : `${pdf.pages} pages`}
    </span>
    <span class="cell">{Math.round(workspace.pdfZoom * 100)}%</span>
  {/if}
  {#if doc}
    <span class="cell">{workspace.words} words</span>
    {#if cursor}<span class="cell">{cursor}</span>{/if}
    <span class="cell">{format}</span>
    <span class="cell" class:dirty={doc.dirty || doc.missing}>{saveState}</span>
    {#if conflicts !== ''}
      <button type="button" class="cell act dirty" onclick={() => workspace.stepConflict()}>
        {conflicts}
      </button>
    {/if}
    <!--
      The marks are measured against a version out of the history rather
      than against what the reader last saw, and the sidebar that says so
      can be shut (design 4.4).
    -->
    {#if workspace.comparing}
      <button type="button" class="cell act" onclick={() => void workspace.compareWith(null)}>
        Comparing
      </button>
    {/if}
    {#if !workspace.settings.autosave}<span class="cell">Autosave off</span>{/if}
  {/if}
  {#if agent !== ''}
    <button
      type="button"
      class="cell act agent"
      class:live={workspace.agent.clients > 0}
      title={endpoint}
      onclick={() => void workspace.copyAgentConfig()}
    >
      <span class="agent-dot" aria-hidden="true"></span>{agent}
    </button>
  {/if}
  <!--
    The app's only feedback channel, by design: every refusal, every
    merge and every save says so here and nowhere else (build plan rule
    5, no dialogs). Without `aria-live` a screen reader is told none of
    it, which makes the whole channel silent to the readers who have
    least other way of knowing. `polite` rather than `assertive`: these
    are reports, and they should wait for a pause rather than cut across
    what is being read.
  -->
  <span class="message" role="status" aria-live="polite">{workspace.status}</span>
  {#if update !== ''}
    {#if updates === null}
      <span class="cell update">{update}</span>
    {:else}
      <button type="button" class="cell update act" onclick={() => workspace.applyUpdate()}>
        {update}
      </button>
    {/if}
  {/if}
</div>
