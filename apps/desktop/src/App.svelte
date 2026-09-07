<script lang="ts">
import { createEditor, type Editor, type EditorMode } from '@mdreader/editor-core';
import { open } from '@tauri-apps/plugin-dialog';
import { onMount } from 'svelte';
import {
  convertDocumentToUtf8,
  type DocumentMeta,
  describeError,
  openDocument,
  saveDocument,
} from './lib/ipc';

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

async function pickAndOpen() {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (typeof picked !== 'string') return;
  try {
    const doc = await openDocument(picked);
    editor?.setDoc(doc.content);
    meta = doc.meta;
    status = describe(doc.meta);
  } catch (e) {
    status = describeError(e);
  }
}

async function save() {
  if (!meta || !editor) return;
  try {
    const result = await saveDocument(meta.path, editor.getDoc(), meta.hash, meta.format);
    meta = {
      ...meta,
      hash: result.hash,
      byte_len: result.byte_len,
      modified_ms: result.modified_ms,
    };
    status = `Saved · ${describe(meta)}`;
  } catch (e) {
    status = describeError(e);
  }
}

async function convert() {
  if (!meta) return;
  try {
    const doc = await convertDocumentToUtf8(meta.path);
    editor?.setDoc(doc.content);
    meta = doc.meta;
    status = `Converted · ${describe(doc.meta)}`;
  } catch (e) {
    status = describeError(e);
  }
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
