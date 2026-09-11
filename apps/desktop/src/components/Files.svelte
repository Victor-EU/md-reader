<script lang="ts">
import { basename, dirname, shortenDir } from '../lib/paths.ts';
import type { SearchGroup } from '../lib/search.svelte.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';
import Icon from './Icon.svelte';

let { workspace }: { workspace: Workspace } = $props();

const folder = $derived(workspace.folder);
const search = $derived(workspace.search);
/** Results replace the tree while there is a search to show. */
const showing = $derived(search.showing !== '');

let field: HTMLInputElement | undefined = $state();
let naming: HTMLInputElement | undefined = $state();

/**
 * How far a row steps in per level, and where its name starts: the
 * twist, then the file or folder, then the words. The rename field is
 * put where the words were, so naming a file does not move it.
 */
const STEP = 14;
const indent = (depth: number) => 6 + depth * STEP;

/**
 * Cmd+Shift+F asks for this field. The sidebar it lives in may only be
 * arriving now, so the request is a number that goes up and the field
 * takes the keyboard whenever it does.
 */
$effect(() => {
  const asked = search.wanted;
  if (asked > 0) field?.select();
});

/** A file just made, or one being renamed, is named here and now. */
$effect(() => {
  if (folder.renaming !== null) naming?.select();
});

function typed(event: Event & { currentTarget: HTMLInputElement }) {
  search.type(event.currentTarget.value);
}

/**
 * Enter searches now rather than after the pause; Escape gives up on the
 * search and the keyboard with it. Every other key goes on to the
 * window, so Cmd+S still saves while the reader is typing in here.
 */
function searchKeys(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    void search.run();
  } else if (event.key === 'Escape') {
    search.clear();
    workspace.focusEditor();
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

function nameKeys(event: KeyboardEvent, path: string) {
  if (event.key === 'Enter') {
    void workspace.renameInFolder(path, (event.currentTarget as HTMLInputElement).value);
  } else if (event.key === 'Escape') {
    folder.renaming = null;
  } else {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}

/**
 * How much of a line the panel keeps in front of the match. A result row
 * is about as wide as this; a match further along the line than this
 * would be cut off the end of the row by the ellipsis, so the front of
 * the line is what gives way instead. Rust has already done the same for
 * a line long enough to be worth not sending.
 */
const LEAD = 16;

/** The line of a result, split around what matched. */
function parts(group: SearchGroup, at: number): { text: string; hit: boolean }[] {
  const hit = group.hits[at];
  if (!hit) return [];
  const cut = hit.from > LEAD ? hit.from - LEAD : 0;
  const head = cut > 0 ? `…${hit.text.slice(cut, hit.from)}` : hit.text.slice(0, hit.from);
  return [
    { text: head, hit: false },
    { text: hit.text.slice(hit.from, hit.to), hit: true },
    { text: hit.text.slice(hit.to), hit: false },
  ].filter((part) => part.text !== '');
}

const summary = $derived.by(() => {
  if (search.running && search.found === 0) return 'Searching…';
  if (search.found === 0) return `Nothing matches ${search.showing}`;
  const files = search.groups.length;
  const said = `${search.found} in ${files} file${files === 1 ? '' : 's'}`;
  if (search.truncated) return `First ${said}`;
  return search.running ? `${said}…` : said;
});
</script>

<div class="files">
  {#if folder.root === null}
    <!--
      No folder: the recent files, which is what the sidebar shows
      instead of a tree (design 4.1).
    -->
    <div class="folder-head">
      <span class="folder-name">Recent</span>
      <button
        type="button"
        class="act"
        title="Open a folder to work in"
        onclick={() => void workspace.pickAndOpenFolder()}
      >
        Open Folder…
      </button>
    </div>
    {#if workspace.recents.length === 0}
      <p class="muted empty">No recent files</p>
    {:else}
      <nav class="tree">
        {#each workspace.recents.slice(0, 20) as path (path)}
          <button
            type="button"
            class="row"
            title={path}
            onclick={() => void workspace.openPath(path)}
          >
            <span class="kind"><Icon name="file" size={14} /></span>
            <span class="row-name">{basename(path)}</span>
            <span class="row-where">{shortenDir(dirname(path), 1)}</span>
          </button>
        {/each}
      </nav>
    {/if}
  {:else}
    <div class="folder-head">
      <span class="folder-name" title={folder.root}>{folder.name}</span>
      <button
        type="button"
        class="act icon"
        title="New file in the selected folder"
        aria-label="New file in the selected folder"
        onclick={() => void workspace.newFileInFolder()}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        type="button"
        class="act icon"
        title="Close this folder"
        aria-label="Close this folder"
        onclick={() => workspace.closeFolder()}
      >
        <Icon name="close" size={13} />
      </button>
    </div>
    <div class="find-in-folder">
      <label class="search-field">
        <Icon name="search" size={13} />
        <input
          bind:this={field}
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Find in folder"
          aria-label="Find in folder"
          value={search.query}
          oninput={typed}
          onkeydown={searchKeys}
        />
      </label>
      <button
        type="button"
        class="flag"
        aria-pressed={search.caseSensitive}
        title="Match case"
        onclick={() => search.flag({ caseSensitive: !search.caseSensitive })}
      >
        Aa
      </button>
      <button
        type="button"
        class="flag"
        aria-pressed={search.regex}
        title="Regular expression"
        onclick={() => search.flag({ regex: !search.regex })}
      >
        .*
      </button>
    </div>
    {#if showing}
      <p class="muted empty">{summary}</p>
      <div class="results">
        {#each search.groups as group (group.path)}
          <p class="result-file" title={group.path}>
            <span class="row-name">{group.name}</span>
            <span class="row-where">{group.dir}</span>
          </p>
          {#each group.hits as hit, i (`${hit.line}:${hit.column}`)}
            <button type="button" class="result" onclick={() => void workspace.openHit(hit)}>
              <span class="line">{hit.line}</span>
              <span class="text">
                {#each parts(group, i) as part, p (p)}
                  {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            </button>
          {/each}
        {/each}
      </div>
    {:else if folder.rows.length === 0}
      <p class="muted empty">This folder is empty</p>
    {:else}
      <nav class="tree">
        {#each folder.rows as row (row.path)}
          {#if folder.renaming === row.path}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              bind:this={naming}
              class="naming"
              style="margin-left: {indent(row.depth) + 30}px"
              type="text"
              autocomplete="off"
              spellcheck="false"
              aria-label="File name"
              value={row.name}
              onkeydown={(event) => nameKeys(event, row.path)}
              onblur={(event) => {
                // Enter and Escape have both already put the field away,
                // so a blur that follows one of them is the field being
                // removed and not the reader clicking off it.
                if (folder.renaming === row.path) {
                  void workspace.renameInFolder(row.path, event.currentTarget.value);
                }
              }}
            />
          {:else}
            <button
              type="button"
              class="row"
              class:dir={row.isDir}
              class:selected={folder.selected === row.path}
              style="padding-left: {indent(row.depth)}px"
              title={row.path}
              aria-expanded={row.isDir ? row.expanded : undefined}
              onclick={() =>
                row.isDir ? void folder.toggle(row.path) : void workspace.openFile(row.path)}
              ondblclick={() => {
                if (!row.isDir) folder.renaming = row.path;
              }}
            >
              <span class="twist" class:open={row.isDir && row.expanded}>
                {#if row.isDir}<Icon name="chevron" size={12} />{/if}
              </span>
              <span class="kind"><Icon name={row.isDir ? 'folder' : 'file'} size={14} /></span>
              <span class="row-name">{row.name}</span>
            </button>
          {/if}
        {/each}
      </nav>
    {/if}
  {/if}
</div>
