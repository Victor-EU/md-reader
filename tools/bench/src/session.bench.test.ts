import type { WindowContent } from '@mdreader/ipc';
import { createFakeIpc, type FakeIpc } from '@mdreader/ipc/fake';
import { generateDocument } from '@mdreader/markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from 'vitest/browser';
// The shell the app runs, not a copy of it: what is measured here has to
// be the code that runs.
import { Workspace } from '../../../apps/desktop/src/lib/workspace.svelte.ts';

/**
 * A session of two hundred tabs (plan WP 3.3).
 *
 * The reader this is about is the one who never closes anything: a
 * fortnight of plans, transcripts and notes, still open, restored on
 * every launch. Nothing else in the harness measures that — the other
 * benches are about one large document, and the cost here is the
 * opposite shape, many documents of ordinary size.
 *
 * The two switch numbers are two different things, and they are budgeted
 * differently on purpose. Going to a tab for the first time since the
 * window opened is opening a document: nothing has read it in this
 * window yet, and design's budget for that is a tenth of a second. Going
 * back to one is a tab switch, and that has a frame.
 *
 * `calls` and `argBytes` are not times at all. Every document restored
 * is a round trip or several, and a fake resolves them in a microtask
 * while Tauri serializes both ways across a process boundary — so what
 * is asked for, and how much of it crosses, are the honest numbers here
 * and the milliseconds are a lower bound. The real ones come from the
 * app itself (plan 7.4).
 */
const TABS = 200;
/** What going back to a tab may cost. Measured at nothing at all. */
const SWITCH_BUDGET_MS = 4;
/** What going to one for the first time may cost, as an open is budgeted. */
const OPEN_BUDGET_MS = 100;
/** What putting the whole window back may cost. Measured at 150 to 190 ms. */
const RESTORE_BUDGET_MS = 600;

/**
 * A fortnight of an agent's output, as sizes: mostly notes and replies,
 * a few long transcripts, one report nobody meant to keep open.
 */
const SIZES = [4_000, 4_000, 4_000, 30_000, 4_000, 4_000, 150_000, 30_000];

const round = (n: number) => Math.round(n * 10) / 10;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

/** The files, generated once: the same body may be at more than one path. */
const bodies = new Map<number, string>();
function body(bytes: number): string {
  const made = bodies.get(bytes) ?? generateDocument(bytes, 11 + (bytes % 7));
  bodies.set(bytes, made);
  return made;
}

function files(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < TABS; i++) {
    out[`/w/notes/${String(i).padStart(3, '0')}.md`] = body(SIZES[i % SIZES.length] as number);
  }
  return out;
}

/** The session file a launch reads, for a window left with every tab open. */
function windowContent(paths: string[]): WindowContent {
  return {
    documents: paths.map((path) => ({ path, untitled: null })),
    tabs: paths.map((_path, i) => ({
      kind: 'document' as const,
      document: i,
      mode: 'read' as const,
      pinned: false,
      active: i === 0,
      selection: { anchor: 0, head: 0 },
      anchor: 0,
      folded: [],
    })),
    folder: null,
    sidebar: false,
    panel: 'outline' as const,
    comments: false,
  };
}

describe('a session of two hundred tabs', () => {
  let ipc: FakeIpc;
  let workspace: Workspace;
  const results: Record<string, unknown>[] = [];

  beforeEach(() => {
    ipc = createFakeIpc(files());
    workspace = new Workspace({ commands: ipc.commands });
  });

  afterEach(async () => {
    workspace.destroy();
    await server.commands.writeFile(
      `results/session-${server.browser}.json`,
      `${JSON.stringify({ browser: server.browser, at: new Date().toISOString(), results }, null, 2)}\n`,
    );
  });

  it(`restores, switches, serializes and closes ${TABS} tabs`, async () => {
    const paths = [...ipc.files.keys()];
    const bytes = paths.reduce((n, path) => n + (ipc.files.get(path)?.content.length ?? 0), 0);

    const t0 = performance.now();
    await workspace.restore(windowContent(paths));
    const restore = performance.now() - t0;
    expect(workspace.tabs.length).toBe(TABS);
    const calls = ipc.calls.length;
    let argBytes = 0;
    for (const call of ipc.calls) {
      for (const arg of call.args) if (typeof arg === 'string') argBytes += arg.length;
    }

    // Every tab brought to the front once, in strip order, which is what
    // a reader hunting for the one they want does with Ctrl+Tab held —
    // and then again, which is the same reader going back.
    const visit = (): number[] => {
      const took: number[] = [];
      for (const tab of [...workspace.tabs]) {
        const start = performance.now();
        workspace.activate(tab.id);
        took.push(performance.now() - start);
      }
      return took;
    };
    const first = visit();
    const again = visit();

    const t1 = performance.now();
    const payload = JSON.stringify(workspace.sessionState());
    const serialize = performance.now() - t1;

    // What the strip asks for on every draw, disambiguated across all of them.
    const t2 = performance.now();
    const labels = workspace.labels.length;
    const naming = performance.now() - t2;

    const t3 = performance.now();
    for (const tab of [...workspace.tabs]) workspace.close(tab.id);
    const close = performance.now() - t3;
    expect(workspace.tabs.length).toBe(0);

    const row = {
      tabs: TABS,
      bytes,
      restore: round(restore),
      calls,
      argBytes,
      firstP50: round(percentile(first, 0.5)),
      firstP95: round(percentile(first, 0.95)),
      firstMax: round(Math.max(...first)),
      againP50: round(percentile(again, 0.5)),
      againP95: round(percentile(again, 0.95)),
      againMax: round(Math.max(...again)),
      serialize: round(serialize),
      payloadBytes: payload.length,
      naming: round(naming),
      close: round(close),
    };
    results.push(row);
    console.log(JSON.stringify(row));
    expect(labels).toBe(TABS);
    // Two round trips a document and a handful besides, and nothing on
    // any of them but paths: no document goes back the way it came.
    expect(row.calls, 'calls to Rust').toBeLessThan(TABS * 2 + 10);
    expect(row.argBytes, 'bytes sent to Rust').toBeLessThan(TABS * 100);
    expect(row.restore, 'restoring the window').toBeLessThan(RESTORE_BUDGET_MS);
    expect(row.firstP95, 'first visit p95').toBeLessThan(OPEN_BUDGET_MS);
    expect(row.againP95, 'going back p95').toBeLessThan(SWITCH_BUDGET_MS);
    expect(row.serialize, 'serializing the session').toBeLessThan(25);
    expect(row.close, 'closing every tab').toBeLessThan(150);
  });
});
