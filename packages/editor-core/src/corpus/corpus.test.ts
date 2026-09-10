import { corpusFiles } from '@markdown/markdown';
import { describe, expect, it } from 'vitest';
import { nodeActions } from './actions.ts';
import { checkIdentity } from './invariants.ts';
import { formatFailures, runNode } from './runner.ts';

/**
 * The round-trip corpus (design section 10, plan WP 0.5), Node runner:
 * every action from the Phase 1 catalog over every corpus file, seeded.
 * A failure prints the file, the action, its seed, and the byte diff.
 */
const files = corpusFiles(200);

describe('round-trip corpus (node)', () => {
  it('has the adversarial set and the synthetic set', () => {
    expect(files.filter((f) => f.kind === 'adversarial').length).toBeGreaterThanOrEqual(30);
    expect(files.filter((f) => f.kind === 'synthetic')).toHaveLength(200);
  });

  it('invariant C: LF files load byte for byte; CRLF and BOM identity is the Rust path (WP 1.1)', () => {
    const deferred: string[] = [];
    const failures: string[] = [];
    for (const file of files) {
      const outcome = checkIdentity(file.text);
      if (outcome.ok) continue;
      if (file.text.includes('\r') || file.text.startsWith('﻿')) deferred.push(file.name);
      else failures.push(`${file.name}: ${outcome.detail}`);
    }
    expect(failures).toEqual([]);
    // A BOM survives as U+FEFF in the buffer; only CRLF is normalized by CodeMirror.
    expect(deferred.sort()).toEqual([
      'adversarial/bom-crlf.md',
      'adversarial/crlf.md',
      'adversarial/mixed-eol.md',
    ]);
  });

  // Every action over every one of the 200+ files, so these are the
  // heaviest tests in the suite: seconds on a quiet machine, and a CI
  // runner is several times slower than that. The default five is a
  // budget for a unit test, not for this.
  for (const action of nodeActions) {
    it(`invariants A and B: ${action.name}`, { timeout: 30_000 }, () => {
      const result = runNode(files, [action]);
      expect(result.failures, formatFailures(result.failures)).toEqual([]);
      expect(result.checked).toBeGreaterThan(action.minChecked ?? files.length / 4);
    });
  }
});
