import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pastePlan } from './paste.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * The editing conveniences of design 4.5 through the shell: the inline
 * marks, what a paste turns out to be, images landing beside the
 * document, and find and replace over a mounted editor (plan WP 1.10).
 */

let host: HTMLDivElement;
let ipc: FakeIpc;
let workspace: Workspace;

const FILES = { '/a/one.md': 'One two three.\n\nFour five six.\n' };

function open(files: Record<string, string> = FILES) {
  ipc = createFakeIpc(files);
  workspace = new Workspace({ commands: ipc.commands });
}

/** Open a document in Edit mode with the editor mounted, as the pane does. */
async function edit(path = '/a/one.md') {
  await workspace.openPath(path);
  workspace.setMode('edit');
  workspace.unmount();
  workspace.mount(host);
}

function select(from: number, to: number) {
  const view = workspace.view;
  if (!view) throw new Error('nothing is mounted');
  view.dispatch({ selection: { anchor: from, head: to } });
}

const text = () => workspace.activeDoc?.text ?? '';
const at = (word: string) => text().indexOf(word);

/** A one-pixel PNG, as bytes and as the base64 a paste would carry. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function pngFile(name: string): File {
  return new File([PNG], name, { type: 'image/png' });
}

/** A `DataTransfer` as the paste handler reads one. */
function transfer(parts: { files?: File[]; html?: string; text?: string }) {
  return {
    files: parts.files ?? [],
    getData: (type: string) => (type === 'text/html' ? parts.html : parts.text) ?? '',
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  open();
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('the inline marks', () => {
  it('wraps a selection in Edit mode', async () => {
    await edit();
    select(at('two'), at('two') + 3);
    expect(workspace.bold()).toBe(true);
    expect(text()).toContain('One **two** three.');
  });

  it('wraps the word under the cursor', async () => {
    await edit();
    select(at('five') + 1, at('five') + 1);
    workspace.italic();
    expect(text()).toContain('Four *five* six.');
  });

  it('leaves the cursor in the destination of a new link', async () => {
    await edit();
    select(at('two'), at('two') + 3);
    workspace.link();
    expect(text()).toContain('One [two]() three.');
    expect(workspace.view?.state.selection.main.head).toBe(at('](') + 2);
  });

  it('works from Read mode, where there is no editor', async () => {
    await workspace.openPath('/a/one.md');
    workspace.unmount();
    workspace.mountRead(host);
    const read = workspace.readView;
    if (!read) throw new Error('Read mode is not mounted');
    // The reader's selection in the page, as Read mode reports it.
    read.sourceSelection = () => ({ from: at('two'), to: at('two') + 3 });
    expect(workspace.bold()).toBe(true);
    expect(text()).toContain('One **two** three.');
  });

  it('refuses on a read-only document and says why', async () => {
    open({ '/a/latin1.md': 'One two three.\n' });
    ipc.files.set('/a/latin1.md', {
      content: 'One two three.\n',
      format: { encoding: 'windows-1252' },
    });
    await edit('/a/latin1.md');
    select(at('two'), at('two') + 3);
    expect(workspace.bold()).toBe(false);
    expect(workspace.status).toContain('convert to UTF-8');
  });
});

describe('a document the app cannot write back', () => {
  async function latin1() {
    open({ '/a/latin1.md': 'One two three.\n' });
    ipc.files.set('/a/latin1.md', {
      content: 'One two three.\n',
      format: { encoding: 'windows-1252' },
    });
    await edit('/a/latin1.md');
  }

  it('does not take a keystroke, so there is nothing for Convert to throw away', async () => {
    await latin1();
    // The gate the editor is opened behind. Only the size ceiling used
    // to be here, so a reader could type two paragraphs into a file
    // whose every save was refused, and then lose them to the banner's
    // own Convert button.
    expect(workspace.view?.state.readOnly).toBe(true);
    expect(workspace.view?.contentDOM.isContentEditable).toBe(false);
  });

  it('still takes a write that lands on the file underneath it', async () => {
    await latin1();
    await workspace.externalChange(ipc.externalWrite('/a/latin1.md', 'Four five six.\n'));
    expect(text()).toBe('Four five six.\n');
  });

  it('takes typing again once it has been converted', async () => {
    await latin1();
    expect(await workspace.convertToUtf8()).toBe(true);
    workspace.unmount();
    workspace.mount(host);
    expect(workspace.view?.state.readOnly).toBe(false);
    expect(workspace.view?.contentDOM.isContentEditable).toBe(true);
  });
});

describe('the checkbox in Read mode', () => {
  const TASKS = { '/a/todo.md': '# Todo\n\n- [ ] one\n- [x] two\n' };

  async function read() {
    open(TASKS);
    await workspace.openPath('/a/todo.md');
    workspace.unmount();
    workspace.mountRead(host);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  function boxes(): HTMLInputElement[] {
    return [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  }

  it('is live rather than disabled', async () => {
    await read();
    expect(boxes()).toHaveLength(2);
    expect(boxes()[0]?.disabled).toBe(false);
  });

  it('ticks the box and changes one byte', async () => {
    await read();
    const before = text();
    boxes()[0]?.click();
    expect(text()).toBe('# Todo\n\n- [x] one\n- [x] two\n');
    expect(text().length).toBe(before.length);
  });

  it('unticks a ticked one', async () => {
    await read();
    boxes()[1]?.click();
    expect(text()).toBe('# Todo\n\n- [ ] one\n- [ ] two\n');
  });

  it('does not take the reader into Edit mode', async () => {
    await read();
    boxes()[0]?.click();
    expect(workspace.activeTab?.mode).toBe('read');
  });
});

describe('what a paste turns out to be', () => {
  it('is an image when the clipboard carries one', () => {
    const plan = pastePlan(
      transfer({ files: [pngFile('shot.png')], html: '<img src="x">' }),
      false,
    );
    expect(plan.kind).toBe('images');
  });

  it('is a link when a URL lands on a selection', () => {
    const plan = pastePlan(transfer({ text: 'https://example.org/a' }), true);
    expect(plan).toEqual({ kind: 'link', url: 'https://example.org/a' });
  });

  it('is plain text when the same URL lands on a cursor', () => {
    expect(pastePlan(transfer({ text: 'https://example.org/a' }), false).kind).toBe('text');
  });

  it('is markdown when the HTML holds formatting', () => {
    const plan = pastePlan(
      transfer({ html: '<p>a <b>bold</b> word</p>', text: 'a bold word' }),
      false,
    );
    expect(plan).toEqual({ kind: 'markdown', text: 'a **bold** word\n' });
  });

  /**
   * Every browser puts HTML on the clipboard even for a line of prose, so
   * a plain paste has to stay plain — otherwise the writer's own
   * asterisks come back escaped.
   */
  it('is plain text when the HTML is only a browser wrapping prose', () => {
    const plan = pastePlan(
      transfer({
        html: '<meta charset="utf-8"><span style="color:#000">a * b</span>',
        text: 'a * b',
      }),
      false,
    );
    expect(plan.kind).toBe('text');
  });

  it('is nothing at all without a clipboard', () => {
    expect(pastePlan(null, true).kind).toBe('text');
  });
});

describe('images beside the document', () => {
  it('writes a pasted image into assets and links to it', async () => {
    await edit();
    select(text().length, text().length);
    await workspace.pasteFiles([pngFile('A shot.png')]);
    expect(ipc.files.has('/a/assets/A shot.png')).toBe(true);
    expect(text()).toContain('![A shot](<assets/A shot.png>)');
    expect(workspace.status).toBe('1 image added beside the document');
  });

  it('refuses bytes that are not an image', async () => {
    await edit();
    await workspace.pasteFiles([new File(['# notes'], 'notes.png', { type: 'image/png' })]);
    expect(text()).not.toContain('![');
    expect(workspace.status).toContain('not an image');
  });

  it('has nowhere to put one until the document is saved', async () => {
    workspace.newUntitled();
    workspace.mount(host);
    await workspace.pasteFiles([pngFile('shot.png')]);
    expect(workspace.status).toContain('Save the document');
    expect(ipc.calls.some((call) => call.command === 'write_asset')).toBe(false);
  });

  it('copies a dropped image rather than opening it as a document', async () => {
    ipc.files.set('/b/dropped.png', { content: '\x89PNG\r\n\x1a\n' });
    await edit();
    await workspace.openPaths(['/b/dropped.png']);
    expect(text()).toContain('![dropped](assets/dropped.png)');
    expect(workspace.tabs).toHaveLength(1);
  });
});

describe('find and replace', () => {
  it('counts the matches and steps through them', async () => {
    await edit();
    workspace.openFind(false);
    workspace.updateFind({ query: 'e' });
    expect(workspace.matches.total).toBe(4);
    workspace.findStep(true);
    expect(workspace.matches.current).toBeGreaterThan(0);
  });

  it('starts from the selection', async () => {
    await edit();
    select(at('two'), at('two') + 3);
    workspace.openFind(false);
    expect(workspace.find.query).toBe('two');
    expect(workspace.matches.total).toBe(1);
  });

  it('replaces one match and then the rest', async () => {
    await edit();
    workspace.openFind(true);
    workspace.updateFind({ query: 'five', replacement: 'FIVE' });
    workspace.findStep(true);
    workspace.replaceOne();
    expect(text()).toContain('Four FIVE six.');
  });

  it('replaces every match at once and says how many', async () => {
    await edit();
    workspace.openFind(true);
    workspace.updateFind({ query: 'e', replacement: 'E' });
    workspace.replaceEvery();
    expect(text()).toBe('OnE two thrEE.\n\nFour fivE six.\n');
    expect(workspace.status).toBe('Replaced 4 matches');
  });

  it('searches with a regular expression when asked to', async () => {
    await edit();
    workspace.openFind(true);
    // The Aa toggle governs a regular expression too, as it does in
    // every editor: without it `[A-Z]` matches any letter.
    workspace.updateFind({
      query: '[A-Z]\\w+',
      replacement: 'X',
      regexp: true,
      caseSensitive: true,
    });
    expect(workspace.matches.total).toBe(2);
    workspace.replaceEvery();
    expect(text()).toBe('X two three.\n\nX five six.\n');
  });

  it('takes a backslash literally when the regular expression box is off', async () => {
    open({ '/a/one.md': 'a\\nb\n' });
    await edit();
    workspace.openFind(false);
    workspace.updateFind({ query: '\\n' });
    expect(workspace.matches.total).toBe(1);
  });

  it('refuses to replace in a read-only document', async () => {
    open({ '/a/latin1.md': 'One two three.\n' });
    ipc.files.set('/a/latin1.md', {
      content: 'One two three.\n',
      format: { encoding: 'windows-1252' },
    });
    await edit('/a/latin1.md');
    workspace.openFind(true);
    workspace.updateFind({ query: 'two', replacement: 'TWO' });
    expect(workspace.replaceEvery()).toBe(false);
    expect(text()).toBe('One two three.\n');
  });

  it('opening find in Read mode takes the reader into Edit mode', async () => {
    await workspace.openPath('/a/one.md');
    expect(workspace.activeTab?.mode).toBe('read');
    workspace.openFind(false);
    expect(workspace.activeTab?.mode).toBe('edit');
  });

  it('closing it puts the keyboard back in the text', async () => {
    await edit();
    workspace.openFind(false);
    workspace.updateFind({ query: 'two' });
    workspace.closeFind();
    expect(workspace.find.open).toBe(false);
    expect(workspace.find.query).toBe('two');
  });
});
