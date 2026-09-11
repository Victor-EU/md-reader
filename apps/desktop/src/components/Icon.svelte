<script lang="ts" module>
/**
 * The shell's few pictures, drawn on a 16px grid in the text's own
 * colour. Words are still the rule (build plan rule 5): an icon stands in
 * for a glyph that was already doing the job — the ×, the +, the ▸ — and
 * every control that carries one keeps its words in a title and a label.
 */
export type IconName =
  | 'chevron'
  | 'plus'
  | 'close'
  | 'file'
  | 'folder'
  | 'search'
  | 'pin'
  | 'comment'
  | 'sidebar'
  | 'up'
  | 'down'
  | 'replace';
</script>

<script lang="ts">
let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon icon-{name}"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'chevron'}
    <path d="M6.25 3.75 10.5 8l-4.25 4.25" />
  {:else if name === 'plus'}
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  {:else if name === 'close'}
    <path d="m4.25 4.25 7.5 7.5m0-7.5-7.5 7.5" />
  {:else if name === 'file'}
    <path d="M4.25 1.75h4.9l2.6 2.6v9.9h-7.5z" />
    <path d="M9 1.75V4.5h2.75M6.25 8h3.5m-3.5 2.5h2.5" />
  {:else if name === 'folder'}
    <path
      d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.5h5.6c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"
    />
  {:else if name === 'search'}
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  {:else if name === 'pin'}
    <path d="M9.75 2.25 13.75 6.25M11 3.5 8.25 6.25l-3-.25L10 10.75l-.25-3L12.5 5M7.5 8.5 3 13" />
  {:else if name === 'comment'}
    <path d="M2.75 3.25h10.5v7.25H7.5l-3 2.5v-2.5H2.75z" />
  {:else if name === 'sidebar'}
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
    <path d="M6.25 2.75v10.5" />
  {:else if name === 'up'}
    <path d="M8 12.75v-9.5M4.25 7 8 3.25 11.75 7" />
  {:else if name === 'down'}
    <path d="M8 3.25v9.5M4.25 9 8 12.75 11.75 9" />
  {:else if name === 'replace'}
    <path d="M2.75 5.5h9.5l-2.5-2.5m3.5 7.5h-9.5l2.5 2.5" />
  {/if}
</svg>
