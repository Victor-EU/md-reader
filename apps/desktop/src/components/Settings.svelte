<script lang="ts">
import { MEASURE_RANGE, SIZES } from '../lib/appearance.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';

let { workspace }: { workspace: Workspace } = $props();

const settings = $derived(workspace.settings);

/**
 * The page is dressed by the same settings it edits, so every choice
 * here previews itself; this specimen is only so the measure and the
 * code palette have something to be seen on.
 */
const SPECIMEN =
  'Read mode is where most time is spent, so its defaults matter more than any setting. ' +
  'The measure is the number of characters a line holds before it wraps.';

const APPEARANCES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

const PAPERS = [
  { value: 'white', label: 'White' },
  { value: 'cream', label: 'Cream' },
  { value: 'pad', label: 'Yellow pad' },
  { value: 'black', label: 'Black' },
] as const;

const FAMILIES = [
  { value: 'sans', label: 'Sans', note: 'Inter' },
  { value: 'serif', label: 'Serif', note: 'Source Serif 4' },
  { value: 'mono', label: 'Mono', note: 'JetBrains Mono' },
] as const;

const smallest = $derived(settings.size <= (SIZES[0] ?? 0));
const largest = $derived(settings.size >= (SIZES.at(-1) ?? 0));
</script>

<main class="page page-settings">
  <div class="settings">
    <h1>Settings</h1>

    <section>
      <h2 id="appearance-heading">Appearance</h2>
      <div class="row" role="radiogroup" aria-labelledby="appearance-heading">
        {#each APPEARANCES as choice (choice.value)}
          <button
            type="button"
            class="choice"
            role="radio"
            aria-checked={settings.appearance === choice.value}
            onclick={() => workspace.updateSettings({ appearance: choice.value })}
          >
            {choice.label}
          </button>
        {/each}
      </div>

      <h2 id="paper-heading">Paper</h2>
      <p class="hint">
        What the page itself is. Black is the high-contrast one and stays dark in a light window.
      </p>
      <div class="row" role="radiogroup" aria-labelledby="paper-heading">
        {#each PAPERS as choice (choice.value)}
          <button
            type="button"
            class="choice paper"
            role="radio"
            data-swatch={choice.value}
            aria-checked={settings.paper === choice.value}
            onclick={() => workspace.updateSettings({ paper: choice.value })}
          >
            <span class="dab" aria-hidden="true"></span>
            {choice.label}
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h2 id="family-heading">Type</h2>
      <div class="row" role="radiogroup" aria-labelledby="family-heading">
        {#each FAMILIES as choice (choice.value)}
          <button
            type="button"
            class="choice"
            role="radio"
            aria-checked={settings.family === choice.value}
            onclick={() => workspace.updateSettings({ family: choice.value })}
          >
            {choice.label}
            <span class="note">{choice.note}</span>
          </button>
        {/each}
      </div>

      <div class="field">
        <span class="label" id="size-label">Size</span>
        <div class="stepper" role="group" aria-labelledby="size-label">
          <button
            type="button"
            class="choice"
            aria-label="Smaller"
            disabled={smallest}
            onclick={() => workspace.zoom(-1)}>−</button
          >
          <span class="value">{settings.size}px</span>
          <button
            type="button"
            class="choice"
            aria-label="Larger"
            disabled={largest}
            onclick={() => workspace.zoom(1)}>+</button
          >
        </div>
      </div>

      <div class="field">
        <label class="label" for="measure">Measure</label>
        <input
          id="measure"
          type="range"
          min={MEASURE_RANGE.min}
          max={MEASURE_RANGE.max}
          value={settings.measure}
          oninput={(event) =>
            workspace.updateSettings({ measure: Number(event.currentTarget.value) })}
        />
        <span class="value">{settings.measure} characters</span>
      </div>
    </section>

    <section>
      <h2>Specimen</h2>
      <p class="specimen">{SPECIMEN}</p>
      <pre class="specimen-code"><code
          ><span style="color: var(--tok-keyword)">const</span> <span
            style="color: var(--tok-variable)">measure</span
          > <span style="color: var(--tok-operator)">=</span> <span style="color: var(--tok-number)"
            >{settings.measure}</span
          ><span style="color: var(--tok-punctuation)">;</span> <span
            style="color: var(--tok-comment)">// characters to the line</span
          ></code
        ></pre>
    </section>

    <p class="colophon">
      Set in Inter, Source Serif 4 and JetBrains Mono, all under the SIL Open Font License.
    </p>
  </div>
</main>
