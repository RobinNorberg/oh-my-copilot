/**
 * Merge policy for `omg factory run` (owner override of design §8): merge is
 * a human step by DEFAULT. After green gates the engine asks ship's
 * decideMerge for the verdict on the current head, prints the exact admin
 * merge command, comments it on the PR and parks at `awaiting-human: merge`.
 * A later run reads `gh pr view` and finishes as `merged` once the human merged.
 *
 * Opt-in (auto-merge.ts): `factory.merge.auto` in the USER config, per
 * repository, lets the engine itself merge a low-risk PR (tiers docs, tests,
 * small) when every condition holds on the exact head; a committed value is
 * ignored with a notice. Nothing in this file runs a merge. Only the engine
 * merges: the factory guard still refuses `gh pr merge`, and admits the
 * head-pinned GitHub REST merge only inside the engine's auto-merge step.
 * Azure DevOps always stays human.
 */

import { checkName, checkText } from '../../ship/check-name.js';
import { DEFAULT_SHIP_CONFIG, type KnownFlakyTest, type ShipConfig } from '../../ship/config.js';
import type { Exec } from '../../ship/exec.js';
import { evaluateGates, NO_CI_CHECKS_NOTE, type GateHeadReads } from '../../ship/gates.js';
import { decideMerge, listChangedFiles, readCommitsSinceReview, type MergeDecision } from '../../ship/merge.js';
import { latestVerdict, type ShipState } from '../../ship/state.js';
import type { MergeView } from '../../forge/github/reviews.js';
import type { Forge } from '../../forge/types.js';
import { ADO_PIPELINE_PATHS, CI_DEFINITION_PATHS } from './lane-commit.js';
import { runLabel, type FactoryRunKey } from './state.js';

// The merge view is the GitHub forge's `gh pr view --json MERGE_VIEW_FIELDS` read.
export { MERGE_VIEW_FIELDS, parseMergeView, type MergeView } from '../../forge/github/reviews.js';

/** A merge decision; on Azure DevOps also the body file the human command reads and its SHA-256. */
export interface FactoryMergeDecision extends MergeDecision {
  body?: { file: string; sha256: string };
  /** The gate read was green with no check at all (NO_CI_CHECKS_NOTE): said in the park and the PR comment. */
  noChecks?: true;
  /** The checks that ran and SUCCEEDED on this head (auto-merge needs at least one); SKIPPED, NEUTRAL and known-flaky failures are not here. */
  checks?: string[];
  /** The checks on this head that were SKIPPED or NEUTRAL: without required checks auto-merge needs none (review-498b N6). */
  unsettled?: string[];
  /**
   * Every non-advisory check on this head whose raw state is not SUCCESS,
   * SKIPPED or NEUTRAL (a known-flaky FAILURE included), as a sanitised
   * `` `name` (STATE) `` or `` `name` (STATE, known-flaky) ``: auto-merge needs none.
   */
  blocking?: string[];
}

// The sanitiser lives in ship (src/ship/check-name.ts) so ship's own merge reasons use it too.
export { checkName } from '../../ship/check-name.js';

/**
 * ship's decideMerge on a fresh one-shot gate read for the head (no watch,
 * no rerun) and the commits since the reviewed sha. `view.baseRefOid` must be
 * in the local object store (the trusted config load fetched and checked it).
 * With an Azure DevOps `forge` the gate read goes through it, its blocking
 * branch policies are reasons too, a PR touching the Azure Pipelines
 * definitions (ADO_PIPELINE_PATHS) needs the owner as PROTECTED_PATHS do, and
 * the command is its head-pinned PATCH. `reads` are the gates loop's GitHub
 * reads (GateHeadReads), so this read applies the same no-CI, suite and app rules.
 */
export function mergeDecision(exec: Exec, root: string, ship: ShipState, view: MergeView, config: ShipConfig, known: readonly KnownFlakyTest[], forge?: Pick<Forge, 'checks' | 'reviews' | 'merge'>, reads?: GateHeadReads): FactoryMergeDecision {
  // Ship phase ready: the gates loop already waited out the settle window for this head, so this read has that history.
  const gate = evaluateGates(exec, view.number, config, known, root, view.headRefOid, forge, ship.phase === 'ready' ? 0 : undefined, Date.now, reads);
  // Raw states only: the gate's `pass` class (and its `flaky` verdict) never stands in for a SUCCESS here. Advisory checks are ignored.
  const counted = gate.checks.filter((c) => c.class !== 'advisory');
  const flaky = new Set(gate.flaky.filter((a) => a.knownFlaky).map((a) => a.check));
  const noChecks = { ...(gate.noChecks ? { noChecks: true as const } : {}), checks: counted.filter((c) => c.class === 'pass' && c.state.toUpperCase() === 'SUCCESS').map((c) => c.name),
    unsettled: counted.filter((c) => ['SKIPPED', 'NEUTRAL'].includes(c.state.toUpperCase())).map((c) => c.name),
    blocking: counted.filter((c) => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.state.toUpperCase()))
      .map((c) => `${checkName(c.name)} (${checkText(c.state.toUpperCase(), 24)}${flaky.has(c.name) ? ', known-flaky' : ''})`) };
  const reviewed = latestVerdict(ship)?.sha;
  const commits = readCommitsSinceReview(exec, root, reviewed, view.headRefOid, view.baseRefOid, ship.housekeepingCommits);
  const extraProtected = [
    ...(config.knownFlakyFile !== DEFAULT_SHIP_CONFIG.knownFlakyFile ? [config.knownFlakyFile] : []),
    ...(forge ? ADO_PIPELINE_PATHS : []),
    // The reported-checks rule (no ship.requiredChecks) trusts the forge's check list: a PR that drops a CI definition needs the owner.
    ...CI_DEFINITION_PATHS,
  ];
  const decision = decideMerge({
    state: ship, pr: view, gate, ...commits,
    changedFiles: listChangedFiles(exec, root, view.baseRefOid, view.headRefOid),
    extraProtected,
  });
  if (!forge) return { ...decision, ...noChecks };
  const reasons = [...decision.reasons, ...forge.merge.blockingPolicies(view.number, view.headRefOid).map((r) => `Azure DevOps branch policy: \`${checkText(r, 160)}\``)]; // 160: a policy reason ends with its status, which the 80-char checkName cap would cut
  const human = forge.merge.humanMerge?.(view.number, view.headRefOid);
  return {
    ok: reasons.length === 0,
    reasons,
    command: human?.command ?? forge.merge.humanMergeCommand(view.number, view.headRefOid),
    ...(human ? { body: { file: human.bodyFile, sha256: human.bodySha256 } } : {}),
    ...noChecks,
  };
}

/** The body file's lines under the command (ADO): its path and SHA-256, for the human to check before running it. */
const bodyLines = (decision: FactoryMergeDecision): string[] =>
  decision.body ? ['', `The command reads its body from \`${decision.body.file}\` (SHA-256 \`${decision.body.sha256}\`); check that file before running it.`] : [];

/** The PR comment of the merge gate: the decision and the exact command a human runs. */
export function mergeComment(issue: FactoryRunKey, decision: FactoryMergeDecision, resume = `omg factory run ${issue}`): string {
  const cmd = decision.command.join(' ');
  const label = runLabel(issue);
  return decision.ok
    ? [
      `Factory run for ${label}: independent review approved, gates are green, and \`omg ship\`'s merge rule allows this head.`,
      '',
      ...(decision.noChecks ? [`Note: ${NO_CI_CHECKS_NOTE}: nothing reported a check for this head, so no CI ran on it. Check the change yourself before you merge.`, ''] : []),
      'Merge is a human step. To merge exactly the head the gates checked:',
      '',
      '```',
      cmd,
      '```',
      ...bodyLines(decision),
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
      ...bodyLines(decision),
      '',
    ].join('\n');
}
