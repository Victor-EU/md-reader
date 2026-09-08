import { createFakeIpc } from '@mdreader/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The comment toggle is a class and a stylesheet rule, so the stylesheet
// has to be in the page for the test to be about anything.
import '../app.css';
import type { ClipboardWriter } from './clipboard.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * Annotations and Copy for AI as the shell drives them (WP 1.6): the
 * commands from both views, the Read-mode comment toggle, and what
 * actually reaches the clipboard.
 */
const SAMPLE = `# Plan

The migration can be done in one sprint. <!-- note: too ambitious -->

Second paragraph of the plan.
`;

let host: HTMLDivElement;
let workspace: Workspace;
let written: { text: string; html: string | null }[] = [];

/** A clipboard that records instead of reaching the system one. */
const clipboard: ClipboardWriter = {
  writeText: async (text) => {
    written.push({ text, html: null });
  },
  write: async (items) => {
    for (const item of items) {
      written.push({
        text: await (await item.getType('text/plain')).text(),
        html: await (await item.getType('text/html')).text(),
      });
    }
  },
};

function start(files: Record<string, string>) {
  written = [];
  workspace = new Workspace({ commands: createFakeIpc(files).commands, clipboard });
}

const read = () => host.querySelector('.read') as HTMLElement;

/** Select a run of the source in Read mode, the way a reader drags over it. */
function selectInRead(word: string): void {
  const source = workspace.activeDoc?.text ?? '';
  const at = source.indexOf(word);
  const walker = document.createTreeWalker(read(), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const offset = (text.nodeValue ?? '').indexOf(word);
    if (offset === -1) continue;
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + word.length);
    const selection = getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  throw new Error(`${word} is not in the page (source offset ${at})`);
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  start({ '/a.md': SAMPLE });
});

afterEach(() => {
  workspace.destroy();
  host.remove();
  getSelection()?.removeAllRanges();
});

describe('annotating from Edit mode', () => {
  async function edit() {
    await workspace.openPath('/a.md');
    workspace.setMode('edit');
    workspace.mount(host);
  }

  it('highlights the selection and leaves the reader in Edit', async () => {
    await edit();
    const view = workspace.view as NonNullable<typeof workspace.view>;
    const at = SAMPLE.indexOf('one sprint');
    view.dispatch({ selection: { anchor: at, head: at + 'one sprint'.length } });
    expect(workspace.highlight()).toBe(true);
    expect(workspace.activeDoc?.text).toContain('done in ==one sprint==.');
    expect(workspace.activeTab?.mode).toBe('edit');
  });

  it('colours the selection and pre-fills the note', async () => {
    await edit();
    const view = workspace.view as NonNullable<typeof workspace.view>;
    const at = SAMPLE.indexOf('one sprint');
    view.dispatch({ selection: { anchor: at, head: at + 'one sprint'.length } });
    expect(workspace.color('remove')).toBe(true);
    expect(workspace.activeDoc?.text).toContain(
      '<span style="color:#dc2626">one sprint</span><!-- remove:  -->',
    );
  });

  it('puts a comment above the block when nothing is selected', async () => {
    await edit();
    const view = workspace.view as NonNullable<typeof workspace.view>;
    view.dispatch({ selection: { anchor: SAMPLE.indexOf('Second') } });
    expect(workspace.comment('note')).toBe(true);
    expect(workspace.activeDoc?.text).toContain('<!-- note:  -->\nSecond paragraph');
  });
});

describe('annotating from Read mode', () => {
  async function reading() {
    await workspace.openPath('/a.md');
    workspace.mountRead(host);
  }

  it('highlights what the reader selected and stays in Read', async () => {
    await reading();
    selectInRead('one sprint');
    expect(workspace.highlight()).toBe(true);
    expect(workspace.activeDoc?.text).toContain('done in ==one sprint==.');
    expect(workspace.activeTab?.mode).toBe('read');
  });

  it('switches to Edit for a comment, with the cursor in the note', async () => {
    await reading();
    selectInRead('one sprint');
    expect(workspace.comment('question')).toBe(true);
    expect(workspace.activeTab?.mode).toBe('edit');
    const text = workspace.activeDoc?.text ?? '';
    const at = workspace.activeTab?.selection.main.head ?? -1;
    expect(text.slice(at - 'question: '.length, at + 4)).toBe('question:  -->');
  });

  it('says so when there is nothing selected to mark', async () => {
    await reading();
    expect(workspace.highlight()).toBe(false);
    expect(workspace.status).toBe('Select the text to annotate');
  });
});

describe('the comment toggle', () => {
  it('shows the notes and folds them away again', async () => {
    await workspace.openPath('/a.md');
    workspace.mountRead(host);
    const note = read().querySelector('.mdr-comment') as HTMLElement;
    expect(note.hidden).toBe(true);
    expect(getComputedStyle(note).display).toBe('none');

    workspace.toggleComments();
    expect(read().classList.contains('mdr-show-comments')).toBe(true);
    expect(getComputedStyle(note).display).toBe('inline-flex');
    expect(note.textContent).toBe('notetoo ambitious');

    workspace.toggleComments();
    expect(getComputedStyle(note).display).toBe('none');
  });

  it('is a reading preference, so a newly mounted document keeps it', async () => {
    await workspace.openPath('/a.md');
    workspace.toggleComments();
    workspace.mountRead(host);
    expect(read().classList.contains('mdr-show-comments')).toBe(true);
  });
});

describe('the clipboard', () => {
  it('copies the source and the generated annotations for AI', async () => {
    await workspace.openPath('/a.md');
    expect(await workspace.copyForAi()).toBe(true);
    expect(written[0]?.text).toBe(
      `${SAMPLE.trimEnd()}\n\n---\nAnnotations (1):\n1. Comment — note: too ambitious\n`,
    );
    expect(workspace.status).toBe('Copied for AI · 1 annotation');
  });

  it('copies a document with no annotations as itself', async () => {
    start({ '/b.md': '# Just a title\n' });
    await workspace.openPath('/b.md');
    expect(await workspace.copyForAi()).toBe(true);
    expect(written[0]?.text).toBe('# Just a title\n');
    expect(workspace.status).toBe('Copied for AI · no annotations');
  });

  it('copies the selection as markdown, and the whole document without one', async () => {
    await workspace.openPath('/a.md');
    workspace.mountRead(host);
    selectInRead('one sprint');
    await workspace.copyMarkdown();
    expect(written[0]?.text).toBe('one sprint');
    getSelection()?.removeAllRanges();
    await workspace.copyMarkdown();
    expect(written[1]?.text).toBe(SAMPLE);
  });

  it('copies rich text as HTML with the markdown beside it', async () => {
    await workspace.openPath('/a.md');
    expect(await workspace.copyRichText()).toBe(true);
    expect(written[0]?.html).toContain('<h1 id="plan">Plan</h1>');
    expect(written[0]?.text).toBe(SAMPLE);
  });
});
