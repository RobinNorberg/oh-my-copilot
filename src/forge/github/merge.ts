/**
 * The GitHub merge command (factory forges design §2, PR 2), moved from
 * src/ship/merge.ts mergeCommand. A human runs it; `omg ship merge` alone may
 * run it, the factory guard refuses `gh pr merge` outright.
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
