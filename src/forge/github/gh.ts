/**
 * The engine-grade gh calls of the GitHub adapter (factory forges design §2,
 * PR 2): a failed command or unparsable JSON throws GhCommandError with the
 * message the factory engine's own `run(..., 'gh')` / `ghJson` produced, so
 * the engine rethrows it as its step error unchanged.
 */

import type { Exec } from '../../ship/exec.js';

/** A gh command of an engine step failed, or printed no JSON. */
export class GhCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhCommandError';
  }
}

/** gh's `--repo` value for a forge repository: `HOST/OWNER/NAME`. */
export const ghRepoArg = (repo: { host: string; owner: string; name: string }): string => `${repo.host}/${repo.owner}/${repo.name}`;

/** `gh <args>` in `cwd`; stdout, or GhCommandError naming the command and its first stderr line. */
export function ghRun(exec: Exec, args: string[], cwd: string): string {
  const res = exec('gh', args, { cwd });
  if (res.status !== 0) throw new GhCommandError(`gh ${args.join(' ')} failed (exit ${res.status}): ${res.stderr.trim().split('\n')[0]}`);
  return res.stdout;
}

/** ghRun, parsed as JSON (unvalidated: the caller checks the fields). */
export function ghJson<T>(exec: Exec, args: string[], cwd: string): T {
  const out = ghRun(exec, args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhCommandError(`gh ${args.join(' ')} returned no JSON`);
  }
}
