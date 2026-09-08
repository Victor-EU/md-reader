import type { EditorState, Transaction } from '@codemirror/state';
import type { CorpusFile } from '@mdreader/markdown';
import type { CommandTarget } from '../preview/widgets.ts';
import type { Action, ActionPlan } from './actions.ts';
import { checkExactness, checkLocality, fullyParsed, type Outcome } from './invariants.ts';
import { mixSeed, rng } from './rng.ts';

export interface Failure {
  file: string;
  action: string;
  seed: number;
  description: string;
  reason: string;
  detail: string;
}

export interface RunResult {
  checked: number;
  skipped: number;
  failures: Failure[];
}

/** A command target over a state, for actions that need no DOM. */
export function fakeView(initial: EditorState): CommandTarget & { readonly state: EditorState } {
  let state = initial;
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
    },
  };
}

/**
 * Run one plan against a state and check invariants A and B — A alone for
 * an edit that rearranges blocks on purpose (see `ActionPlan.structural`).
 */
export function checkPlan(before: EditorState, plan: ActionPlan): Outcome {
  const view = fakeView(before);
  if (!plan.run(view))
    return { ok: false, reason: 'command', detail: 'the command returned false' };
  const exact = checkExactness(before, view.state, plan.expected);
  if (!exact.ok || plan.structural) return exact;
  return checkLocality(before, view.state, plan.span, plan.expected);
}

/**
 * Every action over every file, each with its own seed derived from the
 * run seed and the indices, so a failure is reproducible on its own.
 */
export function runNode(
  files: readonly CorpusFile[],
  actions: readonly Action[],
  seed = 1,
): RunResult {
  const result: RunResult = { checked: 0, skipped: 0, failures: [] };
  files.forEach((file, fi) => {
    const state = fullyParsed(file.text);
    actions.forEach((action, ai) => {
      const actionSeed = mixSeed(seed, fi, ai);
      const plan = action.plan(state, rng(actionSeed));
      if (!plan) {
        result.skipped++;
        return;
      }
      const outcome = checkPlan(state, plan);
      result.checked++;
      if (!outcome.ok) {
        result.failures.push({
          file: file.name,
          action: action.name,
          seed: actionSeed,
          description: plan.description,
          reason: outcome.reason,
          detail: outcome.detail,
        });
      }
    });
  });
  return result;
}

export function formatFailures(failures: readonly Failure[]): string {
  return failures
    .slice(0, 10)
    .map(
      (f) =>
        `${f.file}: ${f.action} (seed ${f.seed})\n  ${f.description}\n  ${f.reason}: ${f.detail}`,
    )
    .join('\n\n');
}
