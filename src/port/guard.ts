/**
 * The `omg port drive` command guard. Upstream text reaches the reconcile
 * lane, the lane shares the common git dir, so every host git command the
 * engine runs is (1) one of the shapes the engine builds and (2) hardened:
 *
 * - `core.hooksPath` = an engine-owned empty directory, `core.fsmonitor=false`
 *   (factory hardenedGitExec);
 * - `--no-pager`, and `--no-ext-diff --no-textconv` on diff/show/log;
 * - every filter driver the config defines is blanked (`clean`, `smudge`,
 *   `process` empty, `required=false`), so a checkout, add or status never
 *   runs a filter command (git-lfs included).
 *
 * Pushes are only `git push <remote> HEAD:refs/heads/port/upstream-<sha9>`,
 * plain; no reset, stash, clean, worktree, rebase or merge shape exists here.
 * The tamper check (review-guard.ts snapshotRepo / compareSnapshots) is the
 * other half: it parks the run when the lane changed config, hooks or refs.
 */

import { hardenedGitExec } from '../factory/run/exec.js';
import { ShipSafetyError, type Exec } from '../ship/exec.js';

export const PORT_BRANCH = /^port\/upstream-[0-9a-f]{9}$/;
const REMOTE = /^[\w][\w.-]*$/;

export class PortSafetyError extends ShipSafetyError {
  constructor(message: string) {
    super(message);
    this.name = 'PortSafetyError';
  }
}

/** Subcommands the engine runs, and the snapshot's read-only ones. */
const GIT_ALLOWED = new Set([
  'add', 'cat-file', 'checkout', 'commit', 'diff', 'for-each-ref', 'grep', 'ls-files', 'ls-tree',
  'merge-base', 'push', 'rev-parse', 'rm', 'show', 'status', 'switch', 'write-tree',
]);
const NO_DIFF_DRIVERS = new Set(['diff', 'show', 'log']);

function gitShapeOk(args: string[]): boolean {
  const [sub, ...r] = args;
  if (!sub || !GIT_ALLOWED.has(sub)) return false;
  if (r.some((a) => a === '--force' || a.startsWith('--force-') || a === '--amend' || a === '--exec' || a.startsWith('--upload-pack') || a.startsWith('--receive-pack'))) return false;
  switch (sub) {
    case 'push':
      return r.length === 2 && REMOTE.test(r[0]) && /^HEAD:refs\/heads\/(.+)$/.test(r[1]) && PORT_BRANCH.test(r[1].slice('HEAD:refs/heads/'.length));
    case 'switch':
      return r.length === 3 && r[0] === '-q' && r[1] === '-c' && PORT_BRANCH.test(r[2]);
    // Path checkout only: never a branch switch or a detach.
    case 'checkout':
      return r.includes('--') && !r.slice(0, r.indexOf('--')).some((a) => a.startsWith('-'));
    case 'rm':
      return r.includes('--');
    default:
      return true;
  }
}

function ghShapeOk(args: string[]): boolean {
  return args[0] === 'pr' && args[1] === 'create' && args[2] === '--draft' && args.length === 11
    && args[3] === '--base' && args[5] === '--head' && PORT_BRANCH.test(args[6]) && args[7] === '--title' && args[9] === '--body-file';
}

/** `-c` pairs that blank every filter driver the effective config defines. */
export function filterNeutralizers(exec: Exec, cwd: string | undefined): string[] {
  const res = exec('git', ['config', '--name-only', '--get-regexp', '^filter\\.'], { cwd });
  const names = new Set<string>();
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return [...names].sort().flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

/**
 * Wrap an Exec: refuse shapes the port engine never builds, then run git
 * hardened. `node` (repo scripts) passes through; `gh` is only the draft PR.
 */
export function portGuardExec(exec: Exec, hooksDir: string): Exec {
  const hardened = hardenedGitExec(exec, hooksDir);
  return (cmd, args, opts) => {
    const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
    const base = file.replace(/\.exe$/, '');
    if (!args.every((a) => typeof a === 'string')) throw new PortSafetyError(`omg port drive refuses \`${file}\` with non-string arguments`);
    if (base === 'gh') {
      if (!ghShapeOk(args)) throw new PortSafetyError(`omg port drive refuses \`gh ${args.join(' ')}\`: only the draft PR to a port/upstream-<sha> branch`);
      return exec(cmd, args, opts);
    }
    if (base !== 'git') return exec(cmd, args, opts);
    if (!gitShapeOk(args)) throw new PortSafetyError(`omg port drive refuses \`git ${args.join(' ')}\`: not one of the command shapes the port engine runs`);
    const [sub, ...rest] = args;
    const subArgs = NO_DIFF_DRIVERS.has(sub) ? [sub, '--no-ext-diff', '--no-textconv', ...rest] : args;
    return hardened(cmd, ['--no-pager', ...filterNeutralizers(exec, opts?.cwd), ...subArgs], opts);
  };
}

/** Env for repo scripts whose own git must not run hooks or fsmonitor (the drift script, the inventory generator). */
export function hardenedScriptEnv(hooksDir: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooksDir,
    GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
  };
}
