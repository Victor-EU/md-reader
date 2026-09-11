<script lang="ts">
import type { CommandRegistry } from '../lib/commands.ts';
import type { Workspace } from '../lib/workspace.svelte.ts';
import Icon from './Icon.svelte';

let { workspace, registry }: { workspace: Workspace; registry: CommandRegistry } = $props();

let field: HTMLInputElement | undefined = $state();

const find = $derived(workspace.find);
/**
 * A PDF is read here and never written (ADR 0035), so the bar drops
 * the replace row rather than offering one that refuses.
 */
const readOnly = $derived(workspace.activePdf !== null);
const matches = $derived(workspace.matches);
/**
 * Its own derivation, not `find.open`: the whole find state is replaced
 * on every keystroke, and an effect that watched it would re-select the
 * field as the query was being typed into it.
 */
const open = $derived(workspace.find.open);
/**
 * What the count says. A regular expression that will not compile is the
 * one case worth its own words: the bar is otherwise silent about why it
 * found nothing.
 */
const summary = $derived.by(() => {
  if (find.query === '') return '';
  if (find.regexp && !valid(find.query)) return 'Not a regular expression';
  if (matches.total === 0) return 'No matches';
  const total = matches.capped ? `${matches.total}+` : `${matches.total}`;
  return matches.current > 0 ? `${matches.current} of ${total}` : `${total} matches`;
});

function valid(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

// The bar opens on the field, and re-opening it selects what is there so
// the next thing typed replaces the last search rather than extending it.
$effect(() => {
  if (open && field) {
    field.focus();
    field.select();
  }
});

function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    workspace.closeFind();
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  workspace.findStep(!event.shiftKey);
}

function tip(id: string): string {
  const command = registry.get(id);
  return command.shortcut === '' ? command.title : `${command.title} (${command.shortcut})`;
}
</script>

<div class="bar find" role="search">
  <div class="rows">
    <div class="row">
      <input
        bind:this={field}
        class="field"
        type="search"
        placeholder="Find"
        aria-label="Find"
        spellcheck="false"
        autocomplete="off"
        value={find.query}
        oninput={(event) => workspace.updateFind({ query: event.currentTarget.value })}
        onkeydown={keydown}
      />
      <div class="flags" role="group" aria-label="Match">
        <button
          type="button"
          class="flag"
          aria-pressed={find.caseSensitive}
          title="Match case"
          onclick={() => workspace.updateFind({ caseSensitive: !find.caseSensitive })}
        >
          Aa
        </button>
        <button
          type="button"
          class="flag"
          aria-pressed={find.wholeWord}
          title="Whole word"
          onclick={() => workspace.updateFind({ wholeWord: !find.wholeWord })}
        >
          ab
        </button>
        <button
          type="button"
          class="flag"
          aria-pressed={find.regexp}
          title="Regular expression"
          onclick={() => workspace.updateFind({ regexp: !find.regexp })}
        >
          .*
        </button>
      </div>
      <span class="summary" aria-live="polite">{summary}</span>
      <button
        type="button"
        class="step"
        title={tip('edit.findPrevious')}
        aria-label="Previous match"
        onclick={() => workspace.findStep(false)}
      >
        <Icon name="up" />
      </button>
      <button
        type="button"
        class="step"
        title={tip('edit.findNext')}
        aria-label="Next match"
        onclick={() => workspace.findStep(true)}
      >
        <Icon name="down" />
      </button>
      {#if !readOnly}
        <button
          type="button"
          class="step"
          aria-pressed={find.replace}
          title="Replace"
          aria-label="Replace"
          onclick={() => workspace.updateFind({ replace: !find.replace })}
        >
          <Icon name="replace" />
        </button>
      {/if}
      <button
        type="button"
        class="step"
        title="Close (Esc)"
        aria-label="Close find"
        onclick={() => workspace.closeFind()}
      >
        <Icon name="close" size={14} />
      </button>
    </div>

    {#if find.replace}
      <div class="row">
        <input
          class="field"
          type="text"
          placeholder="Replace with"
          aria-label="Replace with"
          spellcheck="false"
          autocomplete="off"
          value={find.replacement}
          oninput={(event) => workspace.updateFind({ replacement: event.currentTarget.value })}
          onkeydown={keydown}
        />
        <button type="button" class="apply" onclick={() => workspace.replaceOne()}>Replace</button>
        <button type="button" class="apply" onclick={() => workspace.replaceEvery()}>
          Replace All
        </button>
      </div>
    {/if}
  </div>
</div>
