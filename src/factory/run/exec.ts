/**
 * The `omg factory run` command guard: ship's allowlist (src/ship/exec.ts)
 * extended with the exact shapes the factory engine builds (design §4).
 *
 * - Pushes: only `git push origin <sha40>:refs/heads/factory/<name>`, plain
 *   (no `+`, no flags), never a protected branch. Ship's `HEAD:refs/heads/<b>`
 *   push shape is refused here: the factory pushes nothing else.
 * - GitHub: `gh issue view|comment`, `gh pr create --draft|comment|list|ready`
 *   (one `pr list` is the blocked-by gate's merged lookup on `factory/issue-<n>`)
 *   and `gh repo view --json url` (ci-heal runs) in fixed shapes, plus ship's
 *   `gh pr view|checks` and `gh run list|view|rerun`.
 *   Never `gh api`, `gh -R`, or a merge (merge is always human).
 * - Azure DevOps: `az devops invoke` on the routes.ts allowlist only, as the
 *   resolved az entry, for the run's forge repo (src/forge/ado/guard.ts).
 * - The engine-owned prepare checkout: `git worktree add -B <its branch>
 *   <abs path> <sha40>` and `git merge --abort` (ship's prepare shapes run in it).
 * - Read-only git for the lane tamper check (review-guard.ts) and the review
 *   prompt's diff (no external diff driver, no textconv) and its standards
 *   files (`ls-tree` of docs/standards/ at the base commit).
 * - Every engine git command runs hardened (hardenedGitExec): no hooks and no
 *   fsmonitor, so a hook or fsmonitor a lane planted cannot run in the engine
 *   even if the tamper check missed it.
 */

import { existsSync, readdirSync } from 'fs';
import { isAbsolute } from 'path';
import { checkAdoCommand, isAdoCommand, runGuardedAdo, type AdoGuardContext } from '../../forge/ado/guard.js';
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
/** The local branch of the engine-owned prepare checkout (getBranchName(FACTORY_CHECKOUT_TEAM, `issue-<n>` or `heal-<sig8>`)). */
const CHECKOUT_BRANCH = /^omc-team\/factory-run\/(?:issue-\d+|heal-[0-9a-f]{8})$/;

const isBranch = (s: string | undefined): s is string => typeof s === 'string' && BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
const isFile = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const isTitle = (s: string | undefined): s is string => typeof s === 'string' && s.length > 0 && s.length <= 256 && !s.startsWith('-') && !/[\r\n\0]/.test(s);
const same = (args: string[], shape: string[]) => args.length === shape.length && shape.every((v, i) => args[i] === v);
/** A progress label of the factory family (factory forges design §7): `factory:<stage>`. */
const FACTORY_LABEL = /^factory:[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Progress sync's label write: `issue edit <n> [--add-label <factory:*>] (--remove-label <factory:*>)*`,
 * at least one flag, one add at most, factory labels only and each once.
 */
function isProgressLabelEdit(r: string[]): boolean {
  if (r.length < 3 || r.length % 2 === 0 || !NUMBER.test(r[0])) return false;
  const labels: string[] = [];
  let adds = 0;
  for (let i = 1; i < r.length; i += 2) {
    if (r[i] === '--add-label') {
      if (i !== 1 || ++adds > 1) return false;
    } else if (r[i] !== '--remove-label') {
      return false;
    }
    if (!FACTORY_LABEL.test(r[i + 1]) || labels.includes(r[i + 1])) return false;
    labels.push(r[i + 1]);
  }
  return true;
}

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
    case 'config':
      // The tamper check hashes the file core.excludesFile names; ship decides the rest.
      return same(r, ['--get', 'core.excludesFile']) ? true : null;
    case 'for-each-ref':
      return same(r, [FOR_EACH_REF_FORMAT]);
    case 'status':
      return same(r, ['--porcelain=v1', '-z', '--untracked-files=all']) ? true : null;
    case 'diff':
      return r.length === 3 && r[0] === '--no-ext-diff' && r[1] === '--no-textconv' && /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/.test(r[2]) ? true : null;
    case 'ls-tree':
      // Two-axis review: the standards files on the base commit.
      return r.length === 6 && same(r.slice(0, 3), ['-r', '-z', '--name-only']) && /^[0-9a-f]{40}$/.test(r[3]) && same(r.slice(4), ['--', 'docs/standards/']) ? true : null;
    case 'rev-list':
      // Publish check: the commits of the prepared head beyond the reviewed head and GitHub's base.
      return r.length === 3 && /^[0-9a-f]{40}$/.test(r[0]) && /^\^[0-9a-f]{40}$/.test(r[1]) && /^\^[0-9a-f]{40}$/.test(r[2]) ? true : null;
    case 'worktree':
      // The engine-owned prepare checkout only (prepare.ts): its own branch, at an exact commit. Removal goes through removeWorkerWorktree.
      return r.length === 5 && r[0] === 'add' && r[1] === '-B' && CHECKOUT_BRANCH.test(r[2]) && isAbsolute(r[3]) && isFile(r[3]) && /^[0-9a-f]{40}$/.test(r[4]);
    case 'merge':
      // Abort prepare's conflicted base merge in the engine checkout before it is discarded; ship decides every other merge shape.
      return same(r, ['--abort']) ? true : null;
    default:
      return null;
  }
}

function factoryGh(a: string[]): boolean | null {
  const [group, sub, ...r] = a;
  if (group === 'issue') {
    if (sub === 'view') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--json' && JSON_FIELDS.test(r[2]);
    if (sub === 'comment') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
    if (sub === 'edit') return isProgressLabelEdit(r);
    return false;
  }
  if (group === 'pr') {
    if (sub === 'create') {
      return r.length === 9 && r[0] === '--draft' && r[1] === '--base' && isBranch(r[2]) && r[3] === '--head' && isFactoryBranch(r[4], [])
        && r[5] === '--title' && isTitle(r[6]) && r[7] === '--body-file' && isFile(r[8]);
    }
    if (sub === 'comment') return r.length === 3 && NUMBER.test(r[0]) && r[1] === '--body-file' && isFile(r[2]);
    if (sub === 'list') {
      if (r.length === 4) return r[0] === '--head' && isFactoryBranch(r[1], []) && r[2] === '--json' && JSON_FIELDS.test(r[3]);
      // The blocked-by gate: a dependency's factory PR merged into the base (score.ts isSatisfied, findMergedPrForBranch).
      return r.length === 8 && r[0] === '--head' && /^factory\/issue-\d+$/.test(r[1]) && r[2] === '--base' && isBranch(r[3])
        && same(r.slice(4), ['--state', 'merged', '--json', 'number']);
    }
    if (sub === 'ready') return r.length === 1 && NUMBER.test(r[0]);
    // Merge is always a human step: ship's `gh pr merge` shape is refused here.
    if (sub === 'merge') return false;
    return null;
  }
  // A ci-heal run has no issue url: GitHub's url of the checkout's repository (the remote check compares origin with it).
  if (group === 'repo') return sub === 'view' && same(r, ['--json', 'url']);
  return null;
}

const adoRefusal = (cmd: string, args: string[]) => (reason: string) =>
  new FactorySafetyError(`omg factory run refuses \`${cmd.replace(/\\/g, '/').split('/').pop()} ${args.join(' ')}\`: ${reason}`);

/**
 * Throws FactorySafetyError unless the command is a factory shape or a
 * non-push, non-merge ship shape. `extraProtected` adds the run's base.
 * `az` and python go to the Azure DevOps guard (src/forge/ado/guard.ts),
 * which refuses them unless `ado` names the run's forge and az entry.
 */
export function assertFactoryCommand(cmd: string, args: string[], extraProtected: readonly string[] = [], env?: Readonly<Record<string, string>>, ado?: AdoGuardContext): void {
  if (isAdoCommand(cmd)) {
    checkAdoCommand(cmd, args, env, ado, 'factory', adoRefusal(cmd, args));
    return;
  }
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

/**
 * Wrap an Exec so every call passes assertFactoryCommand first; `extraProtected` is read per call.
 * An `az devops invoke` write runs with the guard's own copy of its validated --in-file body.
 */
export function factoryGuardExec(exec: Exec, extraProtected: () => readonly string[] = () => [], ado: () => AdoGuardContext | undefined = () => undefined): Exec {
  return (cmd, args, opts) => {
    if (isAdoCommand(cmd)) return runGuardedAdo(exec, cmd, args, opts, ado(), 'factory', adoRefusal(cmd, args));
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
