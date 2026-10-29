/**
 * Merge policy for `omg factory run` (owner override of design §8): merge is
 * ALWAYS human. There is no `factory.merge` key and no auto mode, and nothing
 * here runs a merge (the factory guard refuses `gh pr merge` outright). After
 * green gates the engine asks ship's decideMerge for the verdict on the
 * current head, prints the exact admin merge command, comments it on the PR
 * and parks at `awaiting-human: merge`. A later run reads `gh pr view` and
 * finishes as `merged` once the human merged.
 */

import { DEFAULT_SHIP_CONFIG, type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { evaluateGates } from '../../ship/gates.js';
import { decideMerge, listChangedFiles, readCommitsSinceReview, type MergeDecision } from '../../ship/merge.js';
import { latestVerdict, type ShipState } from '../../ship/state.js';
import type { MergeView } from '../../forge/github/reviews.js';
import { runLabel, type FactoryRunKey } from './state.js';

// The merge view is the GitHub forge's `gh pr view --json MERGE_VIEW_FIELDS` read.
export { MERGE_VIEW_FIELDS, parseMergeView, type MergeView } from '../../forge/github/reviews.js';

/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 */
export function mergeDecision(exec: Exec, root: string, ship: ShipState, view: MergeView, config: ShipConfig, known: readonly KnownFlakyTest[]): MergeDecision {
  const gate = evaluateGates(exec, view.number, config, known, root, view.headRefOid);
  const reviewed = latestVerdict(ship)?.sha;
  const commits = readCommitsSinceReview(exec, root, reviewed, view.headRefOid, view.baseRefOid, ship.housekeepingCommits);
  const extraProtected = config.knownFlakyFile !== DEFAULT_SHIP_CONFIG.knownFlakyFile ? [config.knownFlakyFile] : [];
  return decideMerge({
    state: ship, pr: view, gate, ...commits,
    changedFiles: listChangedFiles(exec, root, view.baseRefOid, view.headRefOid),
    extraProtected,
  });
}

/** The PR comment of the merge gate: the decision and the exact command a human runs. */
export function mergeComment(issue: FactoryRunKey, decision: MergeDecision, resume = `omg factory run ${issue}`): string {
  const cmd = decision.command.join(' ');
  const label = runLabel(issue);
  return decision.ok
    ? [
      `Factory run for ${label}: independent review approved, gates are green, and \`omg ship\`'s merge rule allows this head.`,
      '',
      'Merge is a human step. To merge exactly the head the gates checked:',
      '',
      '```',
      cmd,
      '```',
      '',
      `Then run \`${resume}\` to finish the run as merged.`,
      '',
    ].join('\n')
    : [
      `Factory run for ${label}: \`omg ship\`'s merge rule refuses this head:`,
      '',
      ...decision.reasons.map((r) => `- ${r}`),
      '',
      `Resolve it, then rerun \`${resume}\`. The command the rule would allow is \`${cmd}\`.`,
      '',
    ].join('\n');
}
