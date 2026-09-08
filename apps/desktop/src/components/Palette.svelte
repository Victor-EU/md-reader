<script lang="ts">
import type { Command, CommandRegistry } from '../lib/commands.ts';
import { rank } from '../lib/fuzzy.ts';
import type { FileChoice, Workspace } from '../lib/workspace.svelte.ts';

let { workspace, registry }: { workspace: Workspace; registry: CommandRegistry } = $props();

interface Row {
  key: string;
  label: string;
  detail: string;
  shortcut: string;
  enabled: boolean;
  positions: number[];
  run: () => void;
}

let input: HTMLInputElement | undefined = $state();
const palette = $derived(workspace.palette);

const rows: Row[] = $derived.by(() => {
  if (palette.kind === 'files') {
    return rank(palette.query, workspace.fileChoices(), (choice) => choice.label).map(
      ({ item, positions }: { item: FileChoice; positions: number[] }) => ({
        key: item.tabId ?? (item.path as string),
        label: item.label,
        detail: item.detail,
        shortcut: '',
        enabled: true,
        positions,
        run: () => workspace.chooseFile(item),
      }),
    );
  }
  return rank(palette.query, registry.listed(), (command) => command.title).map(
    ({ item, positions }: { item: Command; positions: number[] }) => ({
      key: item.id,
      label: item.title,
      detail: item.group,
      shortcut: item.shortcut,
      enabled: registry.isEnabled(item),
      positions,
      run: () => {
        workspace.closePalette();
        registry.run(item.id);
      },
    }),
  );
});

const index = $derived(Math.min(palette.index, Math.max(rows.length - 1, 0)));

$effect(() => {
  if (palette.open) input?.focus();
});

/** The label split into matched and unmatched runs, for highlighting. */
function parts(label: string, at: number[]): { text: string; hit: boolean }[] {
  const hits = new Set(at);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < label.length; i++) {
    const hit = hits.has(i);
    const last = out.at(-1);
    if (last && last.hit === hit) last.text += label[i];
    else out.push({ text: label[i] as string, hit });
  }
  return out;
}

function move(delta: number) {
  if (rows.length === 0) return;
  workspace.palette.index = (index + delta + rows.length) % rows.length;
}

function keydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter': {
      event.preventDefault();
      const row = rows[index];
      if (row?.enabled) row.run();
      break;
    }
    case 'Escape':
      event.preventDefault();
      workspace.closePalette();
      break;
    default:
      return;
  }
  event.stopPropagation();
}
</script>

<div
  class="palette-scrim"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) workspace.closePalette();
  }}
>
  <div class="palette">
    <input
      bind:this={input}
      class="query"
      type="text"
      autocomplete="off"
      spellcheck="false"
      placeholder={palette.kind === 'files' ? 'Go to file…' : 'Run a command…'}
      aria-label={palette.kind === 'files' ? 'Go to file' : 'Run a command'}
      value={palette.query}
      oninput={(event) => {
        workspace.palette.query = event.currentTarget.value;
        workspace.palette.index = 0;
      }}
      onkeydown={keydown}
    />
    {#if rows.length === 0}
      <p class="empty">Nothing matches</p>
    {:else}
      <ul class="rows" role="listbox" aria-label="Results">
        {#each rows.slice(0, 40) as row, i (row.key)}
          <li>
            <button
              type="button"
              class="row"
              class:selected={i === index}
              class:disabled={!row.enabled}
              role="option"
              aria-selected={i === index}
              disabled={!row.enabled}
              onclick={() => row.run()}
            >
              <span class="row-label">
                {#each parts(row.label, row.positions) as part, p (p)}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
              <span class="row-detail">{row.detail}</span>
              {#if row.shortcut}<kbd>{row.shortcut}</kbd>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
