<script lang="ts">
import { createEditor, type Editor } from '@mdreader/editor-core';
import { open } from '@tauri-apps/plugin-dialog';
import { onMount } from 'svelte';
import { openDocument, saveDocumentDebug } from './lib/ipc';

let host: HTMLElement;
let editor: Editor | undefined;
let path = $state<string | null>(null);
let status = $state('No file open. Press Open to pick a markdown file.');

onMount(() => {
  editor = createEditor(host, '');
  return () => editor?.destroy();
});

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
    path = doc.meta.path;
    status = `${doc.meta.byte_len} bytes`;
  } catch (e) {
    status = String(e);
  }
}

async function saveDebug() {
  if (!path || !editor) return;
  try {
    await saveDocumentDebug(path, editor.getDoc());
    status = 'Saved (debug, bytes unchanged)';
  } catch (e) {
    status = String(e);
  }
}
</script>

<div class="frame">
  <header class="bar">
    <button type="button" onclick={pickAndOpen}>Open</button>
    <button type="button" onclick={saveDebug} disabled={path === null}>Save (debug)</button>
    <span class="path">{path ?? ''}</span>
  </header>
  <main class="page" bind:this={host}></main>
  <footer class="bar status">{status}</footer>
</div>
