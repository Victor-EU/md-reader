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
  /** The file this row opens, so the folder does not offer it twice. */
  path: string | null;
  run: () => void;
}

let input: HTMLInputElement | undefined = $state();
const palette = $derived(workspace.palette);

const rows: Row[] = $derived.by(() => {
  if (palette.kind === 'files') {
    // What this window already holds, ranked here: a handful of tabs and
    // recents, which are the rows the reader most often wants and which
    // should not wait for an answer from Rust.
    const near = rank(palette.query, workspace.fileChoices(), (choice) => choice.label).map(
      ({ item, positions }: { item: FileChoice; positions: number[] }) => ({
        key: item.tabId ?? (item.path as string),
        label: item.label,
        detail: item.detail,
        shortcut: '',
        enabled: true,
        positions,
        path: item.path,
        run: () => workspace.chooseFile(item),
      }),
    );
    // Then the open folder, matched in Rust over its own walk. A file
    // that is already a row above is not offered a second time.
    const open = new Set(near.map((row) => row.path).filter((path) => path !== null));
    const folder = (workspace.folderMatches?.hits ?? [])
      .filter((hit) => !open.has(hit.path))
      .map((hit) => ({
        key: hit.path,
        label: hit.name,
        detail: hit.dir,
        shortcut: '',
        enabled: true,
        positions: hit.positions,
        path: hit.path,
        run: () =>
          workspace.chooseFile({ label: hit.name, detail: hit.dir, tabId: null, path: hit.path }),
      }));
    return [...near, ...folder];
  }
  return rank(palette.query, registry.listed(), (command) => command.title).map(
    ({ item, positions }: { item: Command; positions: number[] }) => ({
      key: item.id,
      label: item.title,
      detail: item.group,
      shortcut: item.shortcut,
      enabled: registry.isEnabled(item),
      positions,
      path: null,
      run: () => {
        workspace.closePalette();
        registry.run(item.id);
      },
    }),
  );
});

/**
 * A folder so large the walk behind it stopped short. Said once, under
 * the results, because a palette that quietly cannot see a file is worse
 * than one that says which files it looked at.
 */
const walked = $derived(
  workspace.folderMatches?.truncated === true
    ? `Matched over the first ${workspace.folderMatches.files.toLocaleString()} files of this folder`
    : '',
);

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
      oninput={(event) => workspace.setPaletteQuery(event.currentTarget.value)}
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
    {#if walked !== ''}<p class="empty">{walked}</p>{/if}
  </div>
</div>
