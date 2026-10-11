/**
 * Merge-readiness decision for `omg ship merge`. Pure: the CLI gathers the
 * PR view, a fresh gate report and the first-parent commits since the
 * reviewed sha; this module says yes or no and why.
 */

import type { GateReport } from './gates.js';
import { latestVerdict, verifyShipIntegrity, type ShipState } from './state.js';

export interface PrView {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefOid: string;
}

export interface MergeInput {
  state: ShipState;
  pr: PrView;
  gate: GateReport;
  /**
   * `git rev-list --first-parent <reviewed>..<head>`; null when the reviewed
   * sha is not an ancestor of the head (or the range could not be listed).
   */
  commitsSinceReview: string[] | null;
  /** `gh pr diff <pr> --name-only`; null when it could not be read (refused unless humanOverride). */
  changedFiles: string[] | null;
  /** OMG_SHIP_HUMAN=1: the owner accepts a PR that touches PROTECTED_PATHS. */
  humanOverride?: boolean;
  /** Extra protected files (the configured known-flaky file when it differs from the default). */
  extraProtected?: readonly string[];
}

/** Files and prefixes that steer the merge rule itself; a PR touching them needs the owner. */
export const PROTECTED_PATHS: readonly string[] = [
  '.copilot/omg.jsonc',
  '.copilot/omc.jsonc',
  '.github/known-flaky-tests.json',
  '.github/workflows/',
];

/** The changed files that hit PROTECTED_PATHS (exact file, or under a `/`-terminated prefix; case-insensitive). */
export function protectedChanges(changed: readonly string[], extra: readonly string[] = []): string[] {
  const rules = [...PROTECTED_PATHS, ...extra].map((p) => p.toLowerCase());
  return changed.filter((raw) => {
    const f = raw.replace(/\\/g, '/').trim().toLowerCase();
    return rules.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
  });
}

export interface MergeDecision {
  ok: boolean;
  reasons: string[];
  command: string[];
}

export function mergeCommand(pr: number, headSha: string): string[] {
  return ['gh', 'pr', 'merge', String(pr), '--admin', '--merge', '--match-head-commit', headSha];
}

export function decideMerge({ state, pr, gate, commitsSinceReview, changedFiles, humanOverride = false, extraProtected = [] }: MergeInput): MergeDecision {
  const reasons: string[] = [];
  if (!humanOverride) {
    if (changedFiles === null) {
      reasons.push('could not list the PR diff (gh pr diff --name-only); the protected-path check fails closed');
    } else {
      const hit = protectedChanges(changedFiles, extraProtected);
      if (hit.length > 0) reasons.push(`PR touches merge-rule files (${hit.join(', ')}); only the owner may merge it (OMG_SHIP_HUMAN=1)`);
    }
  }
  if (!verifyShipIntegrity(state)) reasons.push('ship state fails its integrity check (edited outside omg ship); re-run the workflow from omg ship init');
  if (state.phase === 'merged') reasons.push('already merged');
  if (state.phase === 'blocked') reasons.push(`run is blocked: ${state.blockedReason ?? 'see history'}`);
  if (state.phase === 'review' || state.phase === 'fix' || state.phase === 'prepare') {
    reasons.push(`phase is ${state.phase}; merge needs an approved verdict and a successful omg ship prepare`);
  }
  if (pr.state !== 'OPEN') reasons.push(`PR is ${pr.state}`);
  if (pr.isDraft) reasons.push('PR is a draft (gh pr ready first)');
  if (pr.baseRefName !== state.base) reasons.push(`PR base is ${pr.baseRefName}, ship run expects ${state.base}`);
  if (gate.verdict !== 'green') {
    const detail = [...gate.failed.map((n) => `failed: ${n}`), ...gate.pending.map((n) => `pending: ${n}`)].join('; ');
    reasons.push(`gates are ${gate.verdict}${detail ? ` (${detail})` : ''}`);
  }
  const verdict = latestVerdict(state);
  if (!verdict) {
    reasons.push('no independent verifier verdict recorded');
  } else if (verdict.verdict !== 'approve') {
    reasons.push(`latest verdict by ${verdict.reviewer} is ${verdict.verdict}`);
  } else if (verdict.reviewer.trim().toLowerCase() === state.implementer.trim().toLowerCase()) {
    reasons.push('latest approval came from the implementer (self-approval)');
  } else if (verdict.sha !== pr.headRefOid) {
    if (commitsSinceReview === null) {
      reasons.push(`reviewed sha ${verdict.sha.slice(0, 12)} is not an ancestor of head ${pr.headRefOid.slice(0, 12)}`);
    } else {
      const unreviewed = commitsSinceReview.filter((sha) => !state.housekeepingCommits.includes(sha));
      if (unreviewed.length > 0) {
        reasons.push(`commits after the reviewed sha are not ship housekeeping (re-review needed): ${unreviewed.map((s) => s.slice(0, 12)).join(', ')}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons, command: mergeCommand(pr.number, pr.headRefOid) };
}
