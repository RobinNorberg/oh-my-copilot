/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list` in
 *   fixed shapes, plus ship's `gh pr view|checks`. Never `gh api`, `gh -R`,
 *   or a merge (merge is always human).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */

import { existsSync, readdirSync } from 'fs';
import { assertSafeCommand, PROTECTED_BRANCHES, ShipSafetyError, TRUSTED_READ_ENV, type Exec } from '../../ship/exec.js';

/** Every branch the factory pushes starts with this prefix (fixed, not configurable). */
export const FACTORY_BRANCH_PREFIX = 'factory/';

export class FactorySafetyError extends ShipSafetyError {
  constructor(message: string) {
    super(message);
    this.name = 'FactorySafetyError';
  }
}

const NUMBER = /^\d+$/;
const JSON_FIELDS = /^[A-Za-z]+(?:,[A-Za-z]+)*$/;
const BRANCH = /^[\w.][\w./-]*$/;
const REPO_PATH = /^[\w.][\w.-]*(?:\/[\w.][\w.-]*)*$/;
export const FOR_EACH_REF_FORMAT = '--format=%(refname) %(objectname)';

const isBranch = (s: string | undefined): s is string => typeof s === 'string' && BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
const isFile = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const isTitle = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const same = (args: string[], shape: string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);

function isFactoryBranch(name: string | undefined, protectedBranches: readonly string[]): name is string {
  return isBranch(name) && name.startsWith(FACTORY_BRANCH_PREFIX) && name.length > FACTORY_BRANCH_PREFIX.length
    && !protectedBranches.some((b) => b.toLowerCase() === name.toLowerCase());
}

/** Factory-only git shapes; null = not a factory shape (ship's allowlist decides), false = refused outright. */
function factoryGit(a: string[], protectedBranches: readonly string[]): boolean | null {
  const [sub, ...r] = a;
  switch (sub) {
    case 'push': {
      const m = r.length === 2 && r[0] === 'origin' ? /^([0-9a-f]{40}):refs\/heads\/(.+)$/.exec(r[1]) : null;
      return Boolean(m) && isFactoryBranch(m![2], protectedBranches);
    }
    case 'ls-remote': {
      const m = r.length === 2 && r[0] === 'origin' ? /^refs\/heads\/(.+)$/.exec(r[1]) : null;
      return Boolean(m) && isFactoryBranch(m![1], protectedBranches);
    }
    case 'rev-parse':
      if (same(r, ['--git-common-dir']) || same(r, ['--symbolic-full-name', 'HEAD'])) return true;
      if (r.length === 2 && r[0] === '--verify') {
        const m = /^([0-9a-f]{40}):(.+)$/.exec(r[1]);
        if (m) return REPO_PATH.test(m[2]) && !m[2].split('/').includes('..');
      }
      return null;
    case 'for-each-ref':
      return same(r, [FOR_EACH_REF_FORMAT]);
    case 'status':
      return same(r, ['--porcelain=v1', '-z', '--untracked-files=all']) ? true : null;
    case 'diff':
      return r.length === 3 && r[0] === '--no-ext-diff' && r[1] === '--no-textconv' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]) ? true : null;
    default:
      return null;
  }
}

function factoryGh(a: string[]): boolean | null {
  const [group, sub, ...r] = a;
  if (group === 'issue') {
    if (sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
    if (sub === 'comment') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
    return false;
  }
  if (group === 'pr') {
    if (sub === 'create') {
      return r.length === 9 && r[0] === '--draft' && r[1] === '--base' && isBranch(r[2]) && r[3] === '--head' && isFactoryBranch(r[4], [])
        && r[5] === '--title' && isTitle(r[6]) && r[7] === '--body-file' && isFile(r[8]);
    }
    if (sub === 'comment') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
    if (sub === 'list') return r.length === 4 && r[0] === '--head' && isFactoryBranch(r[1], []) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
    // Merge is always a human step: ship's `gh pr merge` shape is refused here.
    if (sub === 'merge') return false;
    return null;
  }
  return null;
}

/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 */
export function assertFactoryCommand(cmd: string, args: string[], extraProtected: readonly string[] = [], env?: Readonly<Record<string, string>>): void {
  const file = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const base = file.replace(/\.exe$/, '');
  const protectedBranches = [...PROTECTED_BRANCHES, ...extraProtected];
  const strings = args.every((x) => typeof x === 'string');
  const verdict = !strings ? false : base === 'git' ? factoryGit(args, protectedBranches) : base === 'gh' ? factoryGh(args) : null;
  if (verdict === false) throw new FactorySafetyError(`omg factory run refuses \`${file} ${args.join(' ')}\`: not one of the command shapes the factory engine runs`);
  if (verdict === true) {
    // Factory shapes take no environment except ship's trusted-read env on git.
    const trusted = JSON.stringify(Object.entries(TRUSTED_READ_ENV));
    if (env !== undefined && !(base === 'git' && JSON.stringify(Object.entries(env)) === trusted)) {
      throw new FactorySafetyError(`omg factory run refuses \`${file} ${args.join(' ')}\` with environment ${JSON.stringify(env)}: only ${JSON.stringify(TRUSTED_READ_ENV)} on git is allowed`);
    }
    return;
  }
  try {
    assertSafeCommand(cmd, args, extraProtected, env);
  } catch (error) {
    throw new FactorySafetyError(error instanceof Error ? error.message.replace(/^omg ship refuses/, 'omg factory run refuses') : String(error));
  }
}

/** Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call. */
export function factoryGuardExec(exec: Exec, extraProtected: () => readonly string[] = () => []): Exec {
  return (cmd, args, opts) => {
    assertFactoryCommand(cmd, args, extraProtected(), opts?.env);
    return exec(cmd, args, opts);
  };
}

/** Prepended to every hardened git command, after the guard checked the plain shape. */
export function gitHardeningArgs(hooksDir: string): string[] {
  return ['-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external='];
}

/**
 * Run git with `core.hooksPath` set to an engine-owned empty directory and
 * `core.fsmonitor=false`, so no hook (pre-push, post-checkout,
 * reference-transaction) and no fsmonitor command runs in the engine.
 * Refuses when the hooks directory is missing or not empty. Other commands
 * pass through unchanged. Wrap it INSIDE factoryGuardExec, so the guard sees
 * the plain shape.
 *
 * The system and global config stay. GIT_CONFIG_NOSYSTEM is not set: Git for
 * Windows keeps `credential.helper` and `core.autocrlf` in the system config,
 * so pushes would lose their credentials and every CRLF checkout would read
 * as modified, and `credential.helper` cannot be blanked either (pushes need
 * the credential manager). The system config needs admin rights to write;
 * the global one and every file a config includes are hashed into the lane
 * snapshot instead (review-guard.ts), so a lane that plants a helper,
 * sshCommand, pushInsteadOf or clean filter there parks the run.
 */
export function hardenedGitExec(exec: Exec, hooksDir: string): Exec {
  return (cmd, args, opts) => {
    const base = cmd.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '');
    if (base !== 'git') return exec(cmd, args, opts);
    if (!existsSync(hooksDir) || readdirSync(hooksDir).length > 0) {
      throw new FactorySafetyError(`omg factory run refuses git: the engine's empty hooks directory ${hooksDir} is missing or not empty`);
    }
    return exec(cmd, [...gitHardeningArgs(hooksDir), ...args], opts);
  };
}
