/**
 * The GitHub merge command (factory forges design §2, PR 2), moved from
 * src/ship/merge.ts mergeCommand. A human runs it; `omg ship merge` alone may
 * run it, the factory guard refuses `gh pr merge` outright.
 *
 * The factory's opt-in auto-merge (src/factory/run/auto-merge.ts) is the one
 * engine merge: the REST merge pinned to the head sha (GitHub answers 409 when
 * the head moved), admitted by the factory guard only inside the engine's
 * auto-merge step for exactly that repository, PR and sha.
 */

import type { ForgeMerge } from '../types.js';

/** `gh pr merge <pr> --admin --merge --match-head-commit <sha>`: merges exactly the head the gates checked. */
export function ghMergeCommand(pr: number, headSha: string): string[] {
  return ['gh', 'pr', 'merge', String(pr), '--admin', '--merge', '--match-head-commit', headSha];
}

/** GitHub has no branch-policy inputs beyond the gates and ship's merge rule. */
export function githubMerge(): ForgeMerge {
  return { humanMergeCommand: ghMergeCommand, blockingPolicies: () => [] };
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The step the engine is merging in: the run's repository (ghRepoArg `HOST/OWNER/NAME`), PR and head. */
export interface GithubAutoMergeStep {
  repo: string;
  pr: number;
  head: string;
}

/**
 * The gh argv of the engine's auto-merge: `PUT repos/O/N/pulls/<pr>/merge`
 * with `sha` = the head (no admin bypass: branch protection still applies)
 * and a merge commit. Undefined for anything not exactly well-formed.
 */
export function githubAutoMergeArgs(step: GithubAutoMergeStep): string[] | undefined {
  const parts = step.repo.split('/');
  if (parts.length !== 3 || !HOST.test(parts[0]) || !NAME.test(parts[1]) || !NAME.test(parts[2]) || /^\.+$/.test(parts[1]) || /^\.+$/.test(parts[2])) return undefined;
  if (!Number.isSafeInteger(step.pr) || step.pr < 1 || !/^[0-9a-f]{40}$/.test(step.head)) return undefined;
  return ['api', '--hostname', parts[0], '--method', 'PUT', `repos/${parts[1]}/${parts[2]}/pulls/${step.pr}/merge`, '-f', `sha=${step.head}`, '-f', 'merge_method=merge'];
}

/**
 * The gh argv that reads one commit of the run's repository (GET
 * `repos/O/N/commits/<sha>`): after its auto-merge the engine checks the
 * merge commit's first parent is the base the gates checked.
 */
export function githubCommitReadArgs(repo: string, sha: string): string[] | undefined {
  const parts = repo.split('/');
  if (parts.length !== 3 || !HOST.test(parts[0]) || !NAME.test(parts[1]) || !NAME.test(parts[2]) || /^\.+$/.test(parts[1]) || /^\.+$/.test(parts[2])) return undefined;
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
  return ['api', '--hostname', parts[0], `repos/${parts[1]}/${parts[2]}/commits/${sha}`];
}

/** The factory guard's test for that read: exactly githubCommitReadArgs of the run's repository and some full sha. */
export function isGithubCommitReadArgs(args: readonly string[], repo: string | undefined): boolean {
  const sha = args.length === 4 ? /\/commits\/([0-9a-f]{40})$/.exec(args[3])?.[1] : undefined;
  const want = repo && sha ? githubCommitReadArgs(repo, sha) : undefined;
  return want !== undefined && want.every((v, i) => args[i] === v);
}

/** The factory guard's test: exactly githubAutoMergeArgs of the engine's current step; no step = refused. */
export function isGithubAutoMergeArgs(args: readonly string[], step: GithubAutoMergeStep | undefined): boolean {
  const want = step ? githubAutoMergeArgs(step) : undefined;
  return want !== undefined && args.length === want.length && want.every((v, i) => args[i] === v);
}
