<script lang="ts">
import { type Paper, paletteFor, paperIsDark } from '@markdown/theme';
import appIcon from '../../src-tauri/icons/128x128@2x.png';
import { MEASURE_RANGE, resolveAppearance, SIZES, THEMES } from '../lib/appearance.ts';
import { focusScroller } from '../lib/scroller.ts';
import { describeUpdate } from '../lib/update.ts';
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

/**
 * The four curated themes (design 11, plan WP 2.6), each shown as a
 * window in miniature, in the colours it would actually dress this one in.
 *
 * The colours are literal hexes out of the theme's own file rather than
 * the variables the page is using, because the point of a preview is to
 * show the theme that is not on: the variables only ever hold the one
 * that is. The page's own colours follow the paper, as the page does, so
 * the black paper shows its dark ink and code in a light window too.
 */
const appearance = $derived(resolveAppearance(settings.appearance, workspace.systemDark));
const previews = $derived(
  THEMES.map(({ id, theme }) => {
    const chrome = paletteFor(theme, appearance);
    const page = paletteFor(
      theme,
      paperIsDark(appearance, settings.paper as Paper) ? 'dark' : 'light',
    );
    const paper = chrome.papers[settings.paper];
    return {
      id,
      name: theme.name,
      description: theme.description,
      style: [
        `--p-chrome: ${chrome.ui.bg}`,
        `--p-edge: ${chrome.ui.border}`,
        `--p-paper: ${paper.bg}`,
        `--p-ink: ${paper.fg}`,
        `--p-code: ${paper.code}`,
        `--p-mark: ${page.ui.highlight}`,
        `--p-keyword: ${page.code.keyword}`,
        `--p-string: ${page.code.string}`,
        `--p-number: ${page.code.number}`,
      ].join('; '),
    };
  }),
);

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

const AUTOSAVE = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
] as const;

/** Each family with its face, so the choice shows what it chooses. */
const FAMILIES = [
  { value: 'sans', label: 'Sans', note: 'Inter', face: 'var(--family-sans)' },
  { value: 'serif', label: 'Serif', note: 'Source Serif 4', face: 'var(--family-serif)' },
  { value: 'mono', label: 'Mono', note: 'JetBrains Mono', face: 'var(--family-mono)' },
] as const;

/** What the updater has to say here, where the version is (WP 1.12). */
const update = $derived(describeUpdate(workspace.update));

/** Where the person who built this can be found. */
const LINKS = [
  { href: 'https://victorzhang.io/', label: 'victorzhang.io' },
  { href: 'https://www.linkedin.com/in/victor-yuchi-zhang/', label: 'LinkedIn' },
  { href: 'https://github.com/Victor-EU/markdown', label: 'Source' },
] as const;

/** Why it exists, in the author's words. The README carries the same. */
const THESIS = [
  'I am a big fan of the Markdown format, which John Gruber created in 2004. It is ' +
    'simple and elegant. I started using a lot of Markdown files once I began building ' +
    'with AI agents: they are perfect for ' +
    'writing designs and plans and for recording status and bugs, for me and for the ' +
    'agent alike. For now, they are the perfect human-machine interface.',
  'I used VS Code to read them, but it is too heavy and overbuilt for that, and I did ' +
    'not find anything I liked. So I built this simple viewer and editor. It also serves ' +
    'as my note taker.',
];

/**
 * A link on this page goes to the system browser like a link in Read
 * mode does (design 6.2); the webview itself never navigates away.
 */
function follow(event: MouseEvent, href: string) {
  event.preventDefault();
  workspace.openLink(href, true);
}

const smallest = $derived(settings.size <= (SIZES[0] ?? 0));
const largest = $derived(settings.size >= (SIZES.at(-1) ?? 0));

let host: HTMLElement | undefined = $state();

// This page is longer than the window and scrolls itself, so it needs the
// keyboard the same way Read mode does.
$effect(() => {
  if (host) focusScroller(host);
});
</script>

<main class="page page-settings" tabindex="-1" bind:this={host}>
  <div class="settings">
    <h1>Settings</h1>

    <section>
      <h2 id="theme-heading">Theme</h2>
      <div class="themes" role="radiogroup" aria-labelledby="theme-heading">
        {#each previews as choice (choice.id)}
          <button
            type="button"
            class="theme"
            role="radio"
            aria-checked={settings.theme === choice.id}
            title={choice.description}
            onclick={() => workspace.updateSettings({ theme: choice.id })}
          >
            <span class="preview" style={choice.style} aria-hidden="true">
              <span class="preview-bar"></span>
              <span class="preview-page">
                <span class="preview-title"></span>
                <span class="preview-text"></span>
                <span class="preview-text short"><span class="preview-mark"></span></span>
                <span class="preview-code">
                  <span class="k"></span><span class="s"></span><span class="n"></span>
                </span>
              </span>
            </span>
            <span class="theme-name">{choice.name}</span>
          </button>
        {/each}
      </div>

      <h2 id="appearance-heading">Appearance</h2>
      <div class="row segmented" role="radiogroup" aria-labelledby="appearance-heading">
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
            class="choice face"
            role="radio"
            aria-checked={settings.family === choice.value}
            onclick={() => workspace.updateSettings({ family: choice.value })}
          >
            <span class="face-sample" style="font-family: {choice.face}" aria-hidden="true">Aa</span>
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

    <section>
      <h2 id="autosave-heading">Autosave</h2>
      <p class="hint">
        On writes the file a moment after you stop typing, and again when you leave the
        document or close the window. The file is what an agent reads, so an unsaved buffer
        is work it cannot see. Off keeps the dirty dot and waits to be asked.
      </p>
      <div class="row segmented" role="radiogroup" aria-labelledby="autosave-heading">
        {#each AUTOSAVE as choice (choice.label)}
          <button
            type="button"
            class="choice"
            role="radio"
            aria-checked={settings.autosave === choice.value}
            onclick={() => workspace.setAutosave(choice.value)}
          >
            {choice.label}
          </button>
        {/each}
      </div>
    </section>

    <section class="about">
      <h2>About</h2>
      <div class="identity">
        <img src={appIcon} alt="" width="44" height="44" />
        <div>
          <p class="name">
            {#if workspace.version === ''}Markdown{:else}Markdown {workspace.version}{/if}
          </p>
          <p class="hint">A viewer and editor for the AI round trip</p>
        </div>
      </div>
      <div class="field">
        <button type="button" class="choice" onclick={() => workspace.checkForUpdates(true)}>
          Check for updates
        </button>
        {#if update !== ''}<span class="value">{update}</span>{/if}
      </div>
      <p class="maker">
        Built by Victor Zhang.
        {#each LINKS as link (link.href)}
          <a href={link.href} onclick={(event) => follow(event, link.href)}>{link.label}</a>
        {/each}
      </p>
      {#each THESIS as paragraph (paragraph)}
        <p class="thesis">{paragraph}</p>
      {/each}
    </section>

    <p class="colophon">
      Set in Inter, Source Serif 4 and JetBrains Mono, all under the SIL Open Font License.
      Third-party notices ship with the application.
    </p>
  </div>
</main>
