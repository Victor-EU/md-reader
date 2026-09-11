<script lang="ts">
import { tick, untrack } from 'svelte';
import type { Doc } from '../lib/document.svelte.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

/**
 * The document's name at the end of the path, and the place to change
 * it (ADR 0037): click it and it is a field, in the same place and at
 * the same size, so the name does not move as it becomes editable.
 */
let { workspace, doc }: { workspace: Workspace; doc: Doc } = $props();

let field: HTMLInputElement | undefined = $state();
let naming = $state(false);
/** What the field says, for the invisible copy of it that sizes the field. */
let typed = $state('');

/** A view of a past version has a name, but not one there is anything to rename. */
const fixed = $derived(doc.ephemeral);

async function start(): Promise<void> {
  if (fixed || naming) return;
  typed = doc.label;
  naming = true;
  await tick();
  if (!field) return;
  field.focus();
  // Finder's selection: the name and not its extension, so typing over
  // it renames the file without changing what kind of file it is.
  const dot = doc.path === null ? -1 : typed.lastIndexOf('.');
  field.setSelectionRange(0, dot > 0 ? dot : typed.length);
}

/** Put the field away, with what it says or without. */
function finish(keep: boolean): void {
  if (!naming) return;
  naming = false;
  if (keep) void workspace.renameDoc(doc, field?.value ?? typed);
}

function keys(event: KeyboardEvent): void {
  // The Enter that picks a word in an input method belongs to the input
  // method. WebKit reports it as key 229 rather than as composing.
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') finish(true);
  else if (event.key === 'Escape') finish(false);
  else return;
  event.preventDefault();
  event.stopPropagation();
  workspace.focusEditor();
}

/**
 * Clicking anywhere else keeps the name, as it does in Finder. Going to
 * another app does not: the field is still here, and still has the
 * keyboard, when the reader comes back.
 */
function left(): void {
  if (document.hasFocus()) finish(true);
}

// Rename… from the menu or the palette asks for the field by counting up.
let answered = untrack(() => workspace.renameAsked);
$effect(() => {
  const asked = workspace.renameAsked;
  if (asked === answered) return;
  answered = asked;
  void start();
});

// A field still open when its document leaves the front, as it does when
// a tab is switched from the keyboard, is kept the way a click away is.
$effect(() => () => finish(true));
</script>

{#if naming}
  <span class="title naming" data-typed={typed}>
    <input
      bind:this={field}
      bind:value={typed}
      class="name-field"
      type="text"
      size="1"
      autocomplete="off"
      spellcheck="false"
      aria-label="Name"
      onkeydown={keys}
      onblur={left}
    />
  </span>
{:else if fixed}
  <span class="crumb last">{doc.label}</span>
{:else}
  <button
    type="button"
    class="crumb last title"
    aria-label="Rename {doc.label}"
    onclick={() => void start()}
  >
    {doc.label}
  </button>
{/if}
