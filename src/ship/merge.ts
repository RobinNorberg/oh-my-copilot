/**
 * Merge-readiness decision for `omg ship merge`. decideMerge is pure: the CLI
 * gathers the PR view, a fresh gate report, the changed files
 * (listChangedFiles) and the first-parent commits since the reviewed sha
 * with their parents (readCommitsSinceReview);
 * this module says yes or no and why.
 */

import { TRUSTED_READ_ENV, type Exec } from './exec.js';
import type { GateReport } from './gates.js';
import { latestVerdict, verifyShipIntegrity, type ShipState } from './state.js';

/**
 * The PR's changed files, computed locally between GitHub's base and head
 * shas: `git diff --name-only --no-renames -z <base>...<head>` with replace
 * refs off. `--no-renames` lists a rename as its old and new path (a rename
 * out of `.github/workflows/` still names the workflow), `-z` prints paths
 * unquoted (non-ASCII names intact), and there is no 300-file cap as with
 * `gh pr diff`. Null on any failure (fail closed).
 */
export function listChangedFiles(exec: Exec, cwd: string, baseSha: string, headSha: string): string[] | null {
  if (!/^[0-9a-f]{40}$/.test(baseSha) || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  const res = exec('git', ['diff', '--name-only', '--no-renames', '-z', `${baseSha}...${headSha}`], { cwd, env: TRUSTED_READ_ENV });
  return res.status === 0 ? res.stdout.split('\0').filter((f) => f.length > 0) : null;
}

export interface CommitParents {
  sha: string;
  parents: string[];
}

/** `git rev-list --parents` output (`<sha> <parent>...` per line); null on a malformed line. */
export function parseCommitParents(stdout: string): CommitParents[] | null {
  const out: CommitParents[] = [];
  for (const line of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [sha, ...parents] = line.split(/\s+/);
    if (![sha, ...parents].every((s) => /^[0-9a-f]{40}$/.test(s))) return null;
    out.push({ sha, parents });
  }
  return out;
}

const HOUSEKEEPING_DIR = 'inventory/';

/** `git diff --name-only --no-renames -z <from> <to>` paths outside inventory/; null when the diff fails. */
function outsideInventory(exec: Exec, cwd: string, from: string, to: string): string[] | null {
  const res = exec('git', ['diff', '--name-only', '--no-renames', '-z', from, to], { cwd, env: TRUSTED_READ_ENV });
  return res.status === 0 ? res.stdout.split('\0').filter((f) => f.length > 0 && !f.startsWith(HOUSEKEEPING_DIR)) : null;
}

/**
 * Why a recorded housekeeping commit carries more than an inventory change
 * (null = it changes only inventory/). Its parents prove where it sits, not
 * what it holds, so its content is checked too: a one-parent commit against
 * its parent; a merge against the tree `git merge-tree --write-tree` builds
 * from its parents (on a conflict the first stdout line is still that tree,
 * with conflict markers; the engine then takes the base's inventory/). A
 * custom merge driver (`merge.<name>.driver` in any git config) can rewrite
 * both the engine's merge and merge-tree's, so a merge made while one is
 * configured is refused. Any git failure is a reason (fail closed).
 */
function housekeepingContentProblem(exec: Exec, cwd: string, c: CommitParents, drivers: () => string | null): string | null {
  const short = (s: string) => s.slice(0, 12);
  let expected = c.parents[0];
  if (c.parents.length === 2) {
    const configured = drivers();
    if (configured === null) return 'could not read the git config for custom merge drivers';
    if (configured) return `a custom merge driver is configured (${configured.split(/\r?\n/).map((l) => l.split(/\s/)[0]).join(', ')}), which can rewrite the merge's content`;
    const tree = exec('git', ['merge-tree', '--write-tree', c.parents[0], c.parents[1]], { cwd, env: TRUSTED_READ_ENV });
    const first = tree.stdout.split(/\r?\n/)[0].trim();
    if ((tree.status !== 0 && tree.status !== 1) || !/^[0-9a-f]{40}$/.test(first)) {
      return `git merge-tree could not rebuild the merge of ${short(c.parents[0])} and ${short(c.parents[1])}`;
    }
    expected = first;
  }
  const outside = outsideInventory(exec, cwd, expected, c.sha);
  if (outside === null) return `could not diff it against ${c.parents.length === 2 ? 'the rebuilt merge' : `its parent ${short(expected)}`}`;
  return outside.length > 0 ? `it changes files outside ${HOUSEKEEPING_DIR}: ${outside.join(', ')}` : null;
}

/**
 * The decideMerge inputs about the commits after the reviewed sha:
 * `git rev-list --first-parent --parents <reviewed>..<head>` (null when the
 * reviewed sha is not an ancestor of the head or the list fails), the
 * second parents of the recorded housekeeping merges that are GitHub's
 * current base sha or its ancestors, and the content check of every
 * recorded one- or two-parent housekeeping commit (housekeepingContentProblem).
 * `baseSha` must be in the object store (fetched and checked against
 * GitHub); an unknown one puts nothing in baseHistory (fail closed).
 */
export function readCommitsSinceReview(
  exec: Exec, cwd: string, reviewed: string | undefined, head: string, baseSha: string, housekeeping: readonly string[],
): { commitsSinceReview: CommitParents[] | null; baseHistory: Set<string>; housekeepingContent: Map<string, string | null> } {
  const baseHistory = new Set<string>();
  const housekeepingContent = new Map<string, string | null>();
  if (!reviewed || reviewed === head) return { commitsSinceReview: [], baseHistory, housekeepingContent };
  const ancestor = exec('git', ['merge-base', '--is-ancestor', reviewed, head], { cwd }).status === 0;
  const list = ancestor ? exec('git', ['rev-list', '--first-parent', '--parents', `${reviewed}..${head}`], { cwd }) : null;
  const commitsSinceReview = list && list.status === 0 ? parseCommitParents(list.stdout) : null;
  let drivers: string | null | undefined;
  const readDrivers = () => {
    if (drivers === undefined) {
      const res = exec('git', ['config', '--get-regexp', '^merge\\..*\\.driver$'], { cwd, env: TRUSTED_READ_ENV });
      // Exit 1: no such key.
      drivers = res.status === 0 ? res.stdout.trim() : res.status === 1 ? '' : null;
    }
    return drivers;
  };
  for (const c of commitsSinceReview ?? []) {
    if (!housekeeping.includes(c.sha)) continue;
    const second = c.parents[1];
    if (c.parents.length === 2 && exec('git', ['merge-base', '--is-ancestor', second, baseSha], { cwd }).status === 0) {
      baseHistory.add(second);
    }
    if (c.parents.length === 1 || c.parents.length === 2) housekeepingContent.set(c.sha, housekeepingContentProblem(exec, cwd, c, readDrivers));
  }
  return { commitsSinceReview, baseHistory, housekeepingContent };
}

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
   * `git rev-list --first-parent --parents <reviewed>..<head>` (newest first,
   * parseCommitParents); null when the reviewed sha is not an ancestor of the
   * head (or the range could not be listed).
   */
  commitsSinceReview: CommitParents[] | null;
  /**
   * Second parents of the housekeeping merges in commitsSinceReview that are
   * GitHub's CURRENT base sha or its ancestors (`git merge-base --is-ancestor`).
   */
  baseHistory: ReadonlySet<string>;
  /**
   * Content check of each recorded one- or two-parent housekeeping commit in
   * commitsSinceReview: null when it changes only inventory/, else why not.
   * A housekeeping commit missing from the map is refused (fail closed).
   */
  housekeepingContent: ReadonlyMap<string, string | null>;
  /** listChangedFiles(base sha, head sha); null when it could not be read (refused unless humanOverride). */
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

/**
 * Why the commits after the reviewed sha need a new verdict (empty = they are
 * all ship housekeeping). Accepted only: a first-parent chain from the head
 * back to the reviewed sha made of engine-recorded commits, where each
 * recorded merge has exactly two parents and brings in a commit in GitHub's
 * current base history (so a merge of a forged `origin/<base>` is not
 * housekeeping, even when the engine recorded it), and every recorded commit
 * changes nothing outside inventory/ beyond what its parents give (so a hook,
 * a merge driver or a file staged by another lane cannot ride along).
 */
function unreviewedReasons(
  commits: readonly CommitParents[], reviewed: string, head: string, housekeeping: readonly string[],
  baseHistory: ReadonlySet<string>, content: ReadonlyMap<string, string | null>,
): string[] {
  const reasons: string[] = [];
  const short = (s: string) => s.slice(0, 12);
  const chained = commits.length > 0 && commits[0].sha === head
    && commits.every((c, i) => c.parents[0] === (i + 1 < commits.length ? commits[i + 1].sha : reviewed));
  if (!chained) reasons.push(`the head's first-parent chain does not lead back to the reviewed sha ${short(reviewed)} (re-review needed)`);
  const unrecorded = commits.filter((c) => !housekeeping.includes(c.sha)).map((c) => short(c.sha));
  if (unrecorded.length > 0) reasons.push(`commits after the reviewed sha are not ship housekeeping (re-review needed): ${unrecorded.join(', ')}`);
  for (const c of commits) {
    if (!housekeeping.includes(c.sha)) continue;
    if (c.parents.length > 2 || c.parents.length === 0) {
      reasons.push(`housekeeping commit ${short(c.sha)} has ${c.parents.length} parents; not a ship merge (re-review needed)`);
    } else if (c.parents.length === 2 && !baseHistory.has(c.parents[1])) {
      reasons.push(`housekeeping merge ${short(c.sha)} brings in ${short(c.parents[1])}, which is not in GitHub's base history (re-review needed)`);
    }
    if (c.parents.length === 1 || c.parents.length === 2) {
      const problem = content.has(c.sha) ? content.get(c.sha) : 'its content was not checked';
      if (problem) reasons.push(`housekeeping commit ${short(c.sha)} is not inventory-only: ${problem} (re-review needed)`);
    }
  }
  return reasons;
}

export function decideMerge({ state, pr, gate, commitsSinceReview, baseHistory, housekeepingContent, changedFiles, humanOverride = false, extraProtected = [] }: MergeInput): MergeDecision {
  const reasons: string[] = [];
  if (!humanOverride) {
    if (changedFiles === null) {
      reasons.push('could not list the PR\'s changed files (git diff base...head); the protected-path check fails closed');
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
      reasons.push(...unreviewedReasons(commitsSinceReview, verdict.sha, pr.headRefOid, state.housekeepingCommits, baseHistory, housekeepingContent));
    }
  }
  return { ok: reasons.length === 0, reasons, command: mergeCommand(pr.number, pr.headRefOid) };
}
