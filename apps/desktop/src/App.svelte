<script lang="ts">
import { createEditor, type Editor, type EditorMode } from '@mdreader/editor-core';
import { commands, type DocumentMeta, type Error as IpcError } from '@mdreader/ipc';
import { open } from '@tauri-apps/plugin-dialog';
import { onMount } from 'svelte';

let host: HTMLElement;
let editor: Editor | undefined;
let meta = $state<DocumentMeta | null>(null);
let status = $state('No file open. Press Open to pick a markdown file.');
let mode = $state<EditorMode>('edit');

onMount(() => {
  editor = createEditor(host, '');
  return () => editor?.destroy();
});

function describe(m: DocumentMeta): string {
  const f = m.format;
  const parts = [
    `${m.byte_len} bytes`,
    f.encoding,
    f.eol + (f.mixed_eol ? ' (mixed)' : ''),
    f.bom ? 'BOM' : null,
    m.read_only ? 'read-only' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function describeError(e: IpcError): string {
  switch (e.kind) {
    case 'hash_mismatch':
      return `${e.path} changed on disk; reload before saving`;
    case 'read_only_encoding':
      return `${e.path} is ${e.encoding}; convert to UTF-8 to edit`;
    case 'not_implemented':
      return `${e.command} is not implemented yet`;
    default:
      return e.message;
  }
}

async function pickAndOpen() {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (typeof picked !== 'string') return;
  const result = await commands.openDocument(picked);
  if (result.status === 'error') {
    status = describeError(result.error);
    return;
  }
  editor?.setDoc(result.data.content);
  meta = result.data.meta;
  status = describe(result.data.meta);
}

async function save() {
  if (!meta || !editor) return;
  const result = await commands.saveDocument(meta.path, editor.getDoc(), meta.hash, meta.format);
  if (result.status === 'error') {
    status = describeError(result.error);
    return;
  }
  meta = { ...meta, ...result.data };
  status = `Saved · ${describe(meta)}`;
}

async function convert() {
  if (!meta) return;
  const result = await commands.convertDocumentToUtf8(meta.path);
  if (result.status === 'error') {
    status = describeError(result.error);
    return;
  }
  editor?.setDoc(result.data.content);
  meta = result.data.meta;
  status = `Converted · ${describe(meta)}`;
}

function toggleMode() {
  mode = mode === 'edit' ? 'source' : 'edit';
  editor?.setMode(mode);
}
</script>

<div class="frame">
  <header class="bar">
    <button type="button" onclick={pickAndOpen}>Open</button>
    <button type="button" onclick={save} disabled={meta === null || meta.read_only}>Save</button>
    {#if meta?.read_only}
      <button type="button" onclick={convert}>Convert to UTF-8</button>
    {/if}
    <button type="button" onclick={toggleMode}>{mode === 'edit' ? 'Source' : 'Edit'}</button>
    <span class="path">{meta?.path ?? ''}</span>
  </header>
  <main class="page" bind:this={host}></main>
  <footer class="bar status">{status}</footer>
</div>
