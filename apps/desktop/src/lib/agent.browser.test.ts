import { createFakeIpc, type FakeIpc } from '@markdown/ipc/fake';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClipboardWriter } from './clipboard.ts';
import { versionAuthor } from './history.ts';
import { Workspace } from './workspace.svelte.ts';

/**
 * The window's half of the MCP server (design 9, plan WP 3.1).
 *
 * The server is in Rust and four of its six tools are questions about a
 * buffer, which is not a thing Rust has. These are the answers, driven
 * the way the real ones are: through the fake's `askAgent`, which emits
 * the same event Rust emits and waits for the same `answerAgent` call.
 *
 * The fifth tool writes, and arrives here as an external change with a
 * name on it, which is what the last two tests are about.
 */

const BRIEF = `# Brief

The migration can be done in ==one sprint==<!-- rewrite: too ambitious, say two weeks -->.

Costs are unchanged.
`;

let host: HTMLDivElement;
let workspace: Workspace;
let ipc: FakeIpc;
let copied: string[] = [];

const clipboard: ClipboardWriter = {
  writeText: async (text) => {
    copied.push(text);
  },
  write: async () => {},
};

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  copied = [];
  ipc = createFakeIpc({ '/a/brief.md': BRIEF, '/a/notes.md': 'Notes.\n' });
  workspace = new Workspace({ commands: ipc.commands, clipboard });
  workspace.listenForAgents(ipc.onAgentAsk, ipc.onAgentStatus);
  await workspace.openPath('/a/brief.md');
  workspace.setMode('edit');
  workspace.mount(host);
});

afterEach(() => {
  workspace.destroy();
  host.remove();
});

describe('what the window tells an agent', () => {
  it('lists the documents it has open, and says which are ahead of disk', async () => {
    await workspace.openPath('/a/notes.md');
    workspace.setMode('edit');
    // The app remounts when the tab in front changes; a test drives it.
    workspace.unmount();
    workspace.mount(host);
    const type = workspace.view as NonNullable<typeof workspace.view>;
    type.dispatch({ changes: { from: type.state.doc.length, insert: 'And one more.\n' } });

    const answer = await ipc.askAgent({ ask: 'documents' });
    expect(answer.answer).toBe('documents');
    if (answer.answer !== 'documents') return;
    expect(answer.documents.map((doc) => doc.name)).toEqual(['brief.md', 'notes.md']);
    expect(answer.documents[0]?.dirty).toBe(false);
    expect(answer.documents[1]?.dirty).toBe(true);
    // The buffer's length in bytes, not the file's: it is the buffer the
    // other tools hand back.
    expect(answer.documents[1]?.byte_len).toBe(
      new TextEncoder().encode('Notes.\nAnd one more.\n').length,
    );
  });

  it('gives the buffer, which may be ahead of the file', async () => {
    const type = workspace.view as NonNullable<typeof workspace.view>;
    type.dispatch({ changes: { from: 0, insert: 'Typed. ' } });
    const answer = await ipc.askAgent({ ask: 'read', path: '/a/brief.md' });
    expect(answer.answer).toBe('text');
    if (answer.answer !== 'text') return;
    expect(answer.text.startsWith('Typed. # Brief')).toBe(true);
    expect(answer.dirty).toBe(true);
    expect(ipc.files.get('/a/brief.md')?.content).toBe(BRIEF);
  });

  it('turns the marks into records, with the comment as words', async () => {
    const answer = await ipc.askAgent({ ask: 'annotations', path: '/a/brief.md' });
    expect(answer.answer).toBe('annotations');
    if (answer.answer !== 'annotations') return;
    expect(answer.annotations).toHaveLength(1);
    const [found] = answer.annotations;
    expect(found?.mark).toBe('highlight');
    expect(found?.anchor).toBe('one sprint');
    expect(found?.comment).toEqual({
      kind: 'rewrite',
      text: 'too ambitious, say two weeks',
    });
  });

  it('flattens both sides for the alignment Rust does', async () => {
    const answer = await ipc.askAgent({
      ask: 'changes',
      path: '/a/brief.md',
      against: '# Brief\n\nCosts are unchanged.\n',
    });
    expect(answer.answer).toBe('changes');
    if (answer.answer !== 'changes') return;
    expect(answer.old.map((block) => block.text)).toEqual(['# Brief', 'Costs are unchanged.']);
    expect(answer.new.map((block) => block.text)).toEqual([
      '# Brief',
      'The migration can be done in ==one sprint==<!-- rewrite: too ambitious, say two weeks -->.',
      'Costs are unchanged.',
    ]);
  });

  it('opens a file it is asked to, and answers once the tab is there', async () => {
    const answer = await ipc.askAgent({ ask: 'open', path: '/a/notes.md' });
    expect(answer).toEqual({ answer: 'opened', name: 'notes.md' });
    expect(workspace.tabs.map((tab) => workspace.pathOf(tab))).toEqual([
      '/a/brief.md',
      '/a/notes.md',
    ]);
    const read = await ipc.askAgent({ ask: 'read', path: '/a/notes.md' });
    expect(read).toEqual({ answer: 'text', text: 'Notes.\n', dirty: false });
  });

  it('brings a tab it already has forward rather than opening a second one', async () => {
    await workspace.openPath('/a/notes.md');
    await workspace.openPath('/a/brief.md');
    const answer = await ipc.askAgent({ ask: 'open', path: '/a/notes.md' });
    expect(answer).toEqual({ answer: 'opened', name: 'notes.md' });
    expect(workspace.tabs).toHaveLength(2);
    expect(workspace.activeTab && workspace.pathOf(workspace.activeTab)).toBe('/a/notes.md');
  });

  it('says why a file could not be opened, rather than going quiet', async () => {
    const answer = await ipc.askAgent({ ask: 'open', path: '/a/missing.md' });
    expect(answer.answer).toBe('failed');
    expect(workspace.tabs).toHaveLength(1);
  });

  it('says so when nothing here has that document, rather than going quiet', async () => {
    const answer = await ipc.askAgent({ ask: 'read', path: '/a/elsewhere.md' });
    expect(answer.answer).toBe('failed');
    if (answer.answer !== 'failed') return;
    // The server turns this into the message the model reads, so it has
    // to name the file.
    expect(answer.message).toContain('elsewhere.md');
  });

  it('does not offer a version opened out of the history', async () => {
    // It has no file, it is never saved, and an agent given a path it
    // cannot write to would be being told something untrue (WP 2.3).
    await workspace.save();
    await workspace.refreshHistory();
    const [version] = workspace.snapshots;
    expect(version).toBeDefined();
    if (!version) return;
    await workspace.openVersion(version);
    const answer = await ipc.askAgent({ ask: 'documents' });
    if (answer.answer !== 'documents') throw new Error('expected documents');
    expect(answer.documents.map((doc) => doc.name)).toEqual(['brief.md']);
  });
});

/** How many versions the shell has asked to be taken so far. */
const snapshots = () => ipc.calls.filter((call) => call.command === 'snapshot').length;

describe('a write that came in over MCP', () => {
  const REWRITTEN = `# Brief

The migration takes two weeks.

Costs are unchanged.
`;

  it('says who wrote it, and marks what moved', async () => {
    await workspace.externalChange(ipc.agentWrite('/a/brief.md', REWRITTEN, 'claude'));
    expect(workspace.status).toBe('claude wrote brief.md · 1 change merged in');
    expect(workspace.activeDoc?.text).toBe(REWRITTEN);
    // The gutter is drawn from these, and one block moved.
    expect(workspace.activeDoc?.changes.length).toBe(1);
  });

  it('leaves the version to the write that took it, rather than a second one', async () => {
    // Rust snapshots an agent write under the agent's name as part of
    // writing it. Taking another here would put a row saying `Outside`
    // beside it, about the same bytes.
    const before = snapshots();
    await workspace.externalChange(ipc.agentWrite('/a/brief.md', REWRITTEN, 'claude'));
    expect(snapshots()).toBe(before);
  });

  it('still records a write by something that did not name itself', async () => {
    const before = snapshots();
    await workspace.externalChange(ipc.externalWrite('/a/brief.md', REWRITTEN));
    expect(workspace.status).toBe('brief.md changed on disk · 1 change merged in');
    expect(snapshots()).toBe(before + 1);
  });

  it('names the agent in the history panel', () => {
    expect(
      versionAuthor({
        id: 'v1',
        path: '/a/brief.md',
        author: 'agent',
        agent: 'claude',
        timestamp_ms: Date.now(),
        hash: 'h',
        byte_len: 10,
      }),
    ).toBe('claude');
  });
});

describe('the server as the reader sees it', () => {
  it('follows what Rust says about the connection', async () => {
    expect(workspace.agent.port).toBe(51_234);
    ipc.changeAgentStatus({ port: 51_234, endpoint: '/app-data/mcp.json', clients: 2 });
    await Promise.resolve();
    expect(workspace.agent.clients).toBe(2);
  });

  it('copies a configuration with the command in it and the token out of it', async () => {
    expect(await workspace.copyAgentConfig()).toBe(true);
    expect(copied[0]).toContain('--mcp-stdio');
    expect(copied[0]).not.toContain('token');
    expect(workspace.status).toBe('Copied the agent client configuration');
  });

  it('rotates the token without changing what a client was configured with', async () => {
    expect(await workspace.rotateAgentToken()).toBe(true);
    expect(ipc.rotations).toBe(1);
    expect(workspace.status).toContain('next connection');
  });
});
