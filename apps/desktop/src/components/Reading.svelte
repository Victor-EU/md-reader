<script lang="ts">
import type { Settings } from '@markdown/ipc';
import { MEASURE_RANGE, SIZES, zoomed } from '../lib/appearance.ts';
import { basename } from '../lib/paths.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const PAPERS = [
  { value: 'white', label: 'White' },
  { value: 'cream', label: 'Cream' },
  { value: 'pad', label: 'Pad' },
  { value: 'black', label: 'Black' },
] as const;

const FAMILIES = [
  { value: 'sans', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
] as const;

const doc = $derived(workspace.activeDoc);
/** Overrides are kept by path, so a file is what one can be kept for. */
const named = $derived(doc?.path != null);

/**
 * Which of the two the controls are writing to.
 *
 * It follows the document rather than being remembered: opening the
 * panel on a report that already has its own type should show that
 * report's, and opening it on anything else should show the app's.
 */
let mine = $state(false);
$effect(() => {
  mine = workspace.overridden;
});
const scoped = $derived(mine && named);
/**
 * What the controls show. Scoped, that is what is on the screen — the
 * app's settings with this document's on top; unscoped, it is the app's
 * own, which on a document that has been given its own is deliberately
 * not what the page is wearing. The line under the buttons says so.
 */
const shown = $derived(scoped ? workspace.applied : workspace.settings);
const smallest = $derived(shown.size <= (SIZES[0] ?? 0));
const largest = $derived(shown.size >= (SIZES.at(-1) ?? 0));

let anchor: HTMLElement | undefined = $state();
let panel: HTMLElement | undefined = $state();

// Opening it puts the keyboard in it, which is what makes Escape and Tab
// mean what they look like they mean.
$effect(() => {
  if (workspace.readingPanel) panel?.focus();
});

/** The four a document may be given, which is all this panel changes. */
type Change = Pick<Partial<Settings>, 'paper' | 'family' | 'size' | 'measure'>;

function set(change: Change): void {
  if (scoped) void workspace.setOverride(change);
  else workspace.updateSettings(change);
}

function step(by: number): void {
  const size = zoomed(shown.size, by);
  if (size !== shown.size) set({ size });
}

/**
 * A control here must not take the selection away before it acts: in
 * Read mode the selection is the browser's own, and pressing a button
 * would collapse it.
 */
function hold(event: MouseEvent): void {
  event.preventDefault();
}
</script>

<!--
  Light dismissal. A press inside the anchor is the button or the panel
  itself, and the button is what closes it; anything else is the reader
  going back to the document.
-->
<svelte:document
  onpointerdown={(event) => {
    if (!workspace.readingPanel) return;
    const target = event.target;
    if (target instanceof Node && anchor?.contains(target)) return;
    workspace.readingPanel = false;
  }}
/>

<div class="reading-anchor" bind:this={anchor}>
  <button
    type="button"
    class="tool reading-open"
    title="Reading (Mod+Shift+,)"
    aria-label="Reading settings"
    aria-haspopup="dialog"
    aria-expanded={workspace.readingPanel}
    onmousedown={hold}
    onclick={() => workspace.toggleReading()}
  >
    Aa
  </button>

  {#if workspace.readingPanel}
    <div
      class="reading-panel"
      role="dialog"
      aria-label="Reading"
      tabindex="-1"
      bind:this={panel}
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          workspace.readingPanel = false;
        }
      }}
    >
      <div class="scope" role="radiogroup" aria-label="These settings apply to">
        <button
          type="button"
          class="choice"
          role="radio"
          aria-checked={!scoped}
          onmousedown={hold}
          onclick={() => {
            mine = false;
          }}
        >
          Everywhere
        </button>
        <button
          type="button"
          class="choice"
          role="radio"
          aria-checked={scoped}
          disabled={!named}
          title={named ? doc?.path : 'Save this document first'}
          onmousedown={hold}
          onclick={() => {
            mine = true;
          }}
        >
          This document
        </button>
      </div>

      <p class="hint">
        {#if scoped}
          {basename(doc?.path ?? '')} only, kept beside the app rather than in the file.
        {:else if workspace.overridden}
          Every document except this one, which has its own.
        {:else}
          Every document that has not been given its own.
        {/if}
      </p>

      <div class="field">
        <span class="label" id="reading-paper">Paper</span>
        <div class="row" role="radiogroup" aria-labelledby="reading-paper">
          {#each PAPERS as choice (choice.value)}
            <button
              type="button"
              class="choice paper"
              role="radio"
              data-swatch={choice.value}
              aria-checked={shown.paper === choice.value}
              aria-label={choice.label}
              title={choice.label}
              onmousedown={hold}
              onclick={() => set({ paper: choice.value })}
            >
              <span class="dab" aria-hidden="true"></span>
            </button>
          {/each}
        </div>
      </div>

      <div class="field">
        <span class="label" id="reading-family">Type</span>
        <div class="row" role="radiogroup" aria-labelledby="reading-family">
          {#each FAMILIES as choice (choice.value)}
            <button
              type="button"
              class="choice"
              role="radio"
              aria-checked={shown.family === choice.value}
              onmousedown={hold}
              onclick={() => set({ family: choice.value })}
            >
              {choice.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="field">
        <span class="label" id="reading-size">Size</span>
        <div class="row" role="group" aria-labelledby="reading-size">
          <button
            type="button"
            class="choice"
            aria-label="Smaller"
            disabled={smallest}
            onmousedown={hold}
            onclick={() => step(-1)}>−</button
          >
          <span class="value">{shown.size}px</span>
          <button
            type="button"
            class="choice"
            aria-label="Larger"
            disabled={largest}
            onmousedown={hold}
            onclick={() => step(1)}>+</button
          >
        </div>
      </div>

      <div class="field">
        <label class="label" for="reading-measure">Measure</label>
        <input
          id="reading-measure"
          type="range"
          min={MEASURE_RANGE.min}
          max={MEASURE_RANGE.max}
          value={shown.measure}
          oninput={(event) => set({ measure: Number(event.currentTarget.value) })}
        />
        <span class="value">{shown.measure}</span>
      </div>

      {#if workspace.overridden}
        <div class="field">
          <button
            type="button"
            class="choice"
            onmousedown={hold}
            onclick={() => void workspace.clearOverride()}
          >
            Read it in the app’s settings
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
